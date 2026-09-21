import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { getAddress, isAddress } from 'viem';
import { getSupportedChain } from '../../../common/chains/supported-chains';
import { API_ERROR_CODES } from '../../../common/errors/api-error-codes';
import { PrismaService } from '../../../core/database/prisma.service';
import { getErrorText, sanitizeErrorMessage } from '../../../common/utils/sanitize';
import { SecurityEventService } from '../../security-events/security-event.service';
import {
  isDeferredDestinationPolicyDenial,
  WithdrawalDestinationPolicyService,
} from '../../withdrawal-destination/withdrawal-destination-policy.service';
import { InvoiceSettlementService } from '../invoice-settlement.service';
import { BillingPlanChangeService } from '../billing-plan-change.service';
import { StripeSubscriptionSyncService } from '../stripe/stripe-subscription-sync.service';
import { acquireBillingPeriodAdvisoryLock } from '../billing-period-lock';
import { microsToDecimalUsd } from '../billing.utils';
import {
  EVM_ADDRESS_REGEX,
  INDEXED_ADDRESS_REGEX,
  UINT256_DATA_REGEX,
  USDC_BILLING_CHAIN_IDS,
  USDC_DECIMALS,
  USDC_RECEIPT_PROVIDER,
  USDC_TRANSFER_TOPIC0,
  type UsdcBillingChainId,
} from './usdc.constants';
import type { UsdcReceipt, UsdcReceiptLog, UsdcReceiptProvider } from './usdc-receipt.provider';

type Tx = Prisma.TransactionClient;
type PaymentAttemptRow = Prisma.BillingPaymentAttemptGetPayload<Record<string, never>>;
type InvoiceRow = Prisma.BillingInvoiceGetPayload<Record<string, never>>;
/** Prisma client shape used for destination/allowlist reads (root or TX). */
type DestinationClient = PrismaService | Prisma.TransactionClient;

/**
 * BILL-011: CAS predicates for safe expired/incomplete pending release.
 * Only evidence-free, unreserved pending attempts may be expired for requote;
 * any submitted hash or payment evidence stays pinned for recovery/review.
 */
const RELEASABLE_PENDING_WHERE = {
  status: 'pending' as const,
  walletPaymentReserved: false,
  submittedTxHash: null,
  txHash: null,
  logIndex: null,
  actualBaseUnits: null,
  blockNumber: null,
  blockHash: null,
  payerAddress: null,
};

/** A transaction hash is exactly 32 bytes (64 hex chars) after the 0x prefix. */
const TX_HASH_REGEX = /^0x[0-9a-fA-F]{64}$/;

/** The burn/zero address is never a valid treasury. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** States a claim may transition from while the attempt is still active. */
const ACTIVE_CLAIM_STATES = ['pending', 'confirming'] as const;

/**
 * B2: wallet_server recovery may reopen these `needs_review` reasons when a
 * matching **trusted** server-bound hash is presented for exact receipt
 * settlement. `wallet_payment_userop_unattributed` is intentionally excluded —
 * enclosing UserOp/bundle hash is forensic only and never auto-pays.
 * Manual evidence conflicts, hash conflicts, and quote/identity invalid reasons
 * stay locked.
 */
const RECOVERABLE_WALLET_PAYMENT_REVIEW_REASONS = [
  'wallet_payment_dispatch_unknown',
  'wallet_payment_awaiting_evidence',
  'wallet_payment_user_op_hash_missing',
] as const;

/** Backoff before the worker retries a retryable (pending/rpc_error) claim. */
export const USDC_RETRY_BACKOFF_MS = 60_000;

/** JSON-safe USDC quote (no BigInt, no logs/calldata/RPC/Openfort/secrets). */
export interface UsdcQuoteResult {
  invoiceId: string;
  paymentAttemptId: string;
  chainId: number;
  tokenAddress: string;
  tokenDecimals: number;
  treasuryAddress: string;
  expectedPayerAddress: string;
  amountBaseUnits: string;
  amountUsd: string;
  currency: string;
  quoteExpiresAt: string;
  requiredConfirmations: number;
}

export type UsdcClaimStatus =
  | 'pending' // receipt not found yet — retryable
  | 'rpc_error' // transient RPC error — retryable
  | 'confirming' // valid transfer detected, below the confirmation threshold
  | 'succeeded' // settled (invoice paid by this attempt)
  | 'expired' // quote expired — re-quote to retry
  | 'needs_review' // mismatch/manual review — never auto-settled
  | 'failed'; // reverted receipt — re-quote to retry

/** JSON-safe USDC claim result (no BigInt, no logs/calldata/secrets). */
export interface UsdcClaimResult {
  invoiceId: string;
  paymentAttemptId: string;
  status: UsdcClaimStatus;
  paid: boolean;
  txHash: string | null;
  chainId: number | null;
  confirmations: number | null;
  requiredConfirmations: number | null;
  blockNumber: string | null;
  blockHash: string | null;
  blockTimestamp: string | null;
  reviewReason: string | null;
  retryable: boolean;
}

/** A strictly decoded canonical USDC Transfer log. */
interface DecodedTransfer {
  from: string;
  to: string;
  amount: bigint;
  logIndex: number;
  log: UsdcReceiptLog;
}

/**
 * The evidence identity a claim observed before its RPC work. Every state
 * write after RPC is bound to this identity: the CAS only matches when the
 * attempt's recorded evidence is absent or exactly equal to it, and the final
 * settlement re-verifies it under the row lock. A stale claim can therefore
 * never overwrite a different evidence identity or settle with its own
 * evidence once another claim recorded different evidence.
 */
interface ClaimEvidence {
  txHash: string;
  chainId: bigint;
  tokenAddress: string;
  blockNumber: bigint;
  blockHash: string;
  logIndex: number;
  payerAddress: string;
  actualBaseUnits: bigint;
}

type TransferParseResult =
  | { kind: 'match'; transfer: DecodedTransfer }
  | { kind: 'review'; reason: string; log: UsdcReceiptLog | null };

/**
 * Dashboard-only native USDC invoice payment rail (Phase 3B Phase 2).
 *
 * Quote/claim lifecycle for finalized USD invoices on Ethereum (1), Ethereum
 * Sepolia (11155111), Base (8453) and Base Sepolia (84532). All payment facts
 * are server-derived and snapshotted on the
 * `BillingPaymentAttempt` at quote time: canonical token (from
 * `SUPPORTED_CHAINS`), static per-chain treasury and RPC (from environment
 * config), expected payer (the invoice owner's SOFA/Openfort user wallet),
 * exact amount (invoice `totalMicros` maps 1:1 to USDC base units at 6
 * decimals), quote TTL, and the required-confirmation threshold. The client
 * only ever supplies a verified chain selector (quote) and
 * `{ paymentAttemptId, txHash }` (claim); nothing else is trusted.
 *
 * Settlement requires a successful receipt with exactly one unambiguous
 * canonical USDC `Transfer` log from the expected payer to the configured
 * treasury for the exact expected amount, plus the configured number of
 * confirmations. Underpayment, overpayment, wrong token/recipient/payer,
 * malformed/removed/ambiguous logs, reorgs, duplicate evidence, and
 * Stripe-vs-USDC races all become `needs_review` (or `expired`/`failed` where
 * retryable) — never automatic accumulation, refunds, or overwrites of a paid
 * invoice. The final state transition runs inside one transaction that marks
 * the attempt succeeded and calls the shared first-rail-wins
 * `InvoiceSettlementService`; a lost race records the successful evidence as
 * `duplicate_unallocated` review. No background scanner — user claim/retry is
 * the only driver.
 */
@Injectable()
export class UsdcPaymentService {
  private readonly logger = new Logger(UsdcPaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settlementService: InvoiceSettlementService,
    @Inject(USDC_RECEIPT_PROVIDER) private readonly receiptProvider: UsdcReceiptProvider,
    /**
     * BILL-011: shared withdrawal-destination allowlist/cooldown leaf (same
     * WithdrawalPolicy / WithdrawalAddress rows as wallet withdraw). Optional
     * only for unit tests that omit it; production BillingModule always wires it.
     */
    @Optional() private readonly destinationPolicy?: WithdrawalDestinationPolicyService,
    @Optional() private readonly securityEvents?: SecurityEventService,
    @Optional() private readonly planChanges?: BillingPlanChangeService,
    @Optional() private readonly subscriptionSync?: StripeSubscriptionSyncService,
  ) {}

  /**
   * Public claim entry: runs the evidence-verification pipeline and then
   * writes a sanitized security audit for material outcomes (settled, and any
   * high-risk blocked/review/failed outcome). Audit/notification failures are
   * isolated and never affect the claim result.
   *
   * Client claims never first-write a hash onto a wallet-reserved attempt
   * (B3). Server wallet dispatch uses {@link claimFromWalletServerBinding}.
   */
  async claim(
    userId: string,
    invoiceId: string,
    input: { paymentAttemptId: string; txHash: string },
  ): Promise<UsdcClaimResult> {
    const result = await this.claimImpl(userId, invoiceId, input, { source: 'client' });
    await this.auditClaim(userId, invoiceId, result);
    return result;
  }

  /**
   * Server-only claim after wallet-payment UserOp produced a chain hash.
   * Binds `boundTransactionId` to the reservation and may first-write
   * `submittedTxHash` only when it matches the bound Transaction.
   */
  async claimFromWalletServerBinding(
    userId: string,
    invoiceId: string,
    input: { paymentAttemptId: string; txHash: string; boundTransactionId: string },
  ): Promise<UsdcClaimResult> {
    const result = await this.claimImpl(userId, invoiceId, input, {
      source: 'wallet_server',
      boundTransactionId: input.boundTransactionId,
    });
    await this.auditClaim(userId, invoiceId, result);
    return result;
  }

  /**
   * Phase 2B wallet-pay: full claim-grade quote snapshot + exact remaining due.
   * Reuses private assertSnapshotComplete (canonical token/treasury/provider/…).
   */
  assertWalletPayQuoteExecutable(attempt: PaymentAttemptRow, invoice: InvoiceRow): void {
    this.assertInvoiceEligible(invoice);
    this.assertSnapshotComplete(attempt, invoice);
    const allocated = invoice.allocatedMicros ?? 0n;
    const remaining = invoice.totalMicros - allocated;
    if (remaining <= 0n || attempt.amountMicros !== remaining) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt amount no longer matches invoice remaining due',
      });
    }
    if (attempt.expectedBaseUnits !== attempt.amountMicros) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt quote amount is inconsistent',
      });
    }
  }

  /**
   * Sanitized audit for material USDC transitions. Never includes receipt
   * data, RPC details, calldata, or secrets — only safe identifiers/status.
   */
  private async auditClaim(
    userId: string,
    invoiceId: string,
    result: UsdcClaimResult,
  ): Promise<void> {
    if (!this.securityEvents) return;
    const highRisk = result.status === 'needs_review' || result.status === 'failed';
    if (!highRisk && result.status !== 'succeeded') return;
    try {
      await this.securityEvents.record({
        actorType: 'system',
        eventType: 'billing.usdc.claim',
        userId,
        riskLevel: highRisk ? 'high' : 'low',
        result: result.status === 'succeeded' ? 'allowed' : 'denied',
        reason: result.reviewReason ?? result.status,
        metadata: {
          invoiceId,
          paymentAttemptId: result.paymentAttemptId,
          status: result.status,
        },
      });
    } catch (error) {
      this.logger.error(`USDC claim audit failed: ${sanitizeErrorMessage(getErrorText(error))}`);
    }
  }

  // ── Quote ───────────────────────────────────────────────────────────────────

  /**
   * Creates (or reuses) a pending USDC payment attempt for an eligible
   * finalized USD invoice owned by the user. The per-invoice/per-method active
   * partial index (`pending`/`confirming`) guarantees at most one active USDC
   * attempt per invoice; a compatible active attempt is reused idempotently, an
   * expired pending attempt is released before any chain-conflict check (so an
   * expired attempt on one chain can never permanently block a fresh quote on
   * another chain), and a non-expired different-chain active attempt is a
   * conflict. Confirming attempts are always reused — never released.
   */
  async quote(userId: string, invoiceId: string, chainId?: number): Promise<UsdcQuoteResult> {
    this.assertEnabled();
    const invoice = await this.loadOwnedInvoice(userId, invoiceId);
    this.assertInvoiceEligible(invoice);
    if (this.planChanges && (invoice as { purpose?: string }).purpose === 'plan_charge') {
      await this.planChanges.assertPlanChargePayable(this.prisma, invoice.id);
    }

    const chain = this.resolveChain(chainId);
    const tokenAddress = this.canonicalToken(chain);
    const treasuryAddress = this.treasury(chain);
    const expectedPayerAddress = await this.expectedPayer(userId);
    const requiredConfirmations = this.requiredConfirmations();
    const quoteExpiresAt = this.quoteExpiry();

    // Phase 2B B2: any wallet-payment reservation (any status, incl. needs_review)
    // blocks a replacement quote — never auto-release or rotate while reserved.
    const walletReservedAttempt = await this.prisma.billingPaymentAttempt.findFirst({
      where: {
        invoiceId: invoice.id,
        method: 'usdc',
        walletPaymentReserved: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (walletReservedAttempt) {
      if (walletReservedAttempt.chainId !== BigInt(chain)) {
        throw new ConflictException({
          code: API_ERROR_CODES.USDC_PAYMENT_IN_PROGRESS,
          message: 'An active wallet payment reservation exists for this invoice',
        });
      }
      const freshReserved = await this.revalidateInvoicePayableUnderLock(invoice);
      return this.toQuoteResult(freshReserved, walletReservedAttempt);
    }

    const existing = await this.prisma.billingPaymentAttempt.findFirst({
      where: { invoiceId: invoice.id, method: 'usdc', status: { in: ['pending', 'confirming'] } },
    });
    if (existing) {
      // A confirming attempt is mid-payment (the transfer is on-chain): reuse
      // it on the same chain, but never release it and never let a different
      // chain start alongside it.
      if (existing.status === 'confirming') {
        if (existing.chainId !== BigInt(chain)) {
          throw new ConflictException({
            code: API_ERROR_CODES.USDC_PAYMENT_IN_PROGRESS,
            message: 'An active USDC payment already exists for this invoice on another chain',
          });
        }
        // Confirming transfers already left the chain — still re-check invoice
        // under lock so a voided plan_charge is never surfaced as payable.
        const freshConfirming = await this.revalidateInvoicePayableUnderLock(invoice);
        return this.toQuoteResult(freshConfirming, existing);
      }
      // Release an expired pending attempt (or one with an incomplete quote
      // snapshot) before any chain-conflict check, so an expired attempt on one
      // chain can never permanently block a fresh quote on another chain.
      // Non-expired attempts are never released. The release is a pending-only
      // compare-and-set: a concurrent claim that settled or confirmed the
      // attempt in the meantime is never overwritten.
      const expired = !existing.quoteExpiresAt || existing.quoteExpiresAt.getTime() <= Date.now();
      const incomplete = !this.hasQuoteSnapshot(existing);
      // Phase 2B: never auto-release a wallet-payment reservation (unknown dispatch
      // must retain the binding; rotation requires an explicit new quote path).
      const walletReserved =
        (existing as { walletPaymentReserved?: boolean }).walletPaymentReserved === true;
      if (walletReserved) {
        if (existing.chainId !== BigInt(chain)) {
          throw new ConflictException({
            code: API_ERROR_CODES.USDC_PAYMENT_IN_PROGRESS,
            message: 'An active wallet payment reservation exists for this invoice',
          });
        }
        const freshReserved = await this.revalidateInvoicePayableUnderLock(invoice);
        return this.toQuoteResult(freshReserved, existing);
      }
      if (expired || incomplete) {
        // BILL-011: never expire/release an attempt that already carries a
        // submitted hash or any payment evidence — pin it to needs_review for
        // recovery and refuse a replacement quote (no rail/TTL swap).
        if (this.hasPaymentEvidence(existing)) {
          await this.pinPendingWithEvidenceToReview(existing, expired);
          throw new ConflictException({
            code: API_ERROR_CODES.USDC_PAYMENT_IN_PROGRESS,
            message: 'An active USDC payment already exists for this invoice',
          });
        }
        const released = await this.prisma.billingPaymentAttempt.updateMany({
          where: {
            id: existing.id,
            ...RELEASABLE_PENDING_WHERE,
          },
          data: expired
            ? { status: 'expired', reviewReason: 'quote_expired' }
            : { status: 'needs_review', reviewReason: 'snapshot_incomplete' },
        });
        if (released.count === 0) {
          // A concurrent claim changed the attempt before the release CAS:
          // reuse it only when it is still active AND on the requested chain.
          // A confirming attempt on another chain is a conflict, never a reuse.
          // Evidence-bearing pending that raced in is pinned, never released.
          const current = await this.prisma.billingPaymentAttempt.findUnique({
            where: { id: existing.id },
          });
          if (current && this.hasPaymentEvidence(current) && current.status === 'pending') {
            await this.pinPendingWithEvidenceToReview(current, expired);
            throw new ConflictException({
              code: API_ERROR_CODES.USDC_PAYMENT_IN_PROGRESS,
              message: 'An active USDC payment already exists for this invoice',
            });
          }
          if (current && (current.status === 'pending' || current.status === 'confirming')) {
            if (current.chainId !== BigInt(chain)) {
              throw new ConflictException({
                code: API_ERROR_CODES.USDC_PAYMENT_IN_PROGRESS,
                message: 'An active USDC payment already exists for this invoice on another chain',
              });
            }
            const freshReuse = await this.revalidateInvoicePayableUnderLock(invoice);
            return this.toQuoteResult(freshReuse, current);
          }
        }
      } else if (existing.chainId !== BigInt(chain)) {
        throw new ConflictException({
          code: API_ERROR_CODES.USDC_PAYMENT_IN_PROGRESS,
          message: 'An active USDC payment already exists for this invoice on another chain',
        });
      } else {
        const freshPending = await this.revalidateInvoicePayableUnderLock(invoice);
        return this.toQuoteResult(freshPending, existing);
      }
    }

    // BILL-011: before creating a new quote (and starting TTL), if the expected
    // payer's withdrawal allowlist is enabled, the treasury must already be
    // allowlisted and past availableAt. Fail closed with a stable code + time
    // field — no payment attempt, no TTL consumption.
    await this.assertQuoteTreasuryDestinationReady(userId, treasuryAddress, chain);

    try {
      // Create the attempt under the period + invoice row lock so a concurrent
      // upgrade cancel (void) cannot slip a new pending attempt onto a voided
      // plan_charge. remainingDue is computed from the locked fresh invoice.
      // BILL-011: destination allowlist is re-checked under the destination
      // advisory lock inside createUsdcAttemptUnderLock before insert.
      const { invoice: freshInvoice, attempt } = await this.createUsdcAttemptUnderLock({
        userId,
        invoice,
        chain,
        tokenAddress,
        treasuryAddress,
        expectedPayerAddress,
        requiredConfirmations,
        quoteExpiresAt,
      });
      return this.toQuoteResult(freshInvoice, attempt);
    } catch (err) {
      if (isDeferredDestinationPolicyDenial(err)) {
        await this.destinationPolicy?.recordDeferredDenial(err);
        throw await this.enrichDestinationDenialHttp(
          err.httpException,
          userId,
          treasuryAddress,
        );
      }
      if (!isUniqueConstraintError(err)) throw err;
      // A concurrent quote won the insert race. Reuse its active attempt only
      // when it is on the requested chain: a confirming winner is mid-payment
      // and is reused regardless of quote expiry (confirming attempts are never
      // released), while a pending winner is reusable only while its quote is
      // still valid. A winner on another chain is a conflict, never a reuse.
      const winner = await this.prisma.billingPaymentAttempt.findFirst({
        where: { invoiceId: invoice.id, method: 'usdc', status: { in: ['pending', 'confirming'] } },
      });
      if (winner && winner.chainId === BigInt(chain)) {
        const winnerActive =
          winner.status === 'confirming' ||
          (winner.quoteExpiresAt !== null && winner.quoteExpiresAt.getTime() > Date.now());
        if (winnerActive) {
          const freshWinner = await this.revalidateInvoicePayableUnderLock(invoice);
          return this.toQuoteResult(freshWinner, winner);
        }
      }
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_PAYMENT_IN_PROGRESS,
        message: 'A USDC payment is already being quoted for this invoice',
      });
    }
  }

  // ── Claim ───────────────────────────────────────────────────────────────────

  /**
   * Verifies a user-submitted transaction hash against the attempt's quote
   * snapshot and advances the payment lifecycle. Retryable outcomes
   * (`pending`/`rpc_error`) never change state; `confirming` records evidence
   * and stays active; a fully confirmed exact transfer settles the invoice
   * atomically via the shared first-rail-wins boundary. Every mismatch becomes
   * `needs_review`/`expired`/`failed` — never a fabricated payment.
   *
   * Concurrency: the pre-RPC attempt read is a planning read only. Every state
   * write after RPC is an evidence-aware compare-and-set bound to the caller's
   * observed evidence identity (canonical tx hash, chain/token snapshot,
   * block number/hash, log index, payer, and actual amount): the CAS only
   * matches when the attempt is still active AND its recorded evidence is
   * absent or exactly equal to that identity. A stale claim can therefore
   * never regress a `succeeded`/`needs_review`/`expired`/`failed` attempt and
   * never overwrite a different evidence identity; the final settlement
   * re-reads the attempt under stable PostgreSQL row locks (attempt → invoice)
   * and refuses to write or settle when the locked row carries different
   * evidence. A concurrent claim that recorded different valid evidence makes
   * this claim a `duplicate_unallocated` review (or returns the real current
   * state), preserving the recorded evidence.
   */
  private async claimImpl(
    userId: string,
    invoiceId: string,
    input: { paymentAttemptId: string; txHash: string },
    opts: {
      source: 'client' | 'wallet_server';
      boundTransactionId?: string;
    } = { source: 'client' },
  ): Promise<UsdcClaimResult> {
    this.assertEnabled();
    const invoice = await this.loadOwnedInvoice(userId, invoiceId);
    if (invoice.status !== 'finalized') {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVOICE_NOT_PAYABLE,
        message: 'Invoice is no longer payable',
      });
    }

    let attempt = await this.prisma.billingPaymentAttempt.findUnique({
      where: { id: input.paymentAttemptId },
    });
    if (!attempt || attempt.invoiceId !== invoice.id) {
      throw new NotFoundException('Payment attempt not found');
    }
    if (attempt.method !== 'usdc') {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt is not a USDC payment',
      });
    }
    // Full single-rail quotes keep amountMicros == totalMicros; renewal
    // remainder quotes carry the persisted remainder snapshot (never more than
    // the frozen total). The immutable snapshot amount is authoritative for
    // receipt verification; the settlement boundary caps any excess coverage.
    if (attempt.currency !== invoice.currency || !this.amountMatchesInvoice(attempt, invoice)) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt does not match the invoice',
      });
    }
    this.assertSnapshotComplete(attempt, invoice);

    // Canonicalize the claimed hash immediately: lookup, comparison, evidence,
    // persistence, and return values all use the lowercase form so client
    // casing can never bypass evidence uniqueness.
    const txHash = canonicalizeTxHash(input.txHash);
    const chainId = Number(attempt.chainId);

    // Phase 2B (B3): wallet reservation owns hash binding.
    // - Client: never first-write submittedTxHash; only verify when hash already
    //   matches server-bound submittedTxHash or bound Transaction.txHash.
    // - wallet_server: may first-write only when boundTransactionId matches the
    //   reservation and the bound row does not hold a different hash.
    const walletReserved = attempt.walletPaymentReserved === true;
    if (walletReserved) {
      const boundTxId = attempt.walletPaymentTransactionId;
      const boundTx = boundTxId
        ? await this.prisma.transaction.findUnique({ where: { id: boundTxId } })
        : null;
      const boundTxHash = typeof boundTx?.txHash === 'string' ? boundTx.txHash.toLowerCase() : null;
      const serverBound =
        (typeof attempt.submittedTxHash === 'string'
          ? attempt.submittedTxHash.toLowerCase()
          : null) ?? boundTxHash;

      if (opts.source === 'client') {
        if (!serverBound) {
          throw new ConflictException({
            code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
            message:
              'Wallet payment reservation has no server-bound hash yet; client claim cannot attach one',
          });
        }
        if (serverBound !== txHash) {
          throw new ConflictException({
            code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
            message: 'Wallet payment reservation already bound to a different transaction hash',
          });
        }
      } else {
        // wallet_server path — require full bound Transaction identity, not a bare FK.
        this.assertTrustedWalletServerBinding({
          attempt,
          invoice,
          userId,
          txHash,
          boundTransactionId: opts.boundTransactionId,
          boundTx,
          boundTxHash,
        });
      }
    } else if (opts.source === 'wallet_server') {
      // Server claim is only valid on a reserved wallet-payment attempt.
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
        message: 'Wallet payment server claim requires an active reservation binding',
      });
    }

    // Terminal states are returned as-is (idempotent replays).
    if (attempt.status === 'succeeded') {
      return this.toClaimResult(invoice, attempt, { status: 'succeeded' });
    }
    if (attempt.status === 'expired') {
      return this.toClaimResult(invoice, attempt, { status: 'expired', retryable: true });
    }
    if (attempt.status === 'needs_review') {
      // B2: wallet_server may reopen recoverable reservation-review reasons when
      // a matching server-bound hash is claimed for real receipt settlement.
      // Client claims and manual/evidence-conflict review stay locked.
      if (opts.source === 'wallet_server') {
        const reopened = await this.tryReopenRecoverableWalletReview(
          attempt,
          txHash,
          opts.boundTransactionId,
        );
        if (reopened) {
          attempt = reopened;
        } else {
          return this.toClaimResult(invoice, attempt, { status: 'needs_review' });
        }
      } else {
        return this.toClaimResult(invoice, attempt, { status: 'needs_review' });
      }
    }
    if (attempt.status === 'failed') {
      return this.toClaimResult(invoice, attempt, { status: 'failed', retryable: true });
    }

    // A confirming attempt is bound to its recorded evidence; a different
    // claimed hash is a conflict that must never mutate the owner's state —
    // the losing request returns the real current state without any write.
    if (attempt.txHash && attempt.txHash !== txHash) {
      return this.toClaimResultFromRow(invoice, attempt);
    }

    // Persist the canonical user-submitted hash BEFORE any RPC verification, so
    // a process restart / worker retry can resume this pending or confirming
    // claim by reusing the existing verification path. The write is an
    // evidence-aware CAS (active states, submittedTxHash null or equal) and
    // schedules the next retry backoff; it never overwrites a different hash.
    // The CAS outcome is authoritative: when a competing claim owns a different
    // submitted hash (or a concurrent transition won), this losing request must
    // NOT call RPC and must NOT mutate/evaluate the owner's terminal state.
    // B1: client CAS requires still-unreserved; server CAS requires reserved binding.
    const persisted = await this.persistSubmittedHash(attempt.id, txHash, USDC_RETRY_BACKOFF_MS, {
      source: opts.source,
    });
    if (!persisted.matched) {
      if (!persisted.current) throw new NotFoundException('Payment attempt not found');
      // Client lost to wallet reservation — never treat as success.
      if (opts.source === 'client' && persisted.current.walletPaymentReserved === true) {
        throw new ConflictException({
          code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
          message:
            'Wallet payment reservation won the attempt lock; client claim cannot attach evidence',
        });
      }
      return this.toClaimResultFromRow(invoice, persisted.current);
    }

    // Fetch the receipt. Not-found and transient RPC errors are retryable and
    // never change state.
    let receipt: UsdcReceipt | null;
    try {
      receipt = await this.receiptProvider.getTransactionReceipt(chainId, txHash);
    } catch {
      return this.toClaimResult(invoice, attempt, {
        status: 'rpc_error',
        retryable: true,
        txHash,
      });
    }
    if (!receipt) {
      // A confirming attempt has recorded evidence; a temporarily missing
      // receipt (RPC pruning/error) must never expire it or lose evidence.
      // Only a still-pending attempt with a genuinely expired quote may
      // expire.
      if (attempt.status === 'confirming' || attempt.txHash) {
        return this.toClaimResult(invoice, attempt, {
          status: 'confirming',
          retryable: true,
          txHash,
        });
      }
      if (attempt.quoteExpiresAt!.getTime() <= Date.now()) {
        return this.markExpired(attempt, invoice, txHash);
      }
      return this.toClaimResult(invoice, attempt, {
        status: 'pending',
        retryable: true,
        txHash,
      });
    }

    // The receipt must resolve to the claimed hash (canonical comparison).
    if (canonicalizeTxHash(receipt.transactionHash) !== txHash) {
      return this.markReview(
        attempt,
        'receipt_hash_mismatch',
        invoice,
        {
          txHash,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          blockTimestamp: receipt.blockTimestamp,
          receiptEvidence: this.buildEvidence(receipt, null),
        },
        txHash,
      );
    }

    // The receipt must carry a block timestamp to reason about quote timing.
    if (typeof receipt.blockTimestamp !== 'bigint') {
      return this.markReview(
        attempt,
        'missing_block_timestamp',
        invoice,
        {
          txHash,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          receiptEvidence: this.buildEvidence(receipt, null),
        },
        txHash,
      );
    }

    // Reorg detection precedes expiry: evidence already recorded for a
    // different block means the chain reorganized — never expire or settle.
    if (
      (attempt.blockHash && attempt.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase()) ||
      (attempt.blockNumber !== null && attempt.blockNumber !== receipt.blockNumber)
    ) {
      return this.markReview(
        attempt,
        'reorged',
        invoice,
        {
          txHash,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          blockTimestamp: receipt.blockTimestamp,
          receiptEvidence: this.buildEvidence(receipt, null),
        },
        txHash,
      );
    }

    // Chain-time lower bound: the transfer must have been mined in the same
    // second as (or after) the attempt was created. An older exact transfer
    // must never be replayed against a newer quote. The comparison is at
    // second granularity (block timestamps are whole seconds while
    // `createdAt` carries milliseconds) so a transfer mined in the same second
    // as the quote is not falsely flagged.
    if (BigInt(receipt.blockTimestamp) < BigInt(Math.floor(attempt.createdAt.getTime() / 1000))) {
      return this.markReview(
        attempt,
        'receipt_predates_attempt',
        invoice,
        {
          txHash,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          blockTimestamp: receipt.blockTimestamp,
          receiptEvidence: this.buildEvidence(receipt, null),
        },
        txHash,
      );
    }

    // Only a successful receipt can pay an invoice. A confirming attempt whose
    // recorded success is now reverted is a reorg/evidence change → review.
    if (receipt.status !== 'success') {
      if (attempt.status === 'confirming' || attempt.txHash) {
        return this.markReview(
          attempt,
          'reorged',
          invoice,
          {
            txHash,
            blockNumber: receipt.blockNumber,
            blockHash: receipt.blockHash,
            blockTimestamp: receipt.blockTimestamp,
            receiptEvidence: this.buildEvidence(receipt, null),
          },
          txHash,
        );
      }
      return this.markFailed(attempt, invoice, txHash, receipt);
    }

    // Strict canonical Transfer verification (removed/unsafe logs are review).
    const parsed = this.parseTransfer(receipt, attempt);
    if (parsed.kind !== 'match') {
      return this.markReview(
        attempt,
        parsed.reason,
        invoice,
        {
          txHash,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          blockTimestamp: receipt.blockTimestamp,
          receiptEvidence: this.buildEvidence(receipt, parsed.log),
        },
        txHash,
      );
    }

    // A confirming attempt's recorded evidence must match the current receipt;
    // a changed log/amount/payer is a reorg/evidence change → review.
    if (attempt.status === 'confirming' && attempt.txHash) {
      const evidenceChanged =
        (attempt.logIndex !== null && attempt.logIndex !== parsed.transfer.logIndex) ||
        (attempt.payerAddress !== null &&
          attempt.payerAddress.toLowerCase() !== parsed.transfer.from) ||
        (attempt.actualBaseUnits !== null && attempt.actualBaseUnits !== parsed.transfer.amount);
      if (evidenceChanged) {
        return this.markReview(
          attempt,
          'evidence_changed',
          invoice,
          {
            txHash,
            blockNumber: receipt.blockNumber,
            blockHash: receipt.blockHash,
            blockTimestamp: receipt.blockTimestamp,
            receiptEvidence: this.buildEvidence(receipt, parsed.transfer.log),
          },
          txHash,
        );
      }
    }

    // Chain-time expiry: the transfer was mined after the quote expired. Only
    // a still-pending attempt may expire; a confirming attempt with recorded
    // evidence that now shows a post-expiry timestamp is an inconsistency.
    if (BigInt(receipt.blockTimestamp) * 1000n > BigInt(attempt.quoteExpiresAt!.getTime())) {
      if (attempt.status === 'confirming' || attempt.txHash) {
        return this.markReview(
          attempt,
          'evidence_changed',
          invoice,
          {
            txHash,
            blockNumber: receipt.blockNumber,
            blockHash: receipt.blockHash,
            blockTimestamp: receipt.blockTimestamp,
            receiptEvidence: this.buildEvidence(receipt, parsed.transfer.log),
          },
          txHash,
        );
      }
      return this.markExpired(attempt, invoice, txHash);
    }

    // Confirmations against the current chain head.
    let currentBlock: bigint;
    try {
      currentBlock = await this.receiptProvider.getBlockNumber(chainId);
    } catch {
      return this.toClaimResult(invoice, attempt, {
        status: 'rpc_error',
        retryable: true,
        txHash,
      });
    }
    // The chain head must not be behind the receipt block; that is a transient
    // RPC inconsistency (retryable), never a settlement or a fabricated
    // failure.
    if (currentBlock < receipt.blockNumber) {
      return this.toClaimResult(invoice, attempt, {
        status: 'rpc_error',
        retryable: true,
        txHash,
      });
    }
    const confirmations = currentBlock - receipt.blockNumber + 1n;
    const required = BigInt(attempt.requiredConfirmations!);

    if (confirmations < required) {
      // Confirming: record evidence and stay active for a later re-claim. The
      // write is a compare-and-set on the active states so a stale claim can
      // never regress a succeeded/terminal attempt.
      return this.markConfirming(attempt, invoice, txHash, receipt, parsed.transfer, confirmations);
    }

    // Fully confirmed: settle atomically.
    return this.settleConfirmed(attempt, invoice, txHash, receipt, parsed.transfer, confirmations);
  }

  /**
   * Marks the attempt succeeded and settles the invoice in one transaction via
   * the shared first-rail-wins boundary. The transaction takes stable
   * PostgreSQL row locks (attempt → invoice), re-reads the attempt under the
   * lock, and only then transitions it to `succeeded` — so a stale claim can
   * never regress a terminal state and at most one concurrent claim can
   * perform the settlement. The re-read also verifies the recorded evidence
   * identity: a claim whose observed evidence differs from the locked row's
   * recorded evidence is never written and never settled with — it is recorded
   * as `duplicate_unallocated` review, preserving the recorded evidence. A lost
   * race (invoice already paid by another rail) records the successful evidence
   * as `duplicate_unallocated` review in the same transaction; a replay of this
   * attempt's own settlement is an idempotent paid result. A unique-evidence
   * conflict (the same Transfer already allocated elsewhere) is also
   * `duplicate_unallocated`.
   */
  private async settleConfirmed(
    attempt: PaymentAttemptRow,
    invoice: InvoiceRow,
    txHash: string,
    receipt: UsdcReceipt,
    transfer: DecodedTransfer,
    confirmations: bigint,
  ): Promise<UsdcClaimResult> {
    const evidence = this.buildEvidence(receipt, transfer.log);
    const identity = this.claimEvidence(attempt, txHash, receipt, transfer);
    try {
      const outcome = await this.prisma.$transaction(async (tx: Tx) => {
        // Uniform lock order (Gate 1 attempt 3): period → attempt → invoice.
        // settleInvoice re-enters the same period key then re-locks rows.
        await acquireBillingPeriodAdvisoryLock(tx, invoice.billingAccountId, invoice.periodStart);
        const lockedAttempt = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "billing_payment_attempts" WHERE "id" = ${attempt.id} FOR UPDATE`;
        if (lockedAttempt.length === 0) return { kind: 'missing' } as const;
        const lockedInvoice = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "billing_invoices" WHERE "id" = ${invoice.id} FOR UPDATE`;
        if (lockedInvoice.length === 0) return { kind: 'missing' } as const;

        const current = await tx.billingPaymentAttempt.findUnique({
          where: { id: attempt.id },
        });
        if (!current) return { kind: 'missing' } as const;

        // Terminal states are never overwritten by a stale claim.
        if (current.status === 'succeeded') {
          const settledInvoice = await tx.billingInvoice.findUnique({
            where: { id: invoice.id },
            select: { settlementAttemptId: true },
          });
          if (settledInvoice?.settlementAttemptId === attempt.id) {
            return { kind: 'paid', row: current, wroteEvidence: false } as const;
          }
          return { kind: 'duplicate', row: current } as const;
        }
        if (
          current.status === 'needs_review' ||
          current.status === 'expired' ||
          current.status === 'failed'
        ) {
          return {
            kind: 'terminal',
            status: current.status,
            reviewReason: current.reviewReason,
            row: current,
          } as const;
        }

        // Still active: the attempt must still be owned by this claim's
        // canonical submitted hash, and its recorded evidence (if any) must
        // match the caller's observed identity before this claim may write or
        // settle. A different submitted hash or a different evidence identity
        // is never overwritten and never settled with.
        if (
          typeof current.submittedTxHash === 'string' &&
          current.submittedTxHash !== identity.txHash
        ) {
          return { kind: 'duplicate', row: current } as const;
        }
        if (current.txHash !== null && !this.evidenceMatches(current, identity)) {
          await tx.billingPaymentAttempt.update({
            where: { id: attempt.id },
            data: {
              status: 'needs_review',
              reviewReason: 'duplicate_unallocated',
              lastCheckedAt: new Date(),
            },
          });
          return {
            kind: 'duplicate',
            row: { ...current, status: 'needs_review', reviewReason: 'duplicate_unallocated' },
          } as const;
        }

        // Evidence matches (or none recorded): mark succeeded and settle
        // atomically through the shared coverage boundary. But first re-read
        // the invoice under the row lock and reject a STALE quote: if the
        // current remaining balance (`totalMicros - allocatedMicros`) shrank
        // below the persisted quote amount (e.g. a fixed-fee renewal allocation
        // landed after the quote was issued), settling would give the user
        // partial credit for a full payment. A legitimate fixed-fee remainder
        // quote (persisted amount <= current remainder) is unchanged and
        // passes; only an over-covering stale quote is refused and surfaced
        // for review so the overpayment can be resolved, never silently
        // truncated into a partial allocation.
        const freshInvoice = await tx.billingInvoice.findUnique({
          where: { id: invoice.id },
        });
        if (!freshInvoice) return { kind: 'missing' } as const;
        const currentRemaining = freshInvoice.totalMicros - (freshInvoice.allocatedMicros ?? 0n);
        if (attempt.amountMicros > currentRemaining) {
          await tx.billingPaymentAttempt.update({
            where: { id: attempt.id },
            data: {
              status: 'needs_review',
              reviewReason: 'stale_quote_over_remainder',
              lastCheckedAt: new Date(),
            },
          });
          return {
            kind: 'duplicate',
            row: {
              ...current,
              status: 'needs_review',
              reviewReason: 'stale_quote_over_remainder',
            },
          } as const;
        }

        await tx.billingPaymentAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'succeeded',
            succeededAt: new Date(),
            txHash,
            logIndex: transfer.logIndex,
            payerAddress: transfer.from,
            actualBaseUnits: transfer.amount,
            blockNumber: receipt.blockNumber,
            blockHash: receipt.blockHash,
            blockTimestamp: receipt.blockTimestamp,
            receiptEvidence: evidence,
            lastCheckedAt: new Date(),
          },
        });
        const result = await this.settlementService.settleInvoice(tx, {
          id: attempt.id,
          invoiceId: invoice.id,
          method: 'usdc',
        });
        // The invoice is fully covered when the shared allocation boundary set
        // the paid markers in this call or this attempt already owns the
        // settlement pointer (idempotent replay of an earlier settlement).
        const settledInvoice = await tx.billingInvoice.findUnique({
          where: { id: invoice.id },
          select: { settlementAttemptId: true },
        });
        if (
          (result.paid && result.paidByThisAttempt) ||
          (!result.paid && settledInvoice?.settlementAttemptId === attempt.id)
        ) {
          return { kind: 'paid', row: current, wroteEvidence: true } as const;
        }
        if (result.replayed) {
          // This attempt's coverage was already counted toward the invoice in
          // an earlier allocation (replay). Its coverage fact is real and must
          // never be demoted to a duplicate review just because another rail
          // paid the invoice later.
          return { kind: 'duplicate', row: current } as const;
        }
        // Another rail won the race: record the successful evidence as
        // duplicate/unallocated review, never overwrite the paid invoice.
        await tx.billingPaymentAttempt.update({
          where: { id: attempt.id },
          data: { status: 'needs_review', reviewReason: 'duplicate_unallocated' },
        });
        return {
          kind: 'duplicate',
          row: { ...current, status: 'needs_review', reviewReason: 'duplicate_unallocated' },
        } as const;
      });

      switch (outcome.kind) {
        case 'missing':
          throw new NotFoundException('Payment attempt not found');
        case 'terminal':
          return this.toClaimResultFromRow(invoice, outcome.row);
        case 'duplicate':
          return this.toClaimResultFromRow(invoice, outcome.row);
        case 'paid': {
          // Post-commit best-effort Stripe mirror sync (local entitlement already committed).
          if (
            this.subscriptionSync &&
            (invoice as { purpose?: string }).purpose === 'plan_charge'
          ) {
            void this.subscriptionSync.processAccountBestEffort(invoice.billingAccountId);
          }
          if (outcome.wroteEvidence) {
            // This claim performed the settlement: report its verified evidence.
            return this.toClaimResult(
              invoice,
              {
                ...outcome.row,
                status: 'succeeded',
                txHash,
                blockNumber: receipt.blockNumber,
                blockHash: receipt.blockHash,
                blockTimestamp: receipt.blockTimestamp,
              },
              {
                status: 'succeeded',
                paid: true,
                txHash,
                confirmations: Number(confirmations),
                blockNumber: receipt.blockNumber.toString(),
                blockHash: receipt.blockHash,
                blockTimestamp: receipt.blockTimestamp.toString(),
              },
            );
          }
          // Idempotent replay of a settlement this claim did not perform:
          // report the recorded evidence, not the stale caller's claim.
          const row = outcome.row;
          const sameEvidence = this.evidenceMatches(row, identity);
          return this.toClaimResult(invoice, row, {
            status: 'succeeded',
            paid: true,
            confirmations: sameEvidence ? Number(confirmations) : null,
          });
        }
      }
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      // The Transfer evidence is already allocated to another attempt.
      const current = await this.casUpdateEvidence(
        attempt.id,
        ACTIVE_CLAIM_STATES,
        {
          status: 'needs_review',
          reviewReason: 'duplicate_unallocated',
          lastCheckedAt: new Date(),
        },
        identity,
        identity.txHash,
      );
      if (current) return this.toClaimResultFromRow(invoice, current);
      return this.toClaimResult(
        invoice,
        { ...attempt, status: 'needs_review', reviewReason: 'duplicate_unallocated' },
        { status: 'needs_review', reviewReason: 'duplicate_unallocated' },
      );
    }
  }

  // ── Strict Transfer parsing ─────────────────────────────────────────────────

  /**
   * Finds the unique canonical USDC Transfer log for this attempt: emitted by
   * the canonical token contract, Transfer topic0, strictly 32-byte padded
   * from/to topics, 32-byte uint256 data, from = expected payer, to = treasury,
   * amount = expected base units, and explicitly not removed. Zero matches,
   * malformed candidates, removed/unsafe logs (a removal flag that is missing,
   * non-boolean, or true — even when an active exact log coexists), and
   * multiple exact matches are all review.
   */
  private parseTransfer(receipt: UsdcReceipt, attempt: PaymentAttemptRow): TransferParseResult {
    const token = attempt.tokenAddress!.toLowerCase();
    const payer = attempt.expectedPayerAddress!.toLowerCase();
    const treasury = attempt.treasuryAddress!.toLowerCase();
    const expected = attempt.expectedBaseUnits!;

    // Only logs from the canonical token with the Transfer topic0 are relevant
    // Transfer evidence.
    const tokenLogs = receipt.logs.filter(
      (log) =>
        log.address.toLowerCase() === token &&
        log.topics[0]?.toLowerCase() === USDC_TRANSFER_TOPIC0,
    );

    // A log whose removal flag is not the explicit boolean `false` (missing,
    // undefined, null, or true) is unsafe evidence. It must never be treated
    // as active, and it must never coexist with an active exact match.
    const unsafeLogs = tokenLogs.filter((log) => log.removed !== false);
    if (unsafeLogs.length > 0) {
      return { kind: 'review', reason: 'removed_log', log: unsafeLogs[0] };
    }

    if (tokenLogs.length === 0) {
      return { kind: 'review', reason: 'no_transfer_log', log: null };
    }

    const decoded: DecodedTransfer[] = [];
    for (const log of tokenLogs) {
      const transfer = decodeTransferLog(log);
      if (!transfer) {
        return { kind: 'review', reason: 'malformed_transfer_log', log };
      }
      decoded.push(transfer);
    }

    const matches = decoded.filter(
      (t) => t.from === payer && t.to === treasury && t.amount === expected,
    );

    if (matches.length === 0) {
      const anyPayer = decoded.some((t) => t.from === payer);
      const anyTreasury = decoded.some((t) => t.to === treasury);
      const anyAmount = decoded.some((t) => t.amount === expected);
      const reason = !anyPayer
        ? 'wrong_payer'
        : !anyTreasury
          ? 'wrong_recipient'
          : !anyAmount
            ? 'wrong_amount'
            : 'no_matching_transfer';
      return { kind: 'review', reason, log: decoded[0].log };
    }

    if (matches.length > 1) {
      return { kind: 'review', reason: 'ambiguous_transfer', log: matches[0].log };
    }

    return { kind: 'match', transfer: matches[0] };
  }

  // ── State transitions ───────────────────────────────────────────────────────

  /**
   * Evidence-aware CAS that persists the canonical user-submitted hash before
   * verification and schedules the next worker retry. Only matches active
   * (pending/confirming) attempts whose submitted hash is absent or exactly the
   * claimed hash, so a stale/competing claim can never overwrite a different
   * submitted hash or regress a terminal state.
   *
   * Returns the CAS outcome: `{ matched: true }` when this claim now owns the
   * submitted hash, or `{ matched: false, current }` with the current attempt
   * row when a competing claim owns a different hash or the attempt moved to a
   * terminal state. The losing caller must not perform RPC work nor mutate the
   * owner's state.
   */
  /**
   * B2: wallet_server claim requires a fully attributed bound billing_payment
   * Transaction — not a bare FK or forensic enclosing hash alone.
   */
  private assertTrustedWalletServerBinding(args: {
    attempt: PaymentAttemptRow;
    invoice: InvoiceRow;
    userId: string;
    txHash: string;
    boundTransactionId?: string;
    boundTx: {
      id: string;
      userId: string;
      txHash: string | null;
      chainId: bigint;
      walletAddress: string;
      operationType: string | null;
      authMethod: string;
      apiKeyId: string | null;
      details?: unknown;
    } | null;
    boundTxHash: string | null;
  }): void {
    const { attempt, invoice, userId, txHash, boundTransactionId, boundTx, boundTxHash } = args;
    const boundTxId = attempt.walletPaymentTransactionId;
    if (!boundTxId || !boundTransactionId || boundTransactionId !== boundTxId) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
        message: 'Wallet payment server claim requires matching bound transaction',
      });
    }
    if (!boundTx) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
        message: 'Wallet payment bound transaction is missing',
      });
    }
    // Non-null bound hash equal to claimed hash — forensic-null alone is not enough.
    if (!boundTxHash || boundTxHash !== txHash) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
        message:
          'Wallet payment server claim requires a non-null bound transaction hash matching the claim',
      });
    }
    if (attempt.submittedTxHash && attempt.submittedTxHash.toLowerCase() !== txHash) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
        message: 'Wallet payment reservation already bound to a different transaction hash',
      });
    }
    if (boundTx.userId !== userId) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
        message: 'Wallet payment bound transaction user mismatch',
      });
    }
    if (boundTx.operationType !== 'billing_payment') {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
        message: 'Wallet payment bound transaction operation type mismatch',
      });
    }
    if (boundTx.authMethod !== 'iam' || boundTx.apiKeyId !== null) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
        message: 'Wallet payment bound transaction auth attribution mismatch',
      });
    }
    if (Number(boundTx.chainId) !== Number(attempt.chainId)) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
        message: 'Wallet payment bound transaction chain mismatch',
      });
    }
    const expectedPayer = (attempt.expectedPayerAddress ?? '').toLowerCase();
    if (!expectedPayer || boundTx.walletAddress.toLowerCase() !== expectedPayer) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
        message: 'Wallet payment bound transaction payer mismatch',
      });
    }
    const d = boundTx.details;
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      const details = d as Record<string, unknown>;
      if (typeof details.paymentAttemptId === 'string' && details.paymentAttemptId !== attempt.id) {
        throw new ConflictException({
          code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
          message: 'Wallet payment bound transaction attempt binding mismatch',
        });
      }
      if (typeof details.invoiceId === 'string' && details.invoiceId !== invoice.id) {
        throw new ConflictException({
          code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
          message: 'Wallet payment bound transaction invoice binding mismatch',
        });
      }
    }
  }

  /**
   * B2: reopen a recoverable wallet-payment `needs_review` row for server claim.
   * Requires reserved binding + matching boundTransactionId + allowlisted reason
   * + existing matching submittedTxHash (trusted claim CAS evidence). Unattributed
   * UserOp review and bare forensic hashes never reopen.
   */
  private async tryReopenRecoverableWalletReview(
    attempt: PaymentAttemptRow,
    txHash: string,
    boundTransactionId?: string,
  ): Promise<PaymentAttemptRow | null> {
    if (attempt.walletPaymentReserved !== true) return null;
    if (!boundTransactionId || boundTransactionId !== attempt.walletPaymentTransactionId) {
      return null;
    }
    const reason = attempt.reviewReason ?? '';
    if (!(RECOVERABLE_WALLET_PAYMENT_REVIEW_REASONS as readonly string[]).includes(reason)) {
      return null;
    }
    // Trusted path only: submittedTxHash must already equal the claim hash.
    // A bare Transaction.txHash forensic seed is insufficient to reopen.
    if (
      typeof attempt.submittedTxHash !== 'string' ||
      attempt.submittedTxHash.toLowerCase() !== txHash
    ) {
      return null;
    }

    const targetStatus = attempt.txHash ? 'confirming' : 'pending';
    const updated = await this.prisma.billingPaymentAttempt.updateMany({
      where: {
        id: attempt.id,
        status: 'needs_review',
        walletPaymentReserved: true,
        walletPaymentTransactionId: boundTransactionId,
        reviewReason: { in: [...RECOVERABLE_WALLET_PAYMENT_REVIEW_REASONS] },
        submittedTxHash: txHash,
      },
      data: {
        status: targetStatus,
        reviewReason: null,
        lastCheckedAt: new Date(),
      },
    });
    if (updated.count === 0) return null;
    return this.prisma.billingPaymentAttempt.findUnique({ where: { id: attempt.id } });
  }

  private async persistSubmittedHash(
    attemptId: string,
    txHash: string,
    backoffMs: number,
    opts: { source: 'client' | 'wallet_server' } = { source: 'client' },
  ): Promise<{ matched: boolean; current: PaymentAttemptRow | null }> {
    let result: { count: number };
    try {
      // Status must still be active: upgrade cancel marks pending → failed under
      // attempt row locks, so a post-cancel hash attach must match zero rows and
      // never paint evidence onto a failed/canceled attempt.
      // B1: client may only first-write while unreserved; wallet_server only while reserved.
      result = await this.prisma.billingPaymentAttempt.updateMany({
        where: {
          id: attemptId,
          status: { in: [...ACTIVE_CLAIM_STATES] },
          ...(opts.source === 'client'
            ? { walletPaymentReserved: false }
            : { walletPaymentReserved: true }),
          // First writer wins on a null hash; same-hash replay is allowed while
          // still active. A failed/voided attempt never matches.
          OR: [{ submittedTxHash: null }, { submittedTxHash: txHash }],
        },
        data: {
          submittedTxHash: txHash,
          lastCheckedAt: new Date(),
          nextCheckAt: new Date(Date.now() + backoffMs),
        },
      });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      // Prisma P2002: the canonical `submitted_tx_hash` is ALREADY owned by
      // another attempt (the migration-only unique index). This claim can
      // never become the provider's evidence owner — fail closed: never a bare
      // 500, never a second provider claim, never a permanent pending. The
      // attempt is marked `needs_review`/`duplicate_unallocated` while it is
      // still active; a concurrent terminal transition wins and its real state
      // is returned instead.
      return this.markDuplicateSubmittedHash(attemptId, txHash);
    }
    if (result.count > 0) return { matched: true, current: null };
    const current = await this.prisma.billingPaymentAttempt.findUnique({
      where: { id: attemptId },
    });
    return { matched: false, current };
  }

  /**
   * Fail-closed outcome for a claim whose canonical submitted hash is already
   * owned by ANOTHER attempt (the migration-only unique `submitted_tx_hash`
   * index rejected the write with a Prisma P2002). The losing claim must never
   * perform provider work and must never be left permanently pending: while the
   * attempt is still active AND still unclaimed (`submittedTxHash` NULL) it is
   * transitioned to `needs_review`/`duplicate_unallocated` with a safe audit
   * note (the conflicting hash is not secret). The NULL guard means a
   * concurrent claim that legitimately persisted a DIFFERENT hash after this
   * loser's P2002 is never marked needs_review — its real state is returned
   * instead. A concurrent terminal transition wins the same way, so a stale
   * loser can never regress a succeeded/terminal attempt.
   */
  private async markDuplicateSubmittedHash(
    attemptId: string,
    txHash: string,
  ): Promise<{ matched: boolean; current: PaymentAttemptRow | null }> {
    const current = await this.prisma.billingPaymentAttempt.findUnique({
      where: { id: attemptId },
    });
    if (!current) return { matched: false, current: null };
    if (current.status !== 'pending' && current.status !== 'confirming') {
      return { matched: false, current };
    }
    if (current.submittedTxHash !== null) {
      // A concurrent claim already owns this attempt with a legitimate hash;
      // this loser must never mark it needs_review.
      return { matched: false, current };
    }
    const claimed = await this.prisma.billingPaymentAttempt.updateMany({
      where: {
        id: attemptId,
        status: { in: [...ACTIVE_CLAIM_STATES] },
        submittedTxHash: null,
      },
      data: {
        status: 'needs_review',
        reviewReason: 'duplicate_unallocated',
        failureCode: 'duplicate_submitted_hash',
        failureMessage: `Submitted hash is already claimed by another payment attempt: ${txHash}`,
        lastCheckedAt: new Date(),
      },
    });
    if (claimed.count === 1) {
      return {
        matched: false,
        current: {
          ...current,
          status: 'needs_review',
          reviewReason: 'duplicate_unallocated',
          failureCode: 'duplicate_submitted_hash',
        },
      };
    }
    const latest = await this.prisma.billingPaymentAttempt.findUnique({
      where: { id: attemptId },
    });
    return { matched: false, current: latest };
  }

  /**
   * Compare-and-set state transition. The update only matches when the attempt
   * is still in one of the allowed source states (and, when supplied, still
   * bound to the caller's canonical submitted hash), so a stale claim can never
   * regress a state it did not observe or mutate a competing claim's attempt.
   * Returns the current attempt row when the CAS matched zero rows (a
   * concurrent transition won) so the caller can return the real state instead
   * of overwriting it; returns null on success.
   */
  private async casUpdate(
    attemptId: string,
    sourceStatuses: readonly ('pending' | 'confirming')[],
    data: Prisma.BillingPaymentAttemptUncheckedUpdateInput,
    submittedTxHash?: string,
  ): Promise<PaymentAttemptRow | null> {
    const result = await this.prisma.billingPaymentAttempt.updateMany({
      where: {
        id: attemptId,
        status: { in: [...sourceStatuses] },
        ...(submittedTxHash ? { submittedTxHash } : {}),
      },
      data,
    });
    if (result.count > 0) return null;
    return this.prisma.billingPaymentAttempt.findUnique({ where: { id: attemptId } });
  }

  /**
   * Evidence-aware compare-and-set. The update only matches when the attempt is
   * still in one of the allowed source states AND its recorded evidence is
   * either absent or exactly equal to the caller's observed evidence identity
   * AND (when supplied) it is still bound to the caller's canonical submitted
   * hash. A stale claim can therefore never overwrite a different evidence
   * identity, never mutate a competing claim's attempt, and never regress a
   * terminal state. Returns the current attempt row when the CAS matched zero
   * rows; returns null on success.
   */
  private async casUpdateEvidence(
    attemptId: string,
    sourceStatuses: readonly ('pending' | 'confirming')[],
    data: Prisma.BillingPaymentAttemptUncheckedUpdateInput,
    identity: ClaimEvidence,
    submittedTxHash?: string,
  ): Promise<PaymentAttemptRow | null> {
    const result = await this.prisma.billingPaymentAttempt.updateMany({
      where: {
        id: attemptId,
        status: { in: [...sourceStatuses] },
        ...this.evidenceGuard(identity),
        ...(submittedTxHash ? { submittedTxHash } : {}),
      },
      data,
    });
    if (result.count > 0) return null;
    return this.prisma.billingPaymentAttempt.findUnique({ where: { id: attemptId } });
  }

  /**
   * Review compare-and-set. The update only matches when the attempt is still
   * active AND its recorded transaction hash is either absent or the hash this
   * claim observed AND (when supplied) it is still bound to the caller's
   * canonical submitted hash. A stale review write can never overwrite a
   * confirming attempt bound to a different transaction or a competing claim's
   * attempt. When `claimedTxHash` is omitted the tx-hash guard is skipped
   * (used only by the evidence-conflict path, where the conflict is precisely
   * that the recorded hash differs from the claimed one).
   */
  private async casUpdateReview(
    attemptId: string,
    sourceStatuses: readonly ('pending' | 'confirming')[],
    data: Prisma.BillingPaymentAttemptUncheckedUpdateInput,
    claimedTxHash?: string,
    submittedTxHash?: string,
  ): Promise<PaymentAttemptRow | null> {
    const result = await this.prisma.billingPaymentAttempt.updateMany({
      where: {
        id: attemptId,
        status: { in: [...sourceStatuses] },
        ...(claimedTxHash ? { OR: [{ txHash: null }, { txHash: claimedTxHash }] } : {}),
        ...(submittedTxHash ? { submittedTxHash } : {}),
      },
      data,
    });
    if (result.count > 0) return null;
    return this.prisma.billingPaymentAttempt.findUnique({ where: { id: attemptId } });
  }

  /**
   * The caller-observed evidence identity for a claim that passed strict
   * Transfer verification. Chain and token come from the immutable quote
   * snapshot; the rest come from the verified receipt and decoded log.
   */
  private claimEvidence(
    attempt: PaymentAttemptRow,
    txHash: string,
    receipt: UsdcReceipt,
    transfer: DecodedTransfer,
  ): ClaimEvidence {
    return {
      txHash,
      chainId: attempt.chainId!,
      tokenAddress: attempt.tokenAddress!.toLowerCase(),
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash.toLowerCase(),
      logIndex: transfer.logIndex,
      payerAddress: transfer.from.toLowerCase(),
      actualBaseUnits: transfer.amount,
    };
  }

  /** True when a persisted attempt row carries exactly this evidence identity. */
  private evidenceMatches(row: PaymentAttemptRow, identity: ClaimEvidence): boolean {
    return (
      row.txHash === identity.txHash &&
      row.chainId === identity.chainId &&
      row.tokenAddress?.toLowerCase() === identity.tokenAddress &&
      row.blockNumber === identity.blockNumber &&
      row.blockHash?.toLowerCase() === identity.blockHash &&
      row.logIndex === identity.logIndex &&
      row.payerAddress?.toLowerCase() === identity.payerAddress &&
      row.actualBaseUnits === identity.actualBaseUnits
    );
  }

  /** Prisma WHERE guard: recorded evidence is absent or exactly this identity. */
  private evidenceGuard(identity: ClaimEvidence): Prisma.BillingPaymentAttemptWhereInput {
    return {
      OR: [
        { txHash: null },
        {
          txHash: identity.txHash,
          blockNumber: identity.blockNumber,
          blockHash: identity.blockHash,
          logIndex: identity.logIndex,
          payerAddress: identity.payerAddress,
          actualBaseUnits: identity.actualBaseUnits,
        },
      ],
    };
  }

  /**
   * Handles a claim whose evidence-aware CAS matched zero rows: a concurrent
   * transition won. Terminal states are returned as-is; an active attempt bound
   * to the same transaction is an idempotent replay; an active attempt bound to
   * a different transaction is a genuine duplicate payment — recorded as
   * `duplicate_unallocated` review without overwriting the recorded evidence.
   */
  private async handleEvidenceConflict(
    invoice: InvoiceRow,
    current: PaymentAttemptRow,
    identity: ClaimEvidence,
  ): Promise<UsdcClaimResult> {
    if (current.status !== 'pending' && current.status !== 'confirming') {
      return this.toClaimResultFromRow(invoice, current);
    }
    // No evidence recorded yet (defensive; the evidence-aware CAS would have
    // matched a pending row, so this is unreachable) — treat as a replay.
    if (current.txHash === null) {
      return this.toClaimResultFromRow(invoice, current);
    }
    if (current.txHash === identity.txHash) {
      return this.toClaimResultFromRow(invoice, current);
    }
    const updated = await this.casUpdate(
      current.id,
      ACTIVE_CLAIM_STATES,
      {
        status: 'needs_review',
        reviewReason: 'duplicate_unallocated',
        lastCheckedAt: new Date(),
      },
      identity.txHash,
    );
    if (updated) return this.toClaimResultFromRow(invoice, updated);
    return this.toClaimResultFromRow(invoice, {
      ...current,
      status: 'needs_review',
      reviewReason: 'duplicate_unallocated',
    });
  }

  private async markReview(
    attempt: PaymentAttemptRow,
    reason: string,
    invoice: InvoiceRow,
    evidence?: Partial<Prisma.BillingPaymentAttemptUncheckedUpdateInput>,
    claimedTxHash?: string,
  ): Promise<UsdcClaimResult> {
    // Every post-RPC review write is bound to the claimed canonical submitted
    // hash so a stale/competing claim can never push the owner's attempt into
    // review.
    const current = await this.casUpdateReview(
      attempt.id,
      ACTIVE_CLAIM_STATES,
      {
        status: 'needs_review',
        reviewReason: reason,
        lastCheckedAt: new Date(),
        ...evidence,
      },
      claimedTxHash,
      claimedTxHash ?? undefined,
    );
    if (current) {
      // A concurrent transition won (e.g. the attempt was settled or bound to
      // different evidence): return the real current state instead of
      // overwriting it.
      return this.toClaimResultFromRow(invoice, current);
    }
    return this.toClaimResult(
      invoice,
      { ...attempt, status: 'needs_review', reviewReason: reason },
      { status: 'needs_review', reviewReason: reason },
    );
  }

  private async markExpired(
    attempt: PaymentAttemptRow,
    invoice: InvoiceRow,
    txHash: string,
  ): Promise<UsdcClaimResult> {
    // Only a still-pending attempt bound to this claim's canonical submitted
    // hash may expire; a confirming attempt with recorded evidence is handled
    // by the caller as review, never expiry, and a competing claim can never
    // expire the owner's attempt.
    const current = await this.casUpdate(
      attempt.id,
      ['pending'],
      {
        status: 'expired',
        reviewReason: 'quote_expired',
        lastCheckedAt: new Date(),
      },
      txHash,
    );
    if (current) return this.toClaimResultFromRow(invoice, current);
    return this.toClaimResult(
      invoice,
      { ...attempt, status: 'expired', reviewReason: 'quote_expired' },
      { status: 'expired', retryable: true, reviewReason: 'quote_expired' },
    );
  }

  private async markFailed(
    attempt: PaymentAttemptRow,
    invoice: InvoiceRow,
    txHash: string,
    receipt: UsdcReceipt,
  ): Promise<UsdcClaimResult> {
    // Only a still-pending attempt bound to this claim's canonical submitted
    // hash may fail; a confirming attempt whose recorded success is now
    // reverted is handled by the caller as review. A competing claim can never
    // fail the owner's attempt.
    const current = await this.casUpdate(
      attempt.id,
      ['pending'],
      {
        status: 'failed',
        failedAt: new Date(),
        failureCode: 'receipt_reverted',
        failureMessage: 'The submitted transaction reverted; no USDC was transferred',
        txHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        blockTimestamp: receipt.blockTimestamp,
        receiptEvidence: this.buildEvidence(receipt, null),
        lastCheckedAt: new Date(),
      },
      txHash,
    );
    if (current) return this.toClaimResultFromRow(invoice, current);
    return this.toClaimResult(
      invoice,
      { ...attempt, status: 'failed', txHash },
      { status: 'failed', retryable: true, txHash },
    );
  }

  private async markConfirming(
    attempt: PaymentAttemptRow,
    invoice: InvoiceRow,
    txHash: string,
    receipt: UsdcReceipt,
    transfer: DecodedTransfer,
    confirmations: bigint,
  ): Promise<UsdcClaimResult> {
    const identity = this.claimEvidence(attempt, txHash, receipt, transfer);
    try {
      const current = await this.casUpdateEvidence(
        attempt.id,
        ACTIVE_CLAIM_STATES,
        {
          status: 'confirming',
          txHash,
          logIndex: transfer.logIndex,
          payerAddress: transfer.from,
          actualBaseUnits: transfer.amount,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          blockTimestamp: receipt.blockTimestamp,
          receiptEvidence: this.buildEvidence(receipt, transfer.log),
          lastCheckedAt: new Date(),
        },
        identity,
        txHash,
      );
      if (current) {
        // A concurrent transition won: never overwrite a terminal state or a
        // different evidence identity.
        return this.handleEvidenceConflict(invoice, current, identity);
      }
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        // The same Transfer evidence is already allocated to another attempt.
        return this.markReview(attempt, 'duplicate_unallocated', invoice, undefined, txHash);
      }
      throw err;
    }
    return this.toClaimResult(
      invoice,
      {
        ...attempt,
        status: 'confirming',
        txHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        blockTimestamp: receipt.blockTimestamp,
      },
      {
        status: 'confirming',
        retryable: true,
        txHash,
        confirmations: Number(confirmations),
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        blockTimestamp: receipt.blockTimestamp.toString(),
      },
    );
  }

  /** Maps a persisted attempt row to its claim result by its real status. */
  private toClaimResultFromRow(invoice: InvoiceRow, attempt: PaymentAttemptRow): UsdcClaimResult {
    switch (attempt.status) {
      case 'succeeded':
        // A persisted `succeeded` attempt always settled its invoice (a lost
        // rail race is recorded as needs_review/duplicate_unallocated), so the
        // paid flag is true even when the caller's invoice snapshot is stale.
        return this.toClaimResult(invoice, attempt, { status: 'succeeded', paid: true });
      case 'expired':
        return this.toClaimResult(invoice, attempt, { status: 'expired', retryable: true });
      case 'failed':
        return this.toClaimResult(invoice, attempt, { status: 'failed', retryable: true });
      case 'needs_review':
        return this.toClaimResult(invoice, attempt, { status: 'needs_review' });
      case 'confirming':
        return this.toClaimResult(invoice, attempt, { status: 'confirming', retryable: true });
      default:
        return this.toClaimResult(invoice, attempt, { status: 'pending', retryable: true });
    }
  }

  // ── Server-derived facts ────────────────────────────────────────────────────

  private assertEnabled(): void {
    if (this.config.get<boolean>('billing.usdc.enabled') !== true) {
      throw new ServiceUnavailableException('USDC billing is not enabled');
    }
  }

  private async loadOwnedInvoice(userId: string, invoiceId: string): Promise<InvoiceRow> {
    const account = await this.prisma.billingAccount.findUnique({ where: { userId } });
    if (!account) throw new NotFoundException('Invoice not found');
    const invoice = await this.prisma.billingInvoice.findFirst({
      where: { id: invoiceId, billingAccountId: account.id },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  private assertInvoiceEligible(invoice: InvoiceRow): void {
    if (invoice.status !== 'finalized') {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVOICE_NOT_PAYABLE,
        message: 'Only finalized invoices can be paid',
      });
    }
    if (invoice.paidAt) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVOICE_NOT_PAYABLE,
        message: 'Invoice is already paid',
      });
    }
    if (invoice.currency !== 'USD') {
      throw new BadRequestException('Only USD invoices can be paid');
    }
    if (invoice.totalMicros <= 0n) {
      throw new BadRequestException('Invoice amount must be positive');
    }
  }

  /**
   * Period advisory + invoice FOR UPDATE, then re-check eligibility (and
   * plan_charge payability). Closes the race where upgrade cancel voids the
   * invoice between the soft quote preflight and attempt reuse/create.
   */
  private async revalidateInvoicePayableUnderLock(invoice: InvoiceRow): Promise<InvoiceRow> {
    return this.prisma.$transaction(async (tx) => {
      await acquireBillingPeriodAdvisoryLock(tx, invoice.billingAccountId, invoice.periodStart);
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "billing_invoices" WHERE "id" = ${invoice.id} FOR UPDATE`;
      if (locked.length === 0) {
        throw new ConflictException({
          code: API_ERROR_CODES.USDC_INVOICE_NOT_PAYABLE,
          message: 'Invoice is no longer payable',
        });
      }
      const fresh = await tx.billingInvoice.findUnique({ where: { id: invoice.id } });
      if (!fresh) {
        throw new ConflictException({
          code: API_ERROR_CODES.USDC_INVOICE_NOT_PAYABLE,
          message: 'Invoice is no longer payable',
        });
      }
      this.assertInvoiceEligible(fresh);
      if (this.planChanges && fresh.purpose === 'plan_charge') {
        await this.planChanges.assertPlanChargePayable(tx, fresh.id);
      }
      return fresh;
    });
  }

  /**
   * Creates a pending USDC attempt only after locking the invoice and proving
   * it is still finalized/payable. remainingDue is computed from the locked row.
   * BILL-011: re-checks treasury destination allowlist under the user destination
   * advisory lock before insert so an allowlist race cannot start TTL early.
   */
  private async createUsdcAttemptUnderLock(args: {
    userId: string;
    invoice: InvoiceRow;
    chain: number;
    tokenAddress: string;
    treasuryAddress: string;
    expectedPayerAddress: string;
    requiredConfirmations: number;
    quoteExpiresAt: Date;
  }): Promise<{ invoice: InvoiceRow; attempt: PaymentAttemptRow }> {
    const {
      userId,
      invoice,
      chain,
      tokenAddress,
      treasuryAddress,
      expectedPayerAddress,
      requiredConfirmations,
      quoteExpiresAt,
    } = args;
    return this.prisma.$transaction(async (tx) => {
      await acquireBillingPeriodAdvisoryLock(tx, invoice.billingAccountId, invoice.periodStart);
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "billing_invoices" WHERE "id" = ${invoice.id} FOR UPDATE`;
      if (locked.length === 0) {
        throw new ConflictException({
          code: API_ERROR_CODES.USDC_INVOICE_NOT_PAYABLE,
          message: 'Invoice is no longer payable',
        });
      }
      const fresh = await tx.billingInvoice.findUnique({ where: { id: invoice.id } });
      if (!fresh) {
        throw new ConflictException({
          code: API_ERROR_CODES.USDC_INVOICE_NOT_PAYABLE,
          message: 'Invoice is no longer payable',
        });
      }
      this.assertInvoiceEligible(fresh);
      if (this.planChanges && fresh.purpose === 'plan_charge') {
        await this.planChanges.assertPlanChargePayable(tx, fresh.id);
      }

      // BILL-011 in-lock destination recheck (defer audit — no SIEM under locks).
      if (this.destinationPolicy) {
        await this.destinationPolicy.acquireUserDestinationLock(userId, tx);
        await this.destinationPolicy.assertDestinationsAllowed(
          userId,
          [treasuryAddress],
          { actorType: 'user', chainId: chain },
          { prisma: tx, deferAudit: true },
        );
      } else {
        // Fail closed when the leaf is unavailable (production always wires it).
        await this.assertTreasuryAllowlistReadyDirect(userId, treasuryAddress, chain, tx);
      }

      // After a fixed-fee renewal has already allocated coverage against the
      // finalized invoice, a new USDC quote must only ask for the remaining
      // balance — never the full total again.
      const due = this.remainingDue(fresh);
      const attempt = await tx.billingPaymentAttempt.create({
        data: {
          invoiceId: fresh.id,
          method: 'usdc',
          status: 'pending',
          amountMicros: due,
          currency: fresh.currency,
          chainId: BigInt(chain),
          tokenAddress,
          treasuryAddress,
          tokenDecimals: USDC_DECIMALS,
          expectedBaseUnits: due,
          quoteExpiresAt,
          priceSource: 'usdc_6decimals',
          expectedPayerAddress,
          requiredConfirmations,
          providerIdentity: this.providerIdentity(chain),
        },
      });
      return { invoice: fresh, attempt };
    });
  }

  /**
   * BILL-011 outer preflight: when the expected payer's withdrawal allowlist is
   * enabled, the quote treasury must exist on the allowlist and `availableAt`
   * must already be due. No attempt is created and no quote TTL starts.
   * Policy missing / allowlist disabled → allow-all (existing behavior).
   */
  private async assertQuoteTreasuryDestinationReady(
    userId: string,
    treasuryAddress: string,
    chainId: number,
  ): Promise<void> {
    try {
      if (this.destinationPolicy) {
        await this.destinationPolicy.assertDestinationsAllowed(
          userId,
          [treasuryAddress],
          { actorType: 'user', chainId },
        );
      } else {
        await this.assertTreasuryAllowlistReadyDirect(userId, treasuryAddress, chainId, this.prisma);
      }
    } catch (err) {
      if (err instanceof ForbiddenException) {
        throw await this.enrichDestinationDenialHttp(err, userId, treasuryAddress);
      }
      throw err;
    }
  }

  /**
   * Direct allowlist/cooldown read used when destinationPolicy is absent (tests)
   * or as a fail-closed fallback. Mirrors WithdrawalDestinationPolicyService
   * semantics and always surfaces `availableAt` on cooldown denials.
   */
  private async assertTreasuryAllowlistReadyDirect(
    userId: string,
    treasuryAddress: string,
    chainId: number,
    client: DestinationClient,
  ): Promise<void> {
    let policy: {
      id: string;
      requireAddressAllowlist: boolean;
      newAddressCooldownHours: number;
    } | null;
    try {
      policy = await client.withdrawalPolicy.findUnique({
        where: { userId },
        select: {
          id: true,
          requireAddressAllowlist: true,
          newAddressCooldownHours: true,
        },
      });
    } catch (err) {
      this.logger.error(
        { message: 'USDC quote destination policy lookup failed', userId, chainId },
        err instanceof Error ? err.stack : undefined,
      );
      throw new ServiceUnavailableException({
        code: API_ERROR_CODES.WITHDRAWAL_DESTINATION_POLICY_UNAVAILABLE,
        message: 'Withdrawal destination policy is temporarily unavailable',
      });
    }

    if (!policy || policy.requireAddressAllowlist !== true) {
      return;
    }

    let normalized: string;
    if (!isAddress(treasuryAddress, { strict: false })) {
      throw new ForbiddenException({
        code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED,
        message: 'Withdrawal address is not allowlisted',
      });
    }
    try {
      normalized = getAddress(treasuryAddress).toLowerCase();
    } catch {
      normalized = `0x${treasuryAddress.trim().slice(2).toLowerCase()}`;
    }

    let row: { availableAt: Date } | null;
    try {
      row = await client.withdrawalAddress.findUnique({
        where: { userId_address: { userId, address: normalized } },
        select: { availableAt: true },
      });
    } catch (err) {
      this.logger.error(
        { message: 'USDC quote treasury allowlist lookup failed', userId, chainId },
        err instanceof Error ? err.stack : undefined,
      );
      throw new ServiceUnavailableException({
        code: API_ERROR_CODES.WITHDRAWAL_DESTINATION_POLICY_UNAVAILABLE,
        message: 'Withdrawal destination policy is temporarily unavailable',
      });
    }

    if (!row) {
      throw new ForbiddenException({
        code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_NOT_ALLOWLISTED,
        message: 'Withdrawal address is not allowlisted',
      });
    }

    if (row.availableAt.getTime() > Date.now()) {
      throw new ForbiddenException({
        code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_IN_COOLDOWN,
        message: 'Withdrawal address is still in cooldown',
        availableAt: row.availableAt.toISOString(),
        cooldownHours: policy.newAddressCooldownHours,
      });
    }
  }

  /**
   * Ensures cooldown denials carry a stable ISO `availableAt` for clients even
   * when the destination leaf only put it in audit metadata.
   */
  private async enrichDestinationDenialHttp(
    err: unknown,
    userId: string,
    treasuryAddress: string,
  ): Promise<never> {
    if (!(err instanceof ForbiddenException)) {
      throw err;
    }
    const body = err.getResponse();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw err;
    }
    const record = body as Record<string, unknown>;
    if (record.code !== API_ERROR_CODES.WITHDRAWAL_ADDRESS_IN_COOLDOWN) {
      throw err;
    }
    if (typeof record.availableAt === 'string' && record.availableAt.length > 0) {
      throw err;
    }
    const availableAt = await this.lookupTreasuryAvailableAt(userId, treasuryAddress);
    if (!availableAt) {
      throw err;
    }
    throw new ForbiddenException({
      code: API_ERROR_CODES.WITHDRAWAL_ADDRESS_IN_COOLDOWN,
      message:
        typeof record.message === 'string'
          ? record.message
          : 'Withdrawal address is still in cooldown',
      availableAt,
      ...(typeof record.cooldownHours === 'number' ? { cooldownHours: record.cooldownHours } : {}),
    });
  }

  private async lookupTreasuryAvailableAt(
    userId: string,
    treasuryAddress: string,
    client: DestinationClient = this.prisma,
  ): Promise<string | null> {
    if (!isAddress(treasuryAddress, { strict: false })) return null;
    let normalized: string;
    try {
      normalized = getAddress(treasuryAddress).toLowerCase();
    } catch {
      normalized = `0x${treasuryAddress.trim().slice(2).toLowerCase()}`;
    }
    try {
      const row = await client.withdrawalAddress.findUnique({
        where: { userId_address: { userId, address: normalized } },
        select: { availableAt: true },
      });
      return row?.availableAt ? row.availableAt.toISOString() : null;
    } catch {
      return null;
    }
  }

  /**
   * True when any claim/payment evidence is bound to the attempt — these must
   * never be CAS-expired for requote or rail rotation (BILL-011).
   */
  private hasPaymentEvidence(attempt: PaymentAttemptRow): boolean {
    return (
      attempt.submittedTxHash != null ||
      attempt.txHash != null ||
      attempt.logIndex !== null ||
      attempt.actualBaseUnits !== null ||
      attempt.blockNumber !== null ||
      attempt.blockHash != null ||
      attempt.payerAddress != null ||
      attempt.receiptEvidence != null
    );
  }

  /**
   * Pin an evidence-bearing pending attempt to needs_review so worker/claim
   * recovery can finish it. Never frees the active slot for a fresh quote.
   */
  private async pinPendingWithEvidenceToReview(
    attempt: PaymentAttemptRow,
    expired: boolean,
  ): Promise<void> {
    const reason = attempt.submittedTxHash
      ? expired
        ? 'quote_expired_with_submitted_hash'
        : 'snapshot_incomplete_with_submitted_hash'
      : expired
        ? 'quote_expired_with_evidence'
        : 'snapshot_incomplete_with_evidence';
    await this.prisma.billingPaymentAttempt.updateMany({
      where: {
        id: attempt.id,
        status: 'pending',
        walletPaymentReserved: false,
      },
      data: {
        status: 'needs_review',
        reviewReason: reason,
      },
    });
  }

  /**
   * The amount a USDC quote/claim may still ask for on a finalized invoice:
   * the frozen total when no coverage has been allocated yet (full single-rail
   * behavior preserved), or the remaining balance
   * (`totalMicros - allocatedMicros`) once a fixed-fee renewal has allocated
   * coverage — so an existing fixed-fee allocation is never paid twice.
   */
  private remainingDue(invoice: InvoiceRow): bigint {
    const allocated = invoice.allocatedMicros ?? 0n;
    const remaining = invoice.totalMicros - allocated;
    if (remaining <= 0n) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVOICE_NOT_PAYABLE,
        message: 'Invoice is already fully covered',
      });
    }
    return remaining;
  }

  /**
   * True when an attempt amount is a consistent share of the frozen invoice:
   * exactly the full total when nothing was allocated, or a positive amount
   * that never exceeds the total once fixed-fee coverage was allocated. The
   * persisted quote amount (snapshot) is authoritative for receipt
   * verification; the shared settlement boundary caps coverage at the
   * remaining balance, so an allocation that happened after the quote can
   * never over-allocate the invoice.
   */
  private amountMatchesInvoice(attempt: PaymentAttemptRow, invoice: InvoiceRow): boolean {
    if (attempt.currency !== invoice.currency) return false;
    const allocated = invoice.allocatedMicros ?? 0n;
    if (allocated <= 0n) return attempt.amountMicros === invoice.totalMicros;
    return attempt.amountMicros > 0n && attempt.amountMicros <= invoice.totalMicros;
  }

  /**
   * Resolves the payment chain. The client may pass `chainId` as a verified
   * selector only: it must be in the USDC billing allowlist AND have both a
   * configured treasury and RPC URL. Without a selector, the app's default
   * chain is used when it is a USDC chain, otherwise Base Sepolia (84532).
   */
  private resolveChain(chainId?: number): number {
    const requested = chainId ?? this.defaultUsdcChain();
    if (!USDC_BILLING_CHAIN_IDS.includes(requested as UsdcBillingChainId)) {
      throw new BadRequestException(`USDC billing is not supported on chain ${requested}`);
    }
    const treasury = this.config.get<string>(`billing.usdc.treasuryAddresses.${requested}`);
    const rpc = this.config.get<string>(`billing.usdc.rpcUrls.${requested}`);
    if (!treasury || !rpc) {
      throw new ServiceUnavailableException(`USDC billing is not configured on chain ${requested}`);
    }
    return requested;
  }

  private defaultUsdcChain(): number {
    const defaultChainId = this.config.get<number>('chain.defaultChainId') ?? 84532;
    if (USDC_BILLING_CHAIN_IDS.includes(defaultChainId as UsdcBillingChainId)) {
      return defaultChainId;
    }
    return 84532;
  }

  /** Canonical USDC token address from the supported-chains registry. */
  private canonicalToken(chainId: number): string {
    const chain = getSupportedChain(chainId);
    if (!chain.usdcAddress) {
      throw new ServiceUnavailableException(`USDC is not supported on chain ${chainId}`);
    }
    return chain.usdcAddress;
  }

  private treasury(chainId: number): string {
    const address = this.config.get<string>(`billing.usdc.treasuryAddresses.${chainId}`);
    if (!address) {
      throw new ServiceUnavailableException(`USDC billing is not configured on chain ${chainId}`);
    }
    return address;
  }

  /** The payer is always the invoice owner's SOFA/Openfort user wallet. */
  private async expectedPayer(userId: string): Promise<string> {
    const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
    if (!wallet?.walletAddress || wallet.status !== 'active' || wallet.frozenAt) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_WALLET_NOT_ACTIVE,
        message: 'No active user wallet is available for USDC payment',
      });
    }
    return wallet.walletAddress;
  }

  private requiredConfirmations(): number {
    return this.config.get<number>('billing.usdc.requiredConfirmations') ?? 5;
  }

  private quoteExpiry(): Date {
    const ttl = this.config.get<number>('billing.usdc.quoteTtlSeconds') ?? 86400;
    return new Date(Date.now() + ttl * 1000);
  }

  /**
   * Presence-only snapshot check used by the quote reuse path: a pending
   * attempt without every claim-critical snapshot field can never be claimed,
   * so it is released and re-quoted instead of being reused.
   */
  private hasQuoteSnapshot(attempt: PaymentAttemptRow): boolean {
    return (
      attempt.chainId !== null &&
      attempt.tokenAddress !== null &&
      attempt.treasuryAddress !== null &&
      attempt.tokenDecimals !== null &&
      attempt.expectedBaseUnits !== null &&
      attempt.quoteExpiresAt !== null &&
      attempt.expectedPayerAddress !== null &&
      attempt.requiredConfirmations !== null &&
      attempt.providerIdentity !== null
    );
  }

  /**
   * Every quote snapshot field must be present AND consistent with the
   * server-side allowlist/config before a claim can proceed. The claim path
   * relies on this immutable snapshot — never on the client or on arbitrary
   * current configuration. Any incomplete or inconsistent snapshot fails
   * closed (ConflictException) so a tampered/stale quote can never settle.
   */
  private assertSnapshotComplete(attempt: PaymentAttemptRow, invoice: InvoiceRow): void {
    if (!this.hasQuoteSnapshot(attempt)) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt is missing its USDC quote snapshot',
      });
    }

    const chainId = Number(attempt.chainId);

    // Chain: must be in the USDC billing allowlist.
    if (!USDC_BILLING_CHAIN_IDS.includes(chainId as UsdcBillingChainId)) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt has an unsupported USDC chain',
      });
    }

    // Token: must be the canonical USDC address for the snapshotted chain.
    const canonicalToken = this.canonicalToken(chainId);
    if (attempt.tokenAddress!.toLowerCase() !== canonicalToken.toLowerCase()) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt has a non-canonical USDC token',
      });
    }

    // Treasury: valid EVM address, never the zero address, and consistent with
    // the current per-chain configuration.
    const treasury = attempt.treasuryAddress!.toLowerCase();
    if (!isEthereumAddress(treasury) || treasury === ZERO_ADDRESS) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt has an invalid treasury address',
      });
    }
    const configuredTreasury = this.treasury(chainId);
    if (treasury !== configuredTreasury.toLowerCase()) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt treasury does not match server configuration',
      });
    }

    // Payer: valid EVM address.
    if (!isEthereumAddress(attempt.expectedPayerAddress!.toLowerCase())) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt has an invalid expected payer',
      });
    }

    // Decimals: USDC is exactly 6.
    if (attempt.tokenDecimals !== USDC_DECIMALS) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt has invalid token decimals',
      });
    }

    // Amount: the expected base units must equal the persisted attempt amount
    // (1:1 at 6 decimals), and the amount must be a consistent share of the
    // frozen invoice total — the full total when nothing was allocated yet,
    // or a positive remainder snapshot (never more than the total) once a
    // fixed-fee renewal has allocated coverage.
    if (attempt.expectedBaseUnits !== attempt.amountMicros || attempt.amountMicros <= 0n) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt amount does not match the invoice',
      });
    }
    if (!this.amountMatchesInvoice(attempt, invoice)) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt amount does not match the invoice',
      });
    }

    // Confirmations: at least the product minimum of 5.
    if (attempt.requiredConfirmations! < 5) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt has insufficient required confirmations',
      });
    }

    // Expiry: a valid date.
    if (
      !(attempt.quoteExpiresAt instanceof Date) ||
      Number.isNaN(attempt.quoteExpiresAt.getTime())
    ) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt has an invalid quote expiry',
      });
    }

    // Provider identity: must match the current non-secret RPC identity so an
    // in-flight quote is bound to the operational provider configuration.
    if (attempt.providerIdentity !== this.providerIdentity(chainId)) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt provider configuration has changed; re-quote',
      });
    }
  }

  /**
   * Non-secret identity derived from the per-chain RPC URL. The raw URL (which
   * may embed an API key) is never persisted, logged, or returned; only this
   * digest is stored on the quote snapshot to bind the operational provider.
   */
  private providerIdentity(chainId: number): string {
    const rpcUrl = this.config.get<string>(`billing.usdc.rpcUrls.${chainId}`);
    if (!rpcUrl) {
      throw new ServiceUnavailableException(`USDC billing is not configured on chain ${chainId}`);
    }
    return deriveProviderIdentity(rpcUrl);
  }

  // ── Safe serialization ──────────────────────────────────────────────────────

  private toQuoteResult(invoice: InvoiceRow, attempt: PaymentAttemptRow): UsdcQuoteResult {
    return {
      invoiceId: invoice.id,
      paymentAttemptId: attempt.id,
      chainId: Number(attempt.chainId),
      tokenAddress: attempt.tokenAddress!,
      tokenDecimals: attempt.tokenDecimals!,
      treasuryAddress: attempt.treasuryAddress!,
      expectedPayerAddress: attempt.expectedPayerAddress!,
      amountBaseUnits: attempt.expectedBaseUnits!.toString(),
      amountUsd: microsToDecimalUsd(attempt.expectedBaseUnits!),
      currency: 'USD',
      quoteExpiresAt: attempt.quoteExpiresAt!.toISOString(),
      requiredConfirmations: attempt.requiredConfirmations!,
    };
  }

  private toClaimResult(
    invoice: InvoiceRow,
    attempt: PaymentAttemptRow,
    overrides: Partial<UsdcClaimResult> = {},
  ): UsdcClaimResult {
    return {
      invoiceId: invoice.id,
      paymentAttemptId: attempt.id,
      status: 'pending',
      paid: invoice.paidAt !== null,
      txHash: attempt.txHash ?? null,
      chainId: attempt.chainId !== null ? Number(attempt.chainId) : null,
      confirmations: null,
      requiredConfirmations: attempt.requiredConfirmations ?? null,
      blockNumber: attempt.blockNumber !== null ? attempt.blockNumber.toString() : null,
      blockHash: attempt.blockHash ?? null,
      blockTimestamp: attempt.blockTimestamp !== null ? attempt.blockTimestamp.toString() : null,
      reviewReason: attempt.reviewReason ?? null,
      retryable: false,
      ...overrides,
    };
  }

  /** Safe receipt-evidence subset (never full logs, calldata, or secrets). */
  private buildEvidence(receipt: UsdcReceipt, log: UsdcReceiptLog | null): Prisma.InputJsonValue {
    return {
      status: receipt.status,
      transactionHash: canonicalizeTxHash(receipt.transactionHash),
      from: receipt.from.toLowerCase(),
      to: receipt.to ? receipt.to.toLowerCase() : null,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash.toLowerCase(),
      blockTimestamp:
        typeof receipt.blockTimestamp === 'bigint' ? receipt.blockTimestamp.toString() : null,
      ...(log
        ? {
            logIndex: log.logIndex,
            tokenAddress: log.address.toLowerCase(),
            logData: log.data,
            removed: log.removed,
          }
        : {}),
    };
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Canonicalizes a transaction hash to lowercase. The format (0x + 64 hex) is
 * validated so a malformed hash fails closed; the DTO enforces the same shape
 * at the controller boundary. Every lookup, comparison, persistence, and
 * return value uses the canonical form so client casing can never bypass
 * evidence uniqueness.
 */
function canonicalizeTxHash(hash: string): string {
  if (!TX_HASH_REGEX.test(hash)) {
    throw new BadRequestException('txHash must be a 32-byte hex transaction hash');
  }
  return hash.toLowerCase();
}

/**
 * Non-secret identity derived from an RPC URL. The raw URL (which may embed an
 * API key) is never persisted, logged, or returned; only this sha256 digest is
 * stored on the quote snapshot to bind the operational provider configuration.
 */
function deriveProviderIdentity(rpcUrl: string): string {
  return createHash('sha256').update(rpcUrl).digest('hex');
}

/**
 * Strictly decodes a canonical ERC-20 Transfer log. Topics must be exactly
 * three 32-byte hex values with zero ABI padding on the indexed addresses;
 * data must be a 32-byte uint256. Any deviation is malformed and rejected —
 * never sliced/truncated into an address or amount.
 */
function decodeTransferLog(log: UsdcReceiptLog): DecodedTransfer | null {
  if (!Array.isArray(log.topics) || log.topics.length !== 3) return null;
  const from = parseIndexedAddressStrict(log.topics[1]);
  const to = parseIndexedAddressStrict(log.topics[2]);
  if (!from || !to) return null;
  if (typeof log.data !== 'string' || !UINT256_DATA_REGEX.test(log.data)) return null;
  if (!Number.isSafeInteger(log.logIndex) || log.logIndex < 0) return null;
  return { from, to, amount: BigInt(log.data), logIndex: log.logIndex, log };
}

/**
 * Extracts the 20-byte address from a 32-byte indexed topic, or null when the
 * topic is malformed. ABI address topics are left-padded with 24 zero bytes
 * (48 hex chars): non-zero padding, missing elements, non-strings, and invalid
 * hex are all rejected.
 */
function parseIndexedAddressStrict(topic: unknown): string | null {
  if (typeof topic !== 'string' || !INDEXED_ADDRESS_REGEX.test(topic)) return null;
  if (!/^0x0{24}/.test(topic)) return null;
  return '0x' + topic.slice(-40).toLowerCase();
}

/** Runtime guard for the EVM address shape (defensive; config is pre-validated). */
export function isEthereumAddress(value: unknown): value is string {
  return typeof value === 'string' && EVM_ADDRESS_REGEX.test(value);
}
