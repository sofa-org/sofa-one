import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import {
  OpenfortService,
  type SanitizedReceipt,
  type SanitizedReceiptLog,
} from '../../core/openfort/openfort.service';
import { BillingService, type ReceiptUsageEvidence } from './billing.service';
import { evaluatePricing } from './billing-pricing';
import { SUPPORTED_CHAINS } from '../../common/chains/supported-chains';
import { sanitizeErrorMessage } from '../../common/utils/sanitize';

/** ERC-20 `Transfer(address,address,uint256)` topic0. */
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** A uint256 amount is exactly 32 bytes (64 hex chars) after the 0x prefix. */
const AMOUNT_DATA_REGEX = /^0x[0-9a-fA-F]{64}$/;
/** An indexed address topic is exactly 32 bytes (64 hex chars) after 0x. */
const INDEXED_ADDRESS_REGEX = /^0x[0-9a-fA-F]{64}$/;
/** A token contract address is exactly 20 bytes (40 hex chars) after 0x. */
const TOKEN_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

type TransactionRow = {
  id: string;
  userId: string;
  chainId: bigint;
  txHash: string | null;
  walletAddress: string;
  operationType: string | null;
  status: string;
  details: Prisma.JsonValue | null;
  /** Optional for defensive highWaterMark derivation (mocks may omit it). */
  createdAt?: Date;
};

export interface ReconcileResult {
  runId: string;
  scanned: number;
  notFound: number;
  transientError: number;
  reverted: number;
  posted: number;
  quarantined: number;
  updated: number;
  skipped: number;
  errors: number;
  conflicts: number;
  replayed: number;
  casNoops: number;
}

type Summary = {
  scanned: number;
  notFound: number;
  transientError: number;
  reverted: number;
  posted: number;
  quarantined: number;
  updated: number;
  skipped: number;
  errors: number;
  conflicts: number;
  replayed: number;
  casNoops: number;
};

/**
 * Receipt-confirmed outbound reconciliation (Commercial Billing Phase 1D).
 *
 * Scans persisted Transaction rows that carry a txHash and are still in a
 * non-final state, fetches a sanitized receipt via OpenfortService, and appends
 * evidence-backed `posted`/`quarantined` ledger events through
 * BillingService.recordSuccessfulOutbound. Metering is idempotent on the
 * deterministic sourceKey / receipt-component unique index, so re-scanning
 * confirmed rows is safe and concurrent workers cannot double-count.
 *
 * This is a protected internal trigger seam (dashboard-only), not a public
 * API-key route, and never schedules itself.
 */
@Injectable()
export class BillingReconciliationService {
  private readonly logger = new Logger(BillingReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly openfort: OpenfortService,
    private readonly billing: BillingService,
  ) {}

  async reconcile(userId: string, opts: { limit?: number } = {}): Promise<ReconcileResult> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const summary: Summary = {
      scanned: 0,
      notFound: 0,
      transientError: 0,
      reverted: 0,
      posted: 0,
      quarantined: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      conflicts: 0,
      replayed: 0,
      casNoops: 0,
    };

    // Operational grouping month for this scan. This is NOT the receipt
    // accounting period: posted events derive their own periodStart from the
    // receipt block timestamp's UTC month.
    const operationalPeriodStart = this.monthStart(new Date());

    // Run creation uses the shared billing-period lock seam so invoice
    // finalization and the creation of a `running` reconciliation run cannot
    // pass each other. The run is created inside the provided transaction
    // client.
    const run = await this.billing.withBillingPeriodLock(
      userId,
      operationalPeriodStart,
      async (tx) =>
        tx.billingReconciliationRun.create({
          data: {
            status: 'running',
            runType: 'receipt_outbound',
            periodStart: operationalPeriodStart,
            source: 'openfort_receipt',
          },
        }),
    );

    try {
      const candidates = await this.selectCandidates(userId, limit);

      summary.scanned = candidates.length;

      // A candidate with missing/invalid createdAt cannot prove the high-water
      // contract; surface it as a safe error so the run is never treated as
      // clean exhaustive.
      const invalidCreatedAtCount = candidates.filter((c) => !isValidCreatedAt(c.createdAt)).length;
      if (invalidCreatedAtCount > 0) {
        summary.errors += invalidCreatedAtCount;
        this.logger.warn(
          `Reconciliation found ${invalidCreatedAtCount} candidate(s) with missing/invalid createdAt for user ${userId}`,
        );
      }

      // Deterministic scan-boundary evidence: the true max (createdAt, id)
      // across ALL selected candidates — never the last row in priority order.
      // Never BigInt, logs, calldata, or secrets.
      const highWaterMark = this.buildHighWaterMark(candidates);
      const accountingPeriods = this.buildAccountingPeriods(candidates);

      for (const tx of candidates) {
        try {
          await this.processTransaction(userId, tx, summary, run.id);
        } catch (error) {
          if (error instanceof ConflictException) {
            summary.conflicts++;
          } else {
            summary.errors++;
          }
          this.logger.error(
            `Reconciliation failed for transaction ${tx.id}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }

      const complete = this.isCompleteRun(summary, candidates.length, limit, invalidCreatedAtCount);
      const persistedSummary = this.buildPersistedSummary(
        summary,
        userId,
        complete,
        highWaterMark,
        accountingPeriods,
      );

      await this.prisma.billingReconciliationRun.update({
        where: { id: run.id },
        data: { status: 'completed', completedAt: new Date(), summary: persistedSummary as any },
      });
    } catch (error) {
      // A failed run is never complete; userId/complete are still persisted.
      const persistedSummary = this.buildPersistedSummary(summary, userId, false, null, []);
      await this.prisma.billingReconciliationRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          completedAt: new Date(),
          errorDetails: sanitizeErrorMessage(
            error instanceof Error ? error.message : String(error),
          ),
          summary: persistedSummary as any,
        },
      });
      throw error;
    }

    return { runId: run.id, ...summary };
  }

  /**
   * JSON-safe persisted summary: all existing counters plus the completion
   * marker (`userId`, `complete`, `highWaterMark`) and the `accountingPeriods`
   * this scan's candidates may affect (UTC month-start strings derived from
   * candidate createdAt). `highWaterMark` is always present — null for an empty
   * candidate set or when no valid candidate exists. Never serializes BigInt,
   * receipt logs, calldata, API keys, or provider objects.
   */
  private buildPersistedSummary(
    summary: Summary,
    userId: string,
    complete: boolean,
    highWaterMark: { createdAt: string; id: string } | null,
    accountingPeriods: string[],
  ): Record<string, unknown> {
    return {
      ...summary,
      userId,
      complete,
      highWaterMark,
      accountingPeriods,
    };
  }

  /**
   * UTC month-start strings for the accounting periods this scan's candidates
   * MAY affect, derived from candidate createdAt. This is scan-coverage
   * metadata only — it is NOT proof of the receipt block timestamp's accounting
   * month (a cross-month pending transaction may be mined in a later month).
   * The billing consumer treats missing/malformed coverage as conservatively
   * risky and never uses createdAt-derived coverage to clear unresolved risk.
   * Sorted and deduplicated; empty for an empty set.
   */
  private buildAccountingPeriods(candidates: TransactionRow[]): string[] {
    const periods = new Set<string>();
    for (const candidate of candidates) {
      if (!isValidCreatedAt(candidate.createdAt)) continue;
      periods.add(this.monthStart(candidate.createdAt).toISOString());
    }
    return [...periods].sort();
  }

  /**
   * A run is complete only when the bounded candidate scan is truly exhausted
   * (`candidates.length < limit`), every selected candidate has a valid
   * createdAt (the high-water contract is provable), and there are no
   * retryable/error/conflict counters. A limit-filled run is never complete
   * even without errors.
   */
  private isCompleteRun(
    summary: Summary,
    candidatesLength: number,
    limit: number,
    invalidCreatedAtCount: number,
  ): boolean {
    return (
      candidatesLength < limit &&
      invalidCreatedAtCount === 0 &&
      summary.notFound === 0 &&
      summary.transientError === 0 &&
      summary.errors === 0 &&
      summary.conflicts === 0
    );
  }

  /**
   * True max `(createdAt, id)` across ALL selected candidates — never the last
   * row in pending-first/confirmed-fill priority order. createdAt is compared
   * by UTC time (ISO strings sort chronologically), ties broken by the
   * lexicographically largest id. Candidates with missing/invalid createdAt are
   * skipped here (they are surfaced separately as a completeness error).
   */
  private buildHighWaterMark(
    candidates: TransactionRow[],
  ): { createdAt: string; id: string } | null {
    let best: { createdAt: string; id: string } | null = null;
    for (const candidate of candidates) {
      if (!isValidCreatedAt(candidate.createdAt)) continue;
      const key = { createdAt: candidate.createdAt.toISOString(), id: candidate.id };
      if (!best || compareHighWaterMark(key, best) > 0) best = key;
    }
    return best;
  }

  /**
   * Deterministic two-stage candidate selection so a large backlog of confirmed
   * rows can never starve new pending/submitting/unknown transactions.
   * Non-confirmed candidates are scanned first (createdAt/id asc); if fewer
   * than `limit` remain, confirmed rows fill the rest (same sort, excluding ids
   * already selected). Total is at most `limit`.
   */
  private async selectCandidates(userId: string, limit: number): Promise<TransactionRow[]> {
    const nonConfirmed = await this.prisma.transaction.findMany({
      where: {
        userId,
        txHash: { not: null },
        operationType: { in: ['send', 'withdraw'] },
        status: { in: ['submitting', 'pending', 'unknown'] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });

    if (nonConfirmed.length >= limit) return nonConfirmed;

    const confirmed = await this.prisma.transaction.findMany({
      where: {
        userId,
        txHash: { not: null },
        operationType: { in: ['send', 'withdraw'] },
        status: 'confirmed',
        id: { notIn: nonConfirmed.map((tx) => tx.id) },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit - nonConfirmed.length,
    });

    return [...nonConfirmed, ...confirmed];
  }

  private async processTransaction(
    userId: string,
    tx: TransactionRow,
    summary: Summary,
    runId: string,
  ): Promise<void> {
    const chainId = Number(tx.chainId);
    const txHash = tx.txHash!;

    // A persisted chain no longer in the supported config can never be priced.
    if (!SUPPORTED_CHAINS[chainId]) {
      const outcome = await this.quarantine(
        userId,
        tx,
        {
          sourceKey: `tx:${tx.id}:unsupported_chain`,
          receiptRef: `${txHash}:unsupported_chain`,
          receiptLogIndex: null,
          periodStart: this.monthStart(new Date()),
          occurredAt: new Date(),
          assetId: null,
          receipt: {
            txHash,
            receiptRef: `${txHash}:unsupported_chain`,
            receiptLogIndex: null,
            receiptBlockNumber: 0n,
            receiptBlockHash: '',
            receiptBlockTimestamp: 0n,
            receiptStatus: 'unknown',
            receiptData: { txHash, chainId: tx.chainId.toString() },
            reconciledAt: new Date(),
          },
          metadata: { reason: 'unsupported_chain' },
        },
        runId,
      );
      if (outcome === 'replayed') summary.replayed++;
      else summary.quarantined++;
      return;
    }

    const result = await this.openfort.getTransactionReceipt(chainId, txHash);

    if (result.status === 'not_found') {
      summary.notFound++;
      return; // keep pending, retryable
    }
    if (result.status === 'error') {
      summary.transientError++;
      return; // keep pending, retryable
    }

    const receipt = result.receipt;

    // txHash must match the receipt's transactionHash (case-insensitive).
    if (receipt.transactionHash.toLowerCase() !== txHash.toLowerCase()) {
      // Receipt evidence mismatch: never meter, never confirm. Surface as a
      // conflict with safe diagnostic info (no calldata/secrets).
      summary.conflicts++;
      this.logger.warn(
        `Receipt txHash mismatch for transaction ${tx.id}: expected ${txHash}, got ${receipt.transactionHash}`,
      );
      return;
    }

    // A reverted receipt is never metered.
    if (result.status === 'reverted') {
      const count = await this.markReverted(tx, receipt);
      if (count > 0) summary.reverted++;
      else summary.casNoops++;
      return;
    }

    // success
    const blockDate = this.blockDate(receipt);
    const periodStart = this.monthStart(blockDate);

    const details = (tx.details ?? {}) as Record<string, unknown>;
    const isBackendEoa = details.execution === 'backend_eoa' || details.executionMode === 'eoa';

    // EOA sends must originate from the transaction's wallet address. A sender
    // mismatch is quarantined (zero volume) and never marks the tx confirmed.
    if (isBackendEoa && receipt.from.toLowerCase() !== tx.walletAddress.toLowerCase()) {
      const outcome = await this.quarantine(
        userId,
        tx,
        {
          sourceKey: `tx:${tx.id}:eoa_sender_mismatch`,
          receiptRef: `${receipt.transactionHash}:eoa_sender_mismatch`,
          receiptLogIndex: null,
          periodStart,
          occurredAt: blockDate,
          assetId: null,
          receipt: this.buildReceiptEvidence(
            receipt,
            null,
            `${receipt.transactionHash}:eoa_sender_mismatch`,
          ),
          metadata: {
            reason: 'eoa_sender_mismatch',
            expectedSender: tx.walletAddress,
            actualSender: receipt.from,
          },
        },
        runId,
      );
      if (outcome === 'replayed') summary.replayed++;
      else summary.quarantined++;
      return; // never meter, never mark confirmed
    }

    const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
    const walletAddresses = new Set<string>();
    if (wallet?.walletAddress) walletAddresses.add(wallet.walletAddress.toLowerCase());
    walletAddresses.add(tx.walletAddress.toLowerCase());

    const isNativeWithdrawal =
      tx.operationType === 'withdraw' &&
      (details.token === 'NATIVE' || details.contractAddress === null);

    if (isNativeWithdrawal) {
      const outcome = await this.quarantine(
        userId,
        tx,
        {
          sourceKey: `tx:${tx.id}:native`,
          receiptRef: `${receipt.transactionHash}:native`,
          receiptLogIndex: null,
          periodStart,
          occurredAt: blockDate,
          assetId: null,
          receipt: this.buildReceiptEvidence(receipt, null, `${receipt.transactionHash}:native`),
          metadata: {
            reason: 'native_asset',
            amount:
              typeof details.amount === 'string' ? details.amount : String(details.amount ?? ''),
          },
        },
        runId,
      );
      if (outcome === 'replayed') summary.replayed++;
      else summary.quarantined++;
    }

    // Process each wallet-originated ERC-20 Transfer log independently. The
    // runtime shape of receipt.logs is never trusted: a non-array is a safe
    // error outcome and never reaches a for...of.
    if (!Array.isArray(receipt.logs)) {
      summary.errors++;
      this.logger.warn(`Receipt logs is not an array for transaction ${tx.id}`);
      return; // malformed receipt: never confirm
    }

    for (let i = 0; i < receipt.logs.length; i++) {
      const outcome = await this.processLog(
        userId,
        tx,
        receipt,
        receipt.logs[i],
        walletAddresses,
        periodStart,
        blockDate,
        runId,
        i,
      );
      if (outcome === 'posted') summary.posted++;
      else if (outcome === 'quarantined') summary.quarantined++;
      else if (outcome === 'replayed') summary.replayed++;
    }

    // Metering append happened before the status update; duplicates are
    // swallowed by the sourceKey / receipt-component unique index. A count of 0
    // means a concurrent worker already moved the row — count as a CAS no-op.
    const count = await this.markConfirmed(tx, receipt);
    if (count > 0) summary.updated++;
    else summary.casNoops++;
  }

  private async processLog(
    userId: string,
    tx: TransactionRow,
    receipt: SanitizedReceipt,
    log: unknown,
    walletAddresses: Set<string>,
    periodStart: Date,
    blockDate: Date,
    runId: string,
    arrayIndex: number,
  ): Promise<'posted' | 'quarantined' | 'replayed' | 'skipped'> {
    const parsed = parseReceiptLog(log, arrayIndex);

    // A valid non-Transfer log is unrelated and safely ignored.
    if (parsed.kind === 'not_transfer') return 'skipped';

    if (parsed.kind === 'invalid') {
      if (parsed.reason === 'invalid_log_index') {
        // No canonical sourceKey can be built from a malformed log index. Use a
        // deterministic safe identity based on the receipt log array index so
        // multiple malformed logs stay individually diagnosable.
        const sourceKey = `tx:${tx.id}:log:invalid:${parsed.arrayIndex}`;
        const receiptRef = `${receipt.transactionHash}:log:invalid:${parsed.arrayIndex}`;
        return this.quarantine(
          userId,
          tx,
          {
            sourceKey,
            receiptRef,
            receiptLogIndex: null,
            periodStart,
            occurredAt: blockDate,
            assetId: null,
            receipt: this.buildReceiptEvidence(receipt, null, receiptRef),
            metadata: { reason: 'invalid_log_index' },
          },
          runId,
        );
      }

      // Malformed topic/address/data with a valid log index: quarantine with
      // the canonical component identity.
      const sourceKey = `tx:${tx.id}:log:${parsed.logIndex}`;
      const receiptRef = `${receipt.transactionHash}:log:${parsed.logIndex}`;
      return this.quarantine(
        userId,
        tx,
        {
          sourceKey,
          receiptRef,
          receiptLogIndex: parsed.logIndex,
          periodStart,
          occurredAt: blockDate,
          assetId: null,
          receipt: this.buildReceiptEvidence(receipt, null, receiptRef),
          metadata: { reason: 'incomplete_log' },
        },
        runId,
      );
    }

    // parsed.kind === 'transfer'
    const { from, amount, logIndex, address, data, removed, topics } = parsed;
    const evidenceLog: SanitizedReceiptLog = {
      address,
      topics,
      data,
      logIndex,
      removed,
    };

    // Shape validation happens before removed handling: a valid removed log is
    // quarantined (zero volume). If existing posted evidence conflicts, the
    // BillingService ConflictException bubbles up and the tx is never confirmed.
    if (removed) {
      const sourceKey = `tx:${tx.id}:log:${logIndex}`;
      const receiptRef = `${receipt.transactionHash}:log:${logIndex}`;
      return this.quarantine(
        userId,
        tx,
        {
          sourceKey,
          receiptRef,
          receiptLogIndex: logIndex,
          periodStart,
          occurredAt: blockDate,
          assetId: address,
          receipt: this.buildReceiptEvidence(receipt, evidenceLog, receiptRef),
          metadata: { reason: 'removed_log' },
        },
        runId,
      );
    }

    // Only wallet-originated (outbound) logs are counted.
    if (!walletAddresses.has(from)) return 'skipped';

    const sourceKey = `tx:${tx.id}:log:${logIndex}`;
    const receiptRef = `${receipt.transactionHash}:log:${logIndex}`;

    const pricing = evaluatePricing({
      chainId: Number(tx.chainId),
      tokenAddress: address,
      amountBaseUnits: amount,
      observedAt: blockDate,
    });

    if (pricing.status === 'priced') {
      const outcome = await this.billing.recordSuccessfulOutbound({
        userId,
        transactionId: tx.id,
        sourceKey,
        status: 'posted',
        periodStart,
        occurredAt: blockDate,
        amountUsdMicros: BigInt(pricing.amountUsdMicros),
        chainId: tx.chainId,
        walletAddress: tx.walletAddress,
        assetId: pricing.tokenAddress,
        assetDecimals: pricing.tokenDecimals,
        baseUnitAmount: amount,
        unitPriceMicros: BigInt(pricing.priceUsdMicros),
        priceSource: pricing.priceSource,
        receipt: this.buildReceiptEvidence(receipt, evidenceLog, receiptRef),
        metadata: { policyVersion: pricing.policyVersion },
        reconciliationRunId: runId,
      });
      return outcome.outcome === 'replayed' ? 'replayed' : 'posted';
    }

    return this.quarantine(
      userId,
      tx,
      {
        sourceKey,
        receiptRef,
        receiptLogIndex: logIndex,
        periodStart,
        occurredAt: blockDate,
        assetId: pricing.tokenAddress ?? null,
        receipt: this.buildReceiptEvidence(receipt, evidenceLog, receiptRef),
        metadata: { reason: pricing.reason, ...(pricing.details ?? {}) },
      },
      runId,
    );
  }

  private async quarantine(
    userId: string,
    tx: TransactionRow,
    opts: {
      sourceKey: string;
      receiptRef: string;
      receiptLogIndex: number | null;
      periodStart: Date;
      occurredAt: Date;
      assetId?: string | null;
      receipt: ReceiptUsageEvidence;
      metadata: Record<string, unknown>;
    },
    reconciliationRunId: string,
  ): Promise<'quarantined' | 'replayed'> {
    const outcome = await this.billing.recordSuccessfulOutbound({
      userId,
      transactionId: tx.id,
      sourceKey: opts.sourceKey,
      status: 'quarantined',
      periodStart: opts.periodStart,
      occurredAt: opts.occurredAt,
      amountUsdMicros: 0n,
      chainId: tx.chainId,
      walletAddress: tx.walletAddress,
      assetId: opts.assetId ?? null,
      receipt: opts.receipt,
      metadata: opts.metadata,
      reconciliationRunId,
    });
    return outcome.outcome === 'replayed' ? 'replayed' : 'quarantined';
  }

  private buildReceiptEvidence(
    receipt: SanitizedReceipt,
    log: SanitizedReceiptLog | null,
    receiptRef: string,
  ): ReceiptUsageEvidence {
    return {
      txHash: receipt.transactionHash,
      receiptRef,
      receiptLogIndex: log?.logIndex ?? null,
      receiptBlockNumber: receipt.blockNumber,
      receiptBlockHash: receipt.blockHash,
      receiptBlockTimestamp: receipt.blockTimestamp,
      receiptStatus: receipt.status,
      receiptData: {
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        status: receipt.status,
        blockTimestamp: receipt.blockTimestamp.toString(),
        from: receipt.from,
        to: receipt.to,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: receipt.effectiveGasPrice?.toString() ?? null,
        ...(log ? { logIndex: log.logIndex, tokenAddress: log.address, logData: log.data } : {}),
      },
      reconciledAt: new Date(),
    };
  }

  private blockDate(receipt: SanitizedReceipt): Date {
    return new Date(Number(receipt.blockTimestamp) * 1000);
  }

  private async markReverted(tx: TransactionRow, receipt: SanitizedReceipt): Promise<number> {
    // Preserve safe receipt evidence (hash/block/status/timestamp/reconciledAt;
    // never logs or calldata) in the same CAS update that marks the transaction
    // failed. A reverted receipt is never metered. Returns the number of rows
    // actually updated (0 = a concurrent worker already moved the row).
    const receiptDetails = {
      receipt: {
        hash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        status: receipt.status,
        timestamp: receipt.blockTimestamp.toString(),
        reconciledAt: new Date().toISOString(),
      },
    };
    const result = await this.prisma.transaction.updateMany({
      where: { id: tx.id, status: { in: ['submitting', 'pending', 'confirmed', 'unknown'] } },
      data: {
        status: 'failed',
        failureReason: 'receipt_reverted',
        completedAt: new Date(),
        details: { ...((tx.details as Record<string, unknown>) ?? {}), ...receiptDetails } as any,
      },
    });
    return result.count;
  }

  private async markConfirmed(tx: TransactionRow, receipt: SanitizedReceipt): Promise<number> {
    const receiptDetails = {
      receipt: {
        hash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        status: receipt.status,
        timestamp: receipt.blockTimestamp.toString(),
        reconciledAt: new Date().toISOString(),
      },
    };
    const result = await this.prisma.transaction.updateMany({
      where: { id: tx.id, status: { in: ['submitting', 'pending', 'confirmed', 'unknown'] } },
      data: {
        status: 'confirmed',
        completedAt: new Date(),
        details: { ...((tx.details as Record<string, unknown>) ?? {}), ...receiptDetails } as any,
      },
    });
    return result.count;
  }

  private monthStart(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }
}

type ParsedLogResult =
  | {
      kind: 'transfer';
      from: string;
      to: string;
      amount: bigint;
      logIndex: number;
      address: string;
      data: string;
      removed: boolean;
      topics: string[];
      arrayIndex: number;
    }
  | { kind: 'not_transfer' }
  | {
      kind: 'invalid';
      reason: 'invalid_log_index' | 'incomplete_log';
      logIndex: number | null;
      arrayIndex: number;
    };

/**
 * Runtime-validated parsing of a single receipt log. The TypeScript shape of
 * SanitizedReceiptLog is never trusted: providers/tests may return arbitrary
 * values at runtime. Every field is validated before use so no TypeError can
 * escape (topics[0], topics.length, logIndex, address, data, ...).
 */
function parseReceiptLog(log: unknown, arrayIndex: number): ParsedLogResult {
  if (typeof log !== 'object' || log === null) {
    return { kind: 'invalid', reason: 'incomplete_log', logIndex: null, arrayIndex };
  }
  const l = log as Record<string, unknown>;

  // logIndex must be a non-negative safe integer (number | bigint | decimal
  // string). Invalid/missing indexes never enter a canonical sourceKey.
  const logIndex = parseLogIndex(l.logIndex);
  if (logIndex === null) {
    return { kind: 'invalid', reason: 'invalid_log_index', logIndex: null, arrayIndex };
  }

  const removed = l.removed === true;

  // topics must be an array with at least 3 elements.
  if (!Array.isArray(l.topics) || l.topics.length < 3) {
    return { kind: 'invalid', reason: 'incomplete_log', logIndex, arrayIndex };
  }

  // topic0 must be exactly 32-byte hex; only the ERC-20 Transfer topic enters
  // Transfer parsing. A valid non-Transfer topic is safely ignored.
  const topic0 = l.topics[0];
  if (typeof topic0 !== 'string' || !INDEXED_ADDRESS_REGEX.test(topic0)) {
    return { kind: 'invalid', reason: 'incomplete_log', logIndex, arrayIndex };
  }
  if (topic0.toLowerCase() !== TRANSFER_TOPIC0) {
    return { kind: 'not_transfer' };
  }

  // topics[1]/topics[2] must be strictly 0x+64 hex with zero ABI padding.
  const from = parseIndexedAddressStrict(l.topics[1]);
  const to = parseIndexedAddressStrict(l.topics[2]);
  if (!from || !to) {
    return { kind: 'invalid', reason: 'incomplete_log', logIndex, arrayIndex };
  }

  // log.address must be strictly 20-byte hex.
  if (typeof l.address !== 'string' || !TOKEN_ADDRESS_REGEX.test(l.address)) {
    return { kind: 'invalid', reason: 'incomplete_log', logIndex, arrayIndex };
  }

  // data must be strictly 0x+64 hex uint256; parsed with BigInt, never Number.
  if (typeof l.data !== 'string' || !AMOUNT_DATA_REGEX.test(l.data)) {
    return { kind: 'invalid', reason: 'incomplete_log', logIndex, arrayIndex };
  }
  const amount = BigInt(l.data);

  return {
    kind: 'transfer',
    from,
    to,
    amount,
    logIndex,
    address: l.address,
    data: l.data,
    removed,
    topics: [topic0, l.topics[1] as string, l.topics[2] as string],
    arrayIndex,
  };
}

/**
 * Parses a log index that may arrive as a number, bigint, or decimal string.
 * Returns a non-negative safe integer or null when invalid.
 */
function parseLogIndex(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'bigint') {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

/**
 * Extracts the 20-byte address from a 32-byte indexed topic, or null when the
 * topic is malformed. ABI address topics are left-padded with 24 zero bytes
 * (48 hex chars): non-zero padding, missing elements, non-strings, and invalid
 * hex are all rejected — never sliced/truncated into an address.
 */
function parseIndexedAddressStrict(topic: unknown): string | null {
  if (typeof topic !== 'string' || !INDEXED_ADDRESS_REGEX.test(topic)) return null;
  if (!/^0x0{24}/.test(topic)) return null;
  return '0x' + topic.slice(-40).toLowerCase();
}

/** True when `value` is a parseable Date (never NaN). */
function isValidCreatedAt(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * Compares two high-water keys. createdAt ISO strings sort chronologically for
 * UTC; ties are broken by the lexicographically largest id.
 */
function compareHighWaterMark(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
