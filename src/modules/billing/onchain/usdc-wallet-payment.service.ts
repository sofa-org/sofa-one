import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { encodeFunctionData } from 'viem';
import { AgentStatus } from '../../../common/agent/agent-status';
import { API_ERROR_CODES } from '../../../common/errors/api-error-codes';
import { getErrorText, sanitizeErrorMessage } from '../../../common/utils/sanitize';
import { PrismaService } from '../../../core/database/prisma.service';
import { OpenfortService } from '../../../core/openfort/openfort.service';
import {
  isDeferredDestinationPolicyDenial,
  WithdrawalDestinationPolicyService,
} from '../../withdrawal-destination/withdrawal-destination-policy.service';
import { SessionKeyPolicyService } from '../../session-key/session-key-policy.service';
import { SecurityEventService } from '../../security-events/security-event.service';
import { BillingDebtService } from '../billing-debt.service';
import { acquireBillingPeriodAdvisoryLock } from '../billing-period-lock';
import { UsdcPaymentService, type UsdcClaimResult } from './usdc-payment.service';

type Tx = Prisma.TransactionClient;
type PaymentAttemptRow = Prisma.BillingPaymentAttemptGetPayload<Record<string, never>>;
type InvoiceRow = Prisma.BillingInvoiceGetPayload<Record<string, never>>;

/** Must not start Openfort dispatch when quote expires within this margin. */
export const WALLET_PAYMENT_QUOTE_EXPIRY_SAFETY_MS = 5 * 60 * 1000;

/**
 * B2: executor dispatch lease. While `walletDispatchStartedAt` is within this
 * window and the attempt is still pending without a server-bound hash, workers
 * must not consume the row into needs_review. Bind sets `nextCheckAt` to
 * startedAt + lease so the worker query also skips in-flight work.
 */
export const WALLET_PAYMENT_DISPATCH_LEASE_MS = 10 * 60 * 1000;

/** Backoff after unknown/no-hash reservation before the next recovery tick. */
const WALLET_PAYMENT_RECOVERY_BACKOFF_MS = 15 * 60 * 1000;
const WALLET_PAYMENT_NO_HASH_BACKOFF_MS = 60 * 60 * 1000;

/**
 * B3: prior reviewReason values that may be overwritten to a soft forensic
 * reason (`userop_unattributed` / `awaiting_evidence`). Manual evidence,
 * hash/identity conflicts, and non-wallet reasons are protected.
 */
const WALLET_PAYMENT_SOFT_REVIEW_REASONS = [
  'wallet_payment_userop_unattributed',
  'wallet_payment_awaiting_evidence',
  'wallet_payment_dispatch_unknown',
  'wallet_payment_user_op_hash_missing',
] as const;

const COUNTED_STATUSES = ['submitting', 'pending', 'confirmed', 'unknown'] as const;
const OPERATION_TYPE = 'billing_payment' as const;

/** JSON-safe 202 response — never paid solely from provider acceptance. */
export interface UsdcWalletPayResult {
  invoiceId: string;
  paymentAttemptId: string;
  status: string;
  paid: boolean;
  accepted: boolean;
  reserved: boolean;
  /** True only when this request created the reservation and ran (or will run) dispatch. */
  isExecutor: boolean;
  /**
   * Coarse phase for clients: `paid` only after receipt/settlement;
   * `submitting`/`unknown`/`status` never imply invoice paid.
   */
  phase: 'paid' | 'submitting' | 'unknown' | 'status' | 'accepted';
  chainId: number | null;
  /** Present only when a chain tx hash is already known — never UserOp/provider ids. */
  transactionHash: string | null;
  reviewReason: string | null;
}

type ReserveOutcome = {
  transactionId: string;
  attempt: PaymentAttemptRow;
  /** Creator of this binding in this request — only then may dispatch. */
  isExecutor: boolean;
};

/**
 * Phase 2B: quote-bound dashboard wallet payment.
 *
 * Does NOT call WalletService.withdraw(). Creates a dedicated `billing_payment`
 * Transaction bound 1:1 to a USDC BillingPaymentAttempt under the acceptance
 * lock, then submits a single session-key UserOperation. Invoice paid only via
 * existing receipt/settlement (UsdcPaymentService.claim).
 *
 * Lock order (exact): billing period advisory → payment attempt FOR UPDATE →
 * invoice FOR UPDATE → destination advisory → withdrawal-policy FOR UPDATE →
 * create/bind Transaction + reservation markers → commit. No Openfort/RPC
 * while locks are held.
 */
@Injectable()
export class UsdcWalletPaymentService {
  private readonly logger = new Logger(UsdcWalletPaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly openfort: OpenfortService,
    private readonly usdcPayment: UsdcPaymentService,
    private readonly destinationPolicy: WithdrawalDestinationPolicyService,
    private readonly billingDebt: BillingDebtService,
    private readonly sessionKeyPolicy: SessionKeyPolicyService,
    @Optional() private readonly securityEvents?: SecurityEventService,
  ) {}

  /**
   * POST pay-from-wallet: reserve + dispatch one quote-bound USDC transfer from
   * the user's active platform wallet to the snapshotted treasury.
   *
   * B1: only the reservation creator (`isExecutor`) may dispatch. Concurrent
   * pays and already-bound attempts return status without provider calls.
   * B3: only evidence-free pending quotes may start a new reservation.
   */
  async payFromWallet(
    userId: string,
    invoiceId: string,
    paymentAttemptId: string,
  ): Promise<UsdcWalletPayResult> {
    this.assertUsdcEnabled();

    const invoice = await this.loadOwnedInvoice(userId, invoiceId);
    const attempt = await this.loadOwnedAttempt(invoice, paymentAttemptId);

    // Already reserved/bound → status only (never second dispatch / crash retry).
    if (attempt.walletPaymentReserved && attempt.walletPaymentTransactionId) {
      return this.toPayResult(invoice, attempt, {
        accepted: true,
        isExecutor: false,
        phase: this.phaseFromAttempt(attempt, invoice),
      });
    }

    // B3: refuse quotes that already carry client/server payment evidence.
    this.assertEvidenceFreePendingQuote(attempt);

    await this.preflightOutsideTx(userId, invoice, attempt);

    let reserved: ReserveOutcome;
    try {
      reserved = await this.reserveUnderLocks(userId, invoice, attempt);
    } catch (err) {
      if (isDeferredDestinationPolicyDenial(err)) {
        await this.destinationPolicy.recordDeferredDenial(err);
        throw err.httpException;
      }
      throw err;
    }

    // Concurrent loser / post-rollback bind: status only, no provider.
    if (!reserved.isExecutor) {
      return this.toPayResult(invoice, reserved.attempt, {
        accepted: true,
        isExecutor: false,
        phase: this.phaseFromAttempt(reserved.attempt, invoice),
      });
    }

    // Post-commit executor — only the reservation creator submits once.
    return this.dispatchAndSettle(userId, invoice, reserved.attempt, reserved.transactionId);
  }

  /**
   * GET payment-status: IAM dashboard poll of reserved attempt + binding.
   * Never exposes provider IDs, calldata, or requestHash.
   */
  async getPaymentStatus(
    userId: string,
    invoiceId: string,
    paymentAttemptId: string,
  ): Promise<UsdcWalletPayResult> {
    const invoice = await this.loadOwnedInvoice(userId, invoiceId);
    const attempt = await this.loadOwnedAttempt(invoice, paymentAttemptId);
    return this.toPayResult(invoice, attempt, {
      accepted: attempt.walletPaymentReserved === true,
      isExecutor: false,
      phase: this.phaseFromAttempt(attempt, invoice),
    });
  }

  /**
   * B6/B2: evidence-only recovery for a wallet-payment reservation (worker seam).
   * - Succeeded/paid without marker → idempotent billingReconciledAt repair
   * - In-flight dispatch lease → status only (no needs_review steal)
   * - Known submittedTxHash → claimFromWalletServerBinding (may reopen recoverable review)
   * - UserOp only → forensics; never auto-settle (B3)
   * - No hash → retain reserved/manual needs_review; never re-dispatch
   * Never blind-retries Openfort submit. Never client claim. Never auto-release.
   */
  async recoverReservedPayment(
    userId: string,
    invoiceId: string,
    paymentAttemptId: string,
  ): Promise<UsdcWalletPayResult> {
    this.assertUsdcEnabled();
    const invoice = await this.loadOwnedInvoice(userId, invoiceId);
    const attempt = await this.loadOwnedAttempt(invoice, paymentAttemptId);

    if (!attempt.walletPaymentReserved || !attempt.walletPaymentTransactionId) {
      return this.toPayResult(invoice, attempt, {
        accepted: false,
        isExecutor: false,
        phase: this.phaseFromAttempt(attempt, invoice),
      });
    }

    const boundId = attempt.walletPaymentTransactionId;
    const paymentTx = await this.prisma.transaction.findFirst({
      where: { id: boundId, userId, operationType: OPERATION_TYPE },
    });
    if (!paymentTx) {
      // FK RESTRICT should prevent this; fail closed without releasing.
      return this.toPayResult(invoice, attempt, {
        accepted: true,
        isExecutor: false,
        phase: 'unknown',
      });
    }

    // B2: settlement-marker repair — coverage already settled but crash before
    // billingReconciledAt. Paid means invoice coverage / settlementAttemptId, not
    // merely a non-settling status string.
    const settledByThisAttempt =
      attempt.status === 'succeeded' ||
      (Boolean(invoice.paidAt) && invoice.settlementAttemptId === attempt.id) ||
      invoice.settlementAttemptId === attempt.id;
    if (settledByThisAttempt) {
      const hashForMarker =
        (typeof paymentTx.txHash === 'string' && paymentTx.txHash) ||
        (typeof attempt.submittedTxHash === 'string' && attempt.submittedTxHash) ||
        (typeof attempt.txHash === 'string' && attempt.txHash) ||
        null;
      if (hashForMarker && !paymentTx.txHash) {
        await this.casPersistTrustedSettledTxHash(
          boundId,
          userId,
          hashForMarker.toLowerCase(),
          attempt.id,
        );
      }
      await this.markBoundTransactionReconciled(boundId, userId);
      await this.clearWalletRecoverySchedule(attempt.id);
      const refreshed = await this.prisma.billingPaymentAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
      });
      return this.toPayResult(invoice, refreshed, {
        accepted: true,
        isExecutor: false,
        phase: 'paid',
      });
    }

    // B2: in-flight executor protection — do not steal active dispatch into review.
    if (this.isDispatchLeaseActive(attempt)) {
      return this.toPayResult(invoice, attempt, {
        accepted: true,
        isExecutor: false,
        phase: 'submitting',
      });
    }

    // B3: only explicit attempt.submittedTxHash (claim CAS) may settle.
    // Transaction.txHash from an unattributed UserOp bundle is forensics only.
    const knownHash =
      typeof attempt.submittedTxHash === 'string' ? attempt.submittedTxHash.toLowerCase() : null;

    if (knownHash) {
      try {
        const claim = await this.usdcPayment.claimFromWalletServerBinding(userId, invoiceId, {
          paymentAttemptId: attempt.id,
          txHash: knownHash,
          boundTransactionId: boundId,
        });
        if (claim.paid || claim.status === 'succeeded') {
          // Trusted settlement only — never treat forensic enclosing hash as success.
          await this.casPersistTrustedSettledTxHash(boundId, userId, knownHash, attempt.id);
          await this.markBoundTransactionReconciled(boundId, userId);
          await this.clearWalletRecoverySchedule(attempt.id);
        } else if (claim.status === 'failed' || claim.status === 'expired') {
          await this.clearWalletRecoverySchedule(attempt.id);
        }
        const refreshed = await this.prisma.billingPaymentAttempt.findUniqueOrThrow({
          where: { id: attempt.id },
        });
        return this.claimToPayResult(invoice, refreshed, claim, false);
      } catch (err) {
        this.logger.warn({
          message: 'Wallet payment recovery claim failed — reservation retained',
          paymentAttemptId: attempt.id,
          errorName: err instanceof Error ? err.name : typeof err,
        });
        return this.toPayResult(invoice, attempt, {
          accepted: true,
          isExecutor: false,
          phase: 'unknown',
        });
      }
    }

    // UserOp known but no chain hash yet — evidence query only (no re-submit).
    if (paymentTx.userOpHash) {
      try {
        const chainId = Number(attempt.chainId);
        const receipt = await this.openfort.waitForUserOperationReceipt({
          chainId,
          userOpHash: paymentTx.userOpHash,
        });
        const txHash =
          typeof receipt?.transactionHash === 'string'
            ? receipt.transactionHash.toLowerCase()
            : null;
        // B1/B3: enclosing hash is forensic only. success=false/null never marks
        // execution success; hash may still be stored for ops without settling.
        if (txHash) {
          await this.casPersistForensicTxHash(boundId, userId, txHash, attempt.id, {
            userOpSuccess:
              receipt?.success === true ? true : receipt?.success === false ? false : null,
          });
        }
        // B3: soft reason CAS — never overwrite manual/hash/identity conflicts.
        await this.casSoftReviewReason(
          attempt.id,
          'wallet_payment_userop_unattributed',
          WALLET_PAYMENT_RECOVERY_BACKOFF_MS,
        );
        const refreshed = await this.prisma.billingPaymentAttempt.findUniqueOrThrow({
          where: { id: attempt.id },
        });
        return this.toPayResult(invoice, refreshed, {
          accepted: true,
          isExecutor: false,
          phase: 'unknown',
        });
      } catch (err) {
        this.logger.warn({
          message: 'Wallet payment UserOp recovery failed — reservation retained',
          paymentAttemptId: attempt.id,
          errorName: err instanceof Error ? err.name : typeof err,
        });
        await this.prisma.billingPaymentAttempt.updateMany({
          where: { id: attempt.id, walletPaymentReserved: true },
          data: {
            lastCheckedAt: new Date(),
            nextCheckAt: new Date(Date.now() + WALLET_PAYMENT_RECOVERY_BACKOFF_MS),
          },
        });
        return this.toPayResult(invoice, attempt, {
          accepted: true,
          isExecutor: false,
          phase: 'unknown',
        });
      }
    }

    // No hash at all — manual/unknown; schedule backoff, never re-dispatch.
    // B3: soft reason CAS preserves protected conflict reasons.
    await this.casSoftReviewReason(
      attempt.id,
      attempt.reviewReason?.startsWith('wallet_payment_')
        ? attempt.reviewReason
        : 'wallet_payment_awaiting_evidence',
      WALLET_PAYMENT_NO_HASH_BACKOFF_MS,
    );
    const refreshed = await this.prisma.billingPaymentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    return this.toPayResult(invoice, refreshed, {
      accepted: true,
      isExecutor: false,
      phase: 'unknown',
    });
  }

  /**
   * B2: true while an executor may still be submitting (pending, no hash,
   * dispatch started within lease). Worker recovery must not mutate these.
   */
  private isDispatchLeaseActive(attempt: PaymentAttemptRow): boolean {
    if (attempt.status !== 'pending') return false;
    if (attempt.submittedTxHash || attempt.txHash) return false;
    if (!attempt.walletDispatchStartedAt) return false;
    const started = attempt.walletDispatchStartedAt.getTime();
    return Date.now() - started < WALLET_PAYMENT_DISPATCH_LEASE_MS;
  }

  /**
   * H1/B2: after quote-bound settlement succeeds, mark the bound billing_payment
   * Transaction reconciled so period finalization is not permanently blocked.
   * Unknown/no-hash rows never receive this marker. Idempotent when already set.
   */
  private async markBoundTransactionReconciled(
    transactionId: string,
    userId: string,
  ): Promise<void> {
    await this.prisma.transaction.updateMany({
      where: {
        id: transactionId,
        userId,
        operationType: OPERATION_TYPE,
        billingReconciledAt: null,
        txHash: { not: null },
        status: { in: ['confirmed', 'pending', 'unknown'] },
      },
      data: {
        billingReconciledAt: new Date(),
        status: 'confirmed',
      },
    });
  }

  /** M1: stop worker reselection of terminal reserved attempts. */
  private async clearWalletRecoverySchedule(attemptId: string): Promise<void> {
    await this.prisma.billingPaymentAttempt.updateMany({
      where: { id: attemptId },
      data: { nextCheckAt: null, lastCheckedAt: new Date() },
    });
  }

  // ── Preflight (no locks) ───────────────────────────────────────────────────

  /**
   * B3: new wallet-pay may start only on a clean pending quote — no hash,
   * receipt evidence, or prior wallet reservation.
   */
  private assertEvidenceFreePendingQuote(attempt: PaymentAttemptRow): void {
    if (attempt.walletPaymentReserved || attempt.walletPaymentTransactionId) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
        message: 'Wallet payment reservation already exists for this attempt',
      });
    }
    if (attempt.status !== 'pending') {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Only a pending USDC quote can start wallet payment',
      });
    }
    if (attempt.submittedTxHash || attempt.txHash || attempt.logIndex !== null) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt already has payment evidence; cannot start wallet payment',
      });
    }
    if (attempt.actualBaseUnits !== null || attempt.blockNumber !== null || attempt.blockHash) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt already has payment evidence; cannot start wallet payment',
      });
    }
  }

  private async preflightOutsideTx(
    userId: string,
    invoice: InvoiceRow,
    attempt: PaymentAttemptRow,
  ): Promise<void> {
    // B5: full claim-grade snapshot (chain/token/treasury/provider/amount/…).
    this.usdcPayment.assertWalletPayQuoteExecutable(attempt, invoice);
    this.assertExpirySafety(attempt);
    await this.assertUsageDebtRule(userId, invoice);
    await this.assertPayerWalletReady(userId, attempt);
    // Outer destination check (immediate audit on deny).
    if (!attempt.treasuryAddress) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt quote is incomplete',
      });
    }
    await this.destinationPolicy.assertDestinationsAllowed(userId, [attempt.treasuryAddress], {
      actorType: 'user',
      chainId: Number(attempt.chainId),
      walletId: undefined,
    });
    await this.assertDailyAndSingleLimits(
      userId,
      Number(attempt.chainId!),
      attempt.expectedBaseUnits!,
      this.prisma,
    );
  }

  // ── Atomic acceptance ──────────────────────────────────────────────────────

  /**
   * Interactive TX: locks → create billing_payment row → bind reservation → commit.
   *
   * B8: never catch create/CHECK/FK errors and continue querying on the same
   * interactive client (PostgreSQL aborts the TX). Only P2002 (unique race) is
   * recovered **after** `$transaction` rolls back, via the root Prisma client.
   * Uncertain/partial bindings are never returned for dispatch.
   */
  private async reserveUnderLocks(
    userId: string,
    invoice: InvoiceRow,
    attempt: PaymentAttemptRow,
  ): Promise<ReserveOutcome> {
    const idempotencyKey = `billing_payment:${attempt.id}`;

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1) billing period advisory
        await acquireBillingPeriodAdvisoryLock(tx, invoice.billingAccountId, invoice.periodStart);

        // 2) payment attempt FOR UPDATE
        const lockedAttemptRows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "billing_payment_attempts" WHERE "id" = ${attempt.id}::uuid FOR UPDATE`;
        if (lockedAttemptRows.length === 0) {
          throw new NotFoundException('Payment attempt not found');
        }
        const lockedAttempt = await tx.billingPaymentAttempt.findUniqueOrThrow({
          where: { id: attempt.id },
        });

        // Idempotent under lock: another request already bound — not executor.
        if (lockedAttempt.walletPaymentReserved && lockedAttempt.walletPaymentTransactionId) {
          return {
            transactionId: lockedAttempt.walletPaymentTransactionId,
            attempt: lockedAttempt,
            isExecutor: false,
          };
        }
        if (lockedAttempt.walletPaymentReserved) {
          throw new ConflictException({
            code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
            message: 'Wallet payment reservation is already in progress',
          });
        }

        // B1: under attempt FOR UPDATE — still pending + evidence-free (client claim
        // may have first-written hash after outer preflight). confirming/evidence
        // is never bindable.
        this.assertEvidenceFreePendingQuote(lockedAttempt);

        // 3) invoice FOR UPDATE
        const lockedInvoiceRows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "billing_invoices" WHERE "id" = ${invoice.id}::uuid FOR UPDATE`;
        if (lockedInvoiceRows.length === 0) {
          throw new ConflictException({
            code: API_ERROR_CODES.USDC_INVOICE_NOT_PAYABLE,
            message: 'Invoice is no longer payable',
          });
        }
        const freshInvoice = await tx.billingInvoice.findUniqueOrThrow({
          where: { id: invoice.id },
        });

        this.usdcPayment.assertWalletPayQuoteExecutable(lockedAttempt, freshInvoice);
        this.assertExpirySafety(lockedAttempt);
        await this.assertUsageDebtRule(userId, freshInvoice, tx);
        const wallet = await this.assertPayerWalletReady(userId, lockedAttempt, tx);

        if (!lockedAttempt.treasuryAddress || lockedAttempt.expectedBaseUnits == null) {
          throw new ConflictException({
            code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
            message: 'Payment attempt quote is incomplete',
          });
        }
        const chainId = Number(lockedAttempt.chainId);
        const amount = lockedAttempt.expectedBaseUnits;
        const treasury = lockedAttempt.treasuryAddress;

        // 4) destination advisory + policy (defer audit — no root SIEM under locks)
        await this.destinationPolicy.acquireUserDestinationLock(userId, tx);
        await this.destinationPolicy.assertDestinationsAllowed(
          userId,
          [treasury],
          {
            actorType: 'user',
            chainId,
            walletId: wallet.id,
          },
          { prisma: tx, deferAudit: true },
        );

        // 5) withdrawal-limit policy row lock + daily/single limits
        await tx.$executeRaw`
          SELECT id FROM withdrawal_policies WHERE user_id = ${userId}::uuid FOR UPDATE`;
        await this.assertDailyAndSingleLimits(userId, chainId, amount, tx);

        // 6) create billing_payment Transaction + bind reservation (no in-TX recovery)
        const requestHash = this.walletPaymentRequestHash({
          userId,
          attemptId: lockedAttempt.id,
          invoiceId: freshInvoice.id,
          chainId,
          treasury,
          amount,
          tokenAddress: lockedAttempt.tokenAddress ?? '',
          expectedPayer: lockedAttempt.expectedPayerAddress ?? '',
        });

        const createdAt = new Date();
        const billingPeriodStart = new Date(
          Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), 1),
        );

        // Any CHECK/FK/unique failure aborts the interactive TX — do not catch
        // and query further on `tx`. P2002 is handled after rollback below.
        const paymentTx = await tx.transaction.create({
          data: {
            userId,
            apiKeyId: null,
            authMethod: 'iam',
            apiKeyPrefix: null,
            apiKeyName: null,
            status: 'submitting',
            chainId: BigInt(chainId),
            walletAddress: wallet.walletAddress!,
            operationType: OPERATION_TYPE,
            idempotencyKey,
            requestHash,
            createdAt,
            billingPeriodStart,
            details: {
              type: OPERATION_TYPE,
              execution: 'calibur_agent_user_operation',
              executionMode: 'session_key',
              token: 'USDC',
              amount: amount.toString(),
              to: treasury.toLowerCase(),
              tokenAddress: lockedAttempt.tokenAddress,
              paymentAttemptId: lockedAttempt.id,
              invoiceId: freshInvoice.id,
              quoteExpiresAt: lockedAttempt.quoteExpiresAt?.toISOString() ?? null,
              requiredConfirmations: lockedAttempt.requiredConfirmations,
            } as Prisma.InputJsonValue,
          },
        });

        const dispatchAt = new Date();
        const bind = await tx.billingPaymentAttempt.updateMany({
          where: {
            id: lockedAttempt.id,
            walletPaymentTransactionId: null,
            status: { in: ['pending', 'confirming'] },
          },
          data: {
            walletPaymentTransactionId: paymentTx.id,
            walletPaymentReserved: true,
            walletDispatchStartedAt: dispatchAt,
            // B2: schedule recovery only after dispatch lease — worker must not
            // steal in-flight executor rows (nextCheckAt null would match early).
            nextCheckAt: new Date(dispatchAt.getTime() + WALLET_PAYMENT_DISPATCH_LEASE_MS),
          },
        });
        if (bind.count === 0) {
          // Concurrent binder won under lock — only return a complete binding.
          const refreshed = await tx.billingPaymentAttempt.findUniqueOrThrow({
            where: { id: lockedAttempt.id },
          });
          if (refreshed.walletPaymentReserved && refreshed.walletPaymentTransactionId) {
            return {
              transactionId: refreshed.walletPaymentTransactionId,
              attempt: refreshed,
              isExecutor: false,
            };
          }
          throw new ConflictException({
            code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
            message: 'Wallet payment reservation could not be bound',
          });
        }

        const refreshed = await tx.billingPaymentAttempt.findUniqueOrThrow({
          where: { id: lockedAttempt.id },
        });
        // This request created the Transaction and won the bind CAS → executor.
        return { transactionId: paymentTx.id, attempt: refreshed, isExecutor: true };
      });
    } catch (err) {
      // After full interactive TX rollback only — root client, never aborted tx.
      if (this.isUniqueConstraintError(err)) {
        return this.resolveReservationAfterUniqueRace(userId, attempt, idempotencyKey);
      }
      throw err;
    }
  }

  /**
   * Post-rollback P2002 recovery: load existing billing_payment row + attempt
   * binding on the root client. Only returns a fully reserved binding; never
   * invents a partial reservation for dispatch.
   */
  private async resolveReservationAfterUniqueRace(
    userId: string,
    attempt: PaymentAttemptRow,
    idempotencyKey: string,
  ): Promise<ReserveOutcome> {
    const current = await this.prisma.billingPaymentAttempt.findUnique({
      where: { id: attempt.id },
    });
    if (current?.walletPaymentReserved && current.walletPaymentTransactionId) {
      return {
        transactionId: current.walletPaymentTransactionId,
        attempt: current,
        isExecutor: false,
      };
    }

    const chainId =
      attempt.chainId !== null && attempt.chainId !== undefined ? Number(attempt.chainId) : null;
    if (chainId === null) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
        message: 'Wallet payment reservation race could not be resolved',
      });
    }

    const existing = await this.prisma.transaction.findFirst({
      where: {
        userId,
        operationType: OPERATION_TYPE,
        chainId: BigInt(chainId),
        idempotencyKey,
      },
    });
    if (!existing) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
        message: 'Wallet payment reservation race could not be resolved',
      });
    }

    // CAS-bind only when still unbound and active — never overwrite another binding.
    const bound = await this.prisma.billingPaymentAttempt.updateMany({
      where: {
        id: attempt.id,
        walletPaymentTransactionId: null,
        walletPaymentReserved: false,
        status: { in: ['pending', 'confirming'] },
      },
      data: {
        walletPaymentTransactionId: existing.id,
        walletPaymentReserved: true,
        walletDispatchStartedAt: existing.createdAt,
        nextCheckAt: new Date(
          (existing.createdAt?.getTime?.() ?? Date.now()) + WALLET_PAYMENT_DISPATCH_LEASE_MS,
        ),
      },
    });

    const refreshed = await this.prisma.billingPaymentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    if (refreshed.walletPaymentReserved && refreshed.walletPaymentTransactionId) {
      // P2002 recovery never dispatches — creator already owns or will own crash recovery later.
      return {
        transactionId: refreshed.walletPaymentTransactionId,
        attempt: refreshed,
        isExecutor: false,
      };
    }
    if (bound.count === 0) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
        message: 'Wallet payment reservation could not be bound after race',
      });
    }
    return { transactionId: existing.id, attempt: refreshed, isExecutor: false };
  }

  private walletPaymentRequestHash(parts: {
    userId: string;
    attemptId: string;
    invoiceId: string;
    chainId: number;
    treasury: string;
    amount: bigint;
    tokenAddress: string;
    expectedPayer: string;
  }): string {
    return createHash('sha256')
      .update(
        [
          parts.userId,
          parts.attemptId,
          parts.invoiceId,
          String(parts.chainId),
          parts.treasury.toLowerCase(),
          parts.amount.toString(),
          parts.tokenAddress,
          parts.expectedPayer,
        ].join('|'),
      )
      .digest('hex');
  }

  private isUniqueConstraintError(err: unknown): boolean {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return err.code === 'P2002';
    }
    return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
  }

  // ── Post-commit dispatch ───────────────────────────────────────────────────

  private async dispatchAndSettle(
    userId: string,
    invoice: InvoiceRow,
    attempt: PaymentAttemptRow,
    transactionId: string,
  ): Promise<UsdcWalletPayResult> {
    const paymentTx = await this.prisma.transaction.findFirst({
      where: { id: transactionId, userId, operationType: OPERATION_TYPE },
    });
    if (!paymentTx) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_WALLET_PAYMENT_RESERVED,
        message: 'Wallet payment binding is missing',
      });
    }

    // Already has chain hash — settle via server binding path only (never client claim).
    if (paymentTx.txHash) {
      const claim = await this.usdcPayment.claimFromWalletServerBinding(userId, invoice.id, {
        paymentAttemptId: attempt.id,
        txHash: paymentTx.txHash,
        boundTransactionId: transactionId,
      });
      if (claim.paid) {
        await this.markBoundTransactionReconciled(transactionId, userId);
        await this.clearWalletRecoverySchedule(attempt.id);
      }
      return this.claimToPayResult(invoice, attempt, claim, true);
    }
    if (paymentTx.status === 'confirmed' || paymentTx.status === 'unknown') {
      return this.toPayResult(invoice, attempt, {
        accepted: true,
        isExecutor: true,
        phase: paymentTx.status === 'unknown' ? 'unknown' : 'status',
      });
    }
    // UserOp already observed but no chain hash — retain; never blind re-dispatch.
    if (paymentTx.userOpHash && paymentTx.status !== 'submitting') {
      return this.toPayResult(invoice, attempt, {
        accepted: true,
        isExecutor: true,
        phase: 'unknown',
      });
    }

    // B5: re-check immutable quote + expiry immediately before provider.
    const freshInvoice = await this.loadOwnedInvoice(userId, invoice.id);
    const freshAttempt = await this.loadOwnedAttempt(freshInvoice, attempt.id);
    try {
      this.usdcPayment.assertWalletPayQuoteExecutable(freshAttempt, freshInvoice);
      this.assertExpirySafety(freshAttempt);
    } catch (err) {
      await this.markUnknownReservation(transactionId, attempt.id, 'quote_no_longer_executable');
      throw err;
    }

    // B4: reload payer identity post-commit; freeze/address/agent drift → no submit.
    let wallet;
    try {
      wallet = await this.assertPayerWalletReady(userId, freshAttempt);
    } catch (err) {
      await this.markUnknownReservation(transactionId, attempt.id, 'payer_identity_changed');
      throw err;
    }

    const chainId = Number(freshAttempt.chainId);
    const tokenAddress = freshAttempt.tokenAddress as `0x${string}`;
    const treasury = freshAttempt.treasuryAddress as `0x${string}`;
    const amount = freshAttempt.expectedBaseUnits!;

    try {
      await this.sessionKeyPolicy.assertSessionKeyAllowed({
        userId,
        walletId: wallet.id,
        chainId,
        accountAddress: wallet.walletAddress!,
        keyHash: wallet.agentKeyHash!,
        operation: 'send_transaction',
      });
    } catch (err) {
      await this.markUnknownReservation(transactionId, attempt.id, 'session_key_policy_denied');
      throw err;
    }

    // B4: final expiry safety immediately before provider (after session/RPC-free work).
    try {
      const preSubmit = await this.prisma.billingPaymentAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
      });
      this.assertExpirySafety(preSubmit);
    } catch {
      await this.markUnknownReservation(transactionId, attempt.id, 'quote_expiry_before_dispatch');
      const refreshed = await this.prisma.billingPaymentAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
      });
      return this.toPayResult(invoice, refreshed, {
        accepted: true,
        isExecutor: true,
        phase: 'unknown',
      });
    }

    const interaction = {
      to: tokenAddress,
      data: encodeFunctionData({
        abi: [
          {
            inputs: [
              { name: 'to', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
            name: 'transfer',
            outputs: [{ type: 'bool' }],
            type: 'function',
          },
        ],
        functionName: 'transfer',
        args: [treasury, amount],
      }),
      value: '0',
    };

    let observedUserOpHash: string | null = paymentTx.userOpHash ?? null;
    try {
      const submitted = await this.openfort.submitUserOperation({
        chainId,
        agentAccountId: wallet.agentOpenfortAccountId!,
        accountAddress: wallet.walletAddress!,
        keyHash: wallet.agentKeyHash!,
        interactions: [interaction],
        onUserOperationHash: async (userOpHash) => {
          observedUserOpHash = userOpHash;
          await this.casPersistUserOpHash(transactionId, userId, userOpHash, attempt.id);
        },
      });

      observedUserOpHash = submitted.userOpHash ?? observedUserOpHash;
      if (observedUserOpHash) {
        await this.casPersistUserOpHash(transactionId, userId, observedUserOpHash, attempt.id);
      }

      if (!observedUserOpHash) {
        await this.markUnknownReservation(transactionId, attempt.id, 'user_op_hash_missing');
        const refreshed = await this.prisma.billingPaymentAttempt.findUniqueOrThrow({
          where: { id: attempt.id },
        });
        return this.toPayResult(invoice, refreshed, {
          accepted: true,
          isExecutor: true,
          phase: 'unknown',
        });
      }

      // B1/B3: no trusted UserOp→Transfer attribution. Enclosing hash is forensic
      // only — never confirmed/userOpSuccess=true unless receipt.success===true,
      // and even then never auto-settle/pay from UserOp alone.
      try {
        const receipt = await this.openfort.waitForUserOperationReceipt({
          chainId,
          userOpHash: observedUserOpHash,
        });
        const observedTxHash =
          typeof receipt?.transactionHash === 'string'
            ? receipt.transactionHash.toLowerCase()
            : null;
        if (observedTxHash) {
          await this.casPersistForensicTxHash(transactionId, userId, observedTxHash, attempt.id, {
            userOpSuccess:
              receipt?.success === true ? true : receipt?.success === false ? false : null,
          });
        }
      } catch {
        // Receipt wait failure still leaves UserOp hash + reservation for manual recovery.
      }

      await this.markUnknownReservation(
        transactionId,
        attempt.id,
        'userop_unattributed',
        observedUserOpHash,
      );
      const refreshed = await this.prisma.billingPaymentAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
      });
      return this.toPayResult(invoice, refreshed, {
        accepted: true,
        isExecutor: true,
        phase: 'unknown',
      });
    } catch (err) {
      this.logger.error(
        {
          message: 'Wallet payment dispatch unknown outcome — retaining reservation',
          invoiceId: invoice.id,
          paymentAttemptId: attempt.id,
          transactionId,
          hasUserOpHash: Boolean(observedUserOpHash),
        },
        err instanceof Error ? err.stack : undefined,
      );
      await this.markUnknownReservation(
        transactionId,
        attempt.id,
        'dispatch_unknown',
        observedUserOpHash,
      );
      const refreshed = await this.prisma.billingPaymentAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
      });
      return this.toPayResult(invoice, refreshed, {
        accepted: true,
        isExecutor: true,
        phase: 'unknown',
      });
    }
  }

  /** B1: UserOp hash CAS — null once, or identical replay; different hash → unknown. */
  private async casPersistUserOpHash(
    transactionId: string,
    userId: string,
    userOpHash: string,
    attemptId: string,
  ): Promise<void> {
    const matched = await this.prisma.transaction.updateMany({
      where: {
        id: transactionId,
        userId,
        status: { in: ['submitting', 'unknown', 'pending'] },
        OR: [{ userOpHash: null }, { userOpHash }],
      },
      data: { userOpHash, status: 'pending', completedAt: null },
    });
    if (matched.count > 0) return;
    const row = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (row?.userOpHash && row.userOpHash !== userOpHash) {
      await this.markUnknownReservation(
        transactionId,
        attemptId,
        'user_op_hash_conflict',
        row.userOpHash,
      );
    }
  }

  /**
   * B1: forensic enclosing-bundle hash only. Never marks execution success:
   * status stays unresolved (`unknown`), `userOpSuccess` is only true when the
   * UserOp receipt explicitly reports success, `completedAt` stays null so
   * daily-limit / cross-day unresolved accounting still counts the reservation.
   * Does not settle or pay.
   */
  private async casPersistForensicTxHash(
    transactionId: string,
    userId: string,
    txHash: string,
    attemptId: string,
    opts: { userOpSuccess: boolean | null } = { userOpSuccess: null },
  ): Promise<{ ok: boolean }> {
    const matched = await this.prisma.transaction.updateMany({
      where: {
        id: transactionId,
        userId,
        operationType: OPERATION_TYPE,
        status: { in: ['submitting', 'pending', 'unknown'] },
        OR: [{ txHash: null }, { txHash }],
      },
      data: {
        txHash,
        status: 'unknown',
        // success=false/null must never become true; only explicit true is stored.
        userOpSuccess:
          opts.userOpSuccess === true ? true : opts.userOpSuccess === false ? false : null,
        completedAt: null,
        failureReason: 'wallet_payment_forensic_enclosing_hash',
      },
    });
    if (matched.count > 0) return { ok: true };
    const row = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (row?.txHash && row.txHash.toLowerCase() !== txHash.toLowerCase()) {
      await this.markUnknownReservation(
        transactionId,
        attemptId,
        'tx_hash_conflict',
        row.userOpHash,
      );
      return { ok: false };
    }
    return { ok: row?.txHash?.toLowerCase() === txHash.toLowerCase() };
  }

  /**
   * Trusted post-settlement hash binding only (after quote-bound claim paid).
   * Distinct from forensic enclosing-hash storage.
   */
  private async casPersistTrustedSettledTxHash(
    transactionId: string,
    userId: string,
    txHash: string,
    attemptId: string,
  ): Promise<{ ok: boolean }> {
    const matched = await this.prisma.transaction.updateMany({
      where: {
        id: transactionId,
        userId,
        operationType: OPERATION_TYPE,
        authMethod: 'iam',
        apiKeyId: null,
        status: { in: ['submitting', 'pending', 'unknown', 'confirmed'] },
        OR: [{ txHash: null }, { txHash }],
      },
      data: {
        txHash,
        status: 'confirmed',
        userOpSuccess: true,
        completedAt: new Date(),
        failureReason: null,
      },
    });
    if (matched.count > 0) return { ok: true };
    const row = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (row?.txHash && row.txHash.toLowerCase() !== txHash.toLowerCase()) {
      await this.markUnknownReservation(
        transactionId,
        attemptId,
        'tx_hash_conflict',
        row.userOpHash,
      );
      return { ok: false };
    }
    return { ok: row?.txHash?.toLowerCase() === txHash.toLowerCase() };
  }

  /**
   * B3: write a soft wallet_payment_* review reason only when prior reason is
   * absent or already soft. Never overwrites hash/identity/manual conflicts.
   */
  private async casSoftReviewReason(
    attemptId: string,
    reviewReason: string,
    backoffMs: number,
  ): Promise<void> {
    const reason = reviewReason.slice(0, 255);
    await this.prisma.billingPaymentAttempt.updateMany({
      where: {
        id: attemptId,
        walletPaymentReserved: true,
        status: { in: ['pending', 'confirming', 'needs_review'] },
        OR: [
          { reviewReason: null },
          { reviewReason: { in: [...WALLET_PAYMENT_SOFT_REVIEW_REASONS] } },
        ],
      },
      data: {
        status: 'needs_review',
        reviewReason: reason,
        lastCheckedAt: new Date(),
        nextCheckAt: new Date(Date.now() + backoffMs),
      },
    });
    // Always bump schedule for protected-conflict rows so worker backs off.
    await this.prisma.billingPaymentAttempt.updateMany({
      where: {
        id: attemptId,
        walletPaymentReserved: true,
        status: 'needs_review',
        reviewReason: { notIn: [...WALLET_PAYMENT_SOFT_REVIEW_REASONS, reason] },
      },
      data: {
        lastCheckedAt: new Date(),
        nextCheckAt: new Date(Date.now() + backoffMs),
      },
    });
  }

  private async markUnknownReservation(
    transactionId: string,
    attemptId: string,
    reason: string,
    userOpHash?: string | null,
  ): Promise<void> {
    await this.prisma.transaction.updateMany({
      where: {
        id: transactionId,
        // Forensic hash may already be present — still move unresolved → unknown.
        status: { in: ['submitting', 'pending', 'unknown'] },
      },
      data: {
        status: 'unknown',
        failureReason: reason.slice(0, 500),
        // Never invent execution success on unknown reservation.
        // Leave existing userOpSuccess as-is when already false; only clear true.
        completedAt: null,
        ...(userOpHash ? { userOpHash } : {}),
      },
    });
    // Explicitly clear accidental success markers without requiring a second path.
    await this.prisma.transaction.updateMany({
      where: {
        id: transactionId,
        status: 'unknown',
        userOpSuccess: true,
        billingReconciledAt: null,
      },
      data: { userOpSuccess: null, completedAt: null },
    });
    // Keep attempt active/reserved — never auto-release. Soft reason only when
    // prior status is still pending/confirming (B3: needs_review conflicts stay).
    await this.prisma.billingPaymentAttempt.updateMany({
      where: {
        id: attemptId,
        walletPaymentReserved: true,
        status: { in: ['pending', 'confirming'] },
      },
      data: {
        status: 'needs_review',
        reviewReason: `wallet_payment_${reason}`.slice(0, 255),
        lastCheckedAt: new Date(),
        nextCheckAt: new Date(Date.now() + WALLET_PAYMENT_RECOVERY_BACKOFF_MS),
      },
    });
  }

  // ── Guards / helpers ───────────────────────────────────────────────────────

  private assertUsdcEnabled(): void {
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

  private async loadOwnedAttempt(
    invoice: InvoiceRow,
    paymentAttemptId: string,
  ): Promise<PaymentAttemptRow> {
    const attempt = await this.prisma.billingPaymentAttempt.findFirst({
      where: { id: paymentAttemptId, invoiceId: invoice.id, method: 'usdc' },
    });
    if (!attempt) {
      throw new NotFoundException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt not found',
      });
    }
    return attempt;
  }

  private assertExpirySafety(attempt: PaymentAttemptRow): void {
    const expires = attempt.quoteExpiresAt;
    if (!expires) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment attempt quote is incomplete',
      });
    }
    const remainingMs = expires.getTime() - Date.now();
    if (remainingMs <= 0) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payment quote has expired',
      });
    }
    if (remainingMs <= WALLET_PAYMENT_QUOTE_EXPIRY_SAFETY_MS) {
      throw new BadRequestException({
        code: API_ERROR_CODES.USDC_QUOTE_EXPIRY_TOO_SOON,
        message: 'Payment quote expires too soon to start wallet payment',
      });
    }
  }

  private async assertUsageDebtRule(
    userId: string,
    invoice: InvoiceRow,
    db: Tx | PrismaService = this.prisma,
  ): Promise<void> {
    const debt = await this.billingDebt.getDebt(userId, db as Tx);
    if (debt.hasDebt && invoice.purpose !== 'usage_period') {
      throw new ForbiddenException({
        code: API_ERROR_CODES.USDC_WALLET_USAGE_DEBT_ONLY,
        message: 'While usage debt exists, only usage invoices may be paid from wallet',
      });
    }
  }

  private async assertPayerWalletReady(
    userId: string,
    attempt: PaymentAttemptRow,
    db: Tx | PrismaService = this.prisma,
  ) {
    // Resolve by both owner and the immutable quote payer snapshot. A user's
    // current/default wallet may have changed since quote creation.
    const wallets = await db.userWallet.findMany({ where: { userId } });
    const payer = attempt.expectedPayerAddress?.toLowerCase();
    const payerMatches = payer
      ? wallets.filter((candidate) => candidate.walletAddress?.toLowerCase() === payer)
      : [];
    const wallet = payerMatches.length === 1 ? payerMatches[0] : undefined;
    if (wallets.length > 0 && (!payer || payerMatches.length !== 1)) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payer wallet no longer matches quote snapshot',
      });
    }
    // B4: UserWallet.frozenAt is authoritative for wallet freeze (not only User).
    if (
      !wallet ||
      wallet.status !== 'active' ||
      wallet.frozenAt != null ||
      !wallet.walletAddress ||
      !wallet.agentOpenfortAccountId ||
      !wallet.agentKeyHash
    ) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_WALLET_NOT_ACTIVE,
        message:
          wallet?.frozenAt != null
            ? 'Wallet is frozen'
            : 'Active wallet required for wallet payment',
      });
    }
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { frozenAt: true },
    });
    if (user?.frozenAt) {
      throw new ForbiddenException('User is frozen');
    }
    if (!payer || wallet.walletAddress.toLowerCase() !== payer) {
      throw new ConflictException({
        code: API_ERROR_CODES.USDC_INVALID_ATTEMPT,
        message: 'Payer wallet no longer matches quote snapshot',
      });
    }
    const chainId = Number(attempt.chainId);
    const auth = await db.walletChainAuthorization.findFirst({
      where: {
        walletId: wallet.id,
        chainId: BigInt(chainId),
        status: AgentStatus.Registered,
      },
    });
    if (!auth || !auth.expiresAt || auth.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('API access is not authorized for this chain');
    }
    return wallet;
  }

  private async assertDailyAndSingleLimits(
    userId: string,
    chainId: number,
    amount: bigint,
    db: Tx | PrismaService,
  ): Promise<void> {
    const policy = await db.withdrawalPolicy.findUnique({ where: { userId } });
    const singleLimit = this.parsePositiveLimit(
      policy?.singleWithdrawalLimit,
      10_000_000_000n, // default USDC max base units (matches wallet default)
    );
    if (amount > singleLimit) {
      throw new ForbiddenException('Withdrawal amount exceeds single-withdrawal limit');
    }
    if (!policy?.dailyWithdrawalLimit) return;
    const dailyLimit = this.parsePositiveLimit(policy.dailyWithdrawalLimit, null);
    const dayStart = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
    );
    // Continuous: unresolved active reservations count across day boundaries.
    const UNRESOLVED = ['submitting', 'pending', 'unknown'] as const;
    const [dayBounded, unresolved] = await Promise.all([
      db.transaction.findMany({
        where: {
          userId,
          operationType: { in: ['withdraw', OPERATION_TYPE] },
          chainId: BigInt(chainId),
          status: { in: [...COUNTED_STATUSES] },
          createdAt: { gte: dayStart },
          details: { path: ['token'], equals: 'USDC' },
        },
        select: { id: true, details: true },
      }),
      db.transaction.findMany({
        where: {
          userId,
          operationType: { in: ['withdraw', OPERATION_TYPE] },
          chainId: BigInt(chainId),
          status: { in: [...UNRESOLVED] },
          createdAt: { lt: dayStart },
          details: { path: ['token'], equals: 'USDC' },
        },
        select: { id: true, details: true },
      }),
    ]);
    const seen = new Set<string>();
    let usedToday = 0n;
    for (const row of [...dayBounded, ...unresolved]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      usedToday += this.extractAmount(row.details);
    }
    if (usedToday + amount > dailyLimit) {
      throw new ForbiddenException('Withdrawal amount exceeds daily withdrawal limit');
    }
  }

  private parsePositiveLimit(value: string | null | undefined, fallback: bigint | null): bigint {
    if (!value) {
      if (fallback !== null) return fallback;
      throw new BadRequestException('Withdrawal policy dailyWithdrawalLimit is not configured');
    }
    try {
      const parsed = BigInt(value);
      if (parsed <= 0n) throw new Error('non-positive');
      return parsed;
    } catch {
      throw new BadRequestException('Withdrawal policy limit is invalid');
    }
  }

  private extractAmount(details: unknown): bigint {
    if (!details || typeof details !== 'object' || Array.isArray(details)) return 0n;
    const amount = (details as { amount?: unknown }).amount;
    if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return 0n;
    return BigInt(amount);
  }

  private phaseFromAttempt(
    attempt: PaymentAttemptRow,
    invoice: InvoiceRow,
  ): UsdcWalletPayResult['phase'] {
    if (Boolean(invoice.paidAt) || attempt.status === 'succeeded') return 'paid';
    if (attempt.status === 'needs_review' || attempt.reviewReason?.startsWith('wallet_payment_')) {
      return 'unknown';
    }
    if (attempt.walletPaymentReserved && !attempt.submittedTxHash && !attempt.txHash) {
      return 'submitting';
    }
    if (attempt.submittedTxHash || attempt.txHash) return 'status';
    return attempt.walletPaymentReserved ? 'accepted' : 'status';
  }

  private toPayResult(
    invoice: InvoiceRow,
    attempt: PaymentAttemptRow,
    opts: {
      accepted: boolean;
      isExecutor: boolean;
      phase?: UsdcWalletPayResult['phase'];
    },
  ): UsdcWalletPayResult {
    const paid = Boolean(invoice.paidAt) || attempt.status === 'succeeded';
    return {
      invoiceId: invoice.id,
      paymentAttemptId: attempt.id,
      status: attempt.status,
      paid,
      accepted: opts.accepted,
      reserved: attempt.walletPaymentReserved === true,
      isExecutor: opts.isExecutor,
      phase: opts.phase ?? (paid ? 'paid' : this.phaseFromAttempt(attempt, invoice)),
      chainId:
        attempt.chainId !== null && attempt.chainId !== undefined ? Number(attempt.chainId) : null,
      transactionHash: attempt.txHash ?? attempt.submittedTxHash ?? null,
      reviewReason: attempt.reviewReason ?? null,
    };
  }

  private claimToPayResult(
    invoice: InvoiceRow,
    attempt: PaymentAttemptRow,
    claim: UsdcClaimResult,
    isExecutor: boolean,
  ): UsdcWalletPayResult {
    return {
      invoiceId: invoice.id,
      paymentAttemptId: attempt.id,
      status: claim.status,
      paid: claim.paid,
      accepted: true,
      reserved: true,
      isExecutor,
      phase: claim.paid ? 'paid' : claim.status === 'needs_review' ? 'unknown' : 'status',
      chainId: claim.chainId,
      transactionHash: claim.txHash,
      reviewReason: claim.reviewReason,
    };
  }

  private async auditWalletPay(
    userId: string,
    invoiceId: string,
    paymentAttemptId: string,
    claim: UsdcClaimResult,
  ): Promise<void> {
    if (!this.securityEvents) return;
    if (
      claim.status !== 'succeeded' &&
      claim.status !== 'needs_review' &&
      claim.status !== 'failed'
    ) {
      return;
    }
    try {
      await this.securityEvents.record({
        actorType: 'user',
        userId,
        eventType: 'billing.usdc.wallet_payment',
        riskLevel: claim.status === 'succeeded' ? 'low' : 'high',
        result: claim.status === 'succeeded' ? 'allowed' : 'denied',
        reason: claim.reviewReason ?? claim.status,
        metadata: {
          invoiceId,
          paymentAttemptId,
          status: claim.status,
        },
      });
    } catch (error) {
      this.logger.error(
        `Wallet payment audit failed: ${sanitizeErrorMessage(getErrorText(error))}`,
      );
    }
  }
}
