import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { BillingService } from './billing.service';
import { BillingReconciliationService } from './billing-reconciliation.service';

jest.mock('../../core/openfort/openfort.service', () => ({
  OpenfortService: class OpenfortService {},
}));

import { OpenfortService } from '../../core/openfort/openfort.service';

const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AGENT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER = '0xcccccccccccccccccccccccccccccccccccccccc';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDT_BASE = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2';
const TX_HASH = '0x1111111111111111111111111111111111111111111111111111111111111111';
const BLOCK_HASH = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

// 2026-08-01T00:00:00Z — the default target period start for the specs.
const PERIOD_START = new Date('2026-08-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-09-01T00:00:00.000Z');

function paddedAddress(address: string): string {
  return '0x' + '0'.repeat(24) + address.slice(2).toLowerCase();
}

function amountData(amount: bigint): string {
  return '0x' + amount.toString(16).padStart(64, '0');
}

function transferLog(overrides: Record<string, unknown> = {}) {
  return {
    address: USDC_BASE,
    topics: [TRANSFER_TOPIC0, paddedAddress(WALLET), paddedAddress(OTHER)],
    data: amountData(1_000_000n),
    logIndex: 0,
    removed: false,
    ...overrides,
  };
}

function successReceipt(logs: unknown[] = [transferLog()]) {
  return {
    status: 'success',
    transactionHash: TX_HASH,
    from: WALLET,
    to: null,
    blockNumber: 12345n,
    blockHash: BLOCK_HASH,
    // 2026-08-10T00:00:00Z — inside the pricing policy window
    blockTimestamp: 1_786_320_000n,
    gasUsed: 100_000n,
    effectiveGasPrice: 1_000_000_000n,
    logs,
  };
}

function txRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    userId: 'user-1',
    chainId: 8453n,
    txHash: TX_HASH,
    walletAddress: WALLET,
    operationType: 'send',
    status: 'pending',
    userOpSuccess: true,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    details: {
      type: 'send',
      execution: 'calibur_agent_user_operation',
      executionMode: 'session_key',
    },
    ...overrides,
  };
}

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

describe('BillingReconciliationService', () => {
  let service: BillingReconciliationService;

  const runCreate = jest.fn();
  const runFindFirst = jest.fn();
  const runFindUnique = jest.fn();
  const runUpdateMany = jest.fn();
  const txFindMany = jest.fn();
  const txCount = jest.fn();
  const walletFindUnique = jest.fn();
  const txUpdateMany = jest.fn();
  const txUpdate = jest.fn();
  const getReceipt = jest.fn();
  const waitForUserOperationReceipt = jest.fn();
  const recordSuccessfulOutbound = jest.fn();
  const withBillingPeriodLock = jest.fn();

  /** Stub the fair two-stage candidate queries: non-confirmed first, confirmed fill. */
  function mockCandidates(nonConfirmed: unknown[], confirmed: unknown[] = []) {
    txFindMany.mockResolvedValueOnce(nonConfirmed).mockResolvedValue(confirmed);
  }

  function expectNoTransactionStateMutation() {
    const mutations = txUpdateMany.mock.calls.filter(([args]) =>
      Object.keys((args as { data?: Record<string, unknown> }).data ?? {})
        .some((key) => key !== 'billingLastAttemptedAt'),
    );
    expect(mutations).toHaveLength(0);
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingReconciliationService,
        {
          provide: PrismaService,
          useValue: {
            billingReconciliationRun: {
              create: runCreate,
              findFirst: runFindFirst,
              findUnique: runFindUnique,
              updateMany: runUpdateMany,
            },
            transaction: { findMany: txFindMany, count: txCount, updateMany: txUpdateMany, update: txUpdate },
            userWallet: { findUnique: walletFindUnique },
            $transaction: async (work: (db: unknown) => Promise<unknown>) =>
              work({
                billingReconciliationRun: { updateMany: runUpdateMany },
                transaction: { updateMany: txUpdateMany },
              }),
          },
        },
        {
          provide: OpenfortService,
          useValue: { getTransactionReceipt: getReceipt, waitForUserOperationReceipt },
        },
        {
          provide: BillingService,
          useValue: {
            recordSuccessfulOutbound: recordSuccessfulOutbound,
            withBillingPeriodLock: withBillingPeriodLock,
          },
        },
      ],
    }).compile();

    service = module.get<BillingReconciliationService>(BillingReconciliationService);

    runCreate.mockResolvedValue({ id: 'run-1', workerId: null, billingAccountId: 'acc-1' });
    runFindFirst.mockResolvedValue(null);
    runFindUnique.mockResolvedValue({ workerId: 'reconcile-test' });
    runUpdateMany.mockResolvedValue({ count: 1 });
    txCount.mockResolvedValue(0);
    walletFindUnique.mockResolvedValue({ walletAddress: WALLET });
    recordSuccessfulOutbound.mockResolvedValue({ outcome: 'inserted' });
    txUpdateMany.mockResolvedValue({ count: 1 });
    txUpdate.mockResolvedValue({ id: 'tx-1' });
    txFindMany.mockResolvedValue([]);
    // The shared lock seam invokes the callback with a transaction client whose
    // billingReconciliationRun methods are the same mocks.
    withBillingPeriodLock.mockImplementation(async (_userId, _periodStart, work) =>
      work(
        {
          billingReconciliationRun: {
            create: runCreate,
            findFirst: runFindFirst,
            updateMany: runUpdateMany,
          },
        },
        'acc-1',
      ),
    );
  });

  it('scans non-confirmed candidates first, then fills with confirmed (account/period-scoped)', async () => {
    mockCandidates([]);

    await service.reconcile('user-1', {
      limit: 10,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(txFindMany).toHaveBeenNthCalledWith(1, {
      where: {
        userId: 'user-1',
        operationType: { in: ['send', 'withdraw'] },
        status: { in: ['submitting', 'pending', 'unknown'] },
        billingPeriodStart: PERIOD_START,
        createdAt: { lt: PERIOD_END },
      },
      orderBy: [{ billingLastAttemptedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }, { id: 'asc' }],
      take: 5,
    });
    expect(txFindMany).toHaveBeenNthCalledWith(2, {
      where: {
        userId: 'user-1',
        operationType: { in: ['send', 'withdraw'] },
        status: 'confirmed',
        // A confirmed row is unresolved when it has a NULL txHash OR lacks the
        // durable billingReconciledAt marker (NULL-hash ignores the marker).
        AND: [
          { OR: [{ txHash: null }, { billingReconciledAt: null }] },
          { billingPeriodStart: PERIOD_START },
          { createdAt: { lt: PERIOD_END } },
        ],
        id: { notIn: [] },
      },
      orderBy: [{ billingLastAttemptedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }, { id: 'asc' }],
      // the sparse non-confirmed set rolls its slice into the confirmed slice
      take: 10,
    });
  });

  it('uses a bounded one-row fair page without starving confirmed backlog', async () => {
    const pending = txRow({ id: 'tx-pending', status: 'pending' });
    const confirmed = txRow({ id: 'tx-confirmed', status: 'confirmed', billingReconciledAt: null });
    txFindMany.mockResolvedValueOnce([pending]).mockResolvedValueOnce([confirmed]);

    const result = await (service as any).selectCandidates('user-1', PERIOD_END, 1);

    expect(txFindMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ take: 1 }));
    expect(txFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ take: 1 }));
    expect(result).toEqual([confirmed]);
    expect(result).toHaveLength(1);
  });

  it('uses the one-row pending slot when the confirmed queue is empty', async () => {
    const pending = txRow({ id: 'tx-pending', status: 'pending' });
    txFindMany.mockResolvedValueOnce([pending]).mockResolvedValueOnce([]);

    const result = await (service as any).selectCandidates('user-1', PERIOD_END, 1);

    expect(result).toEqual([pending]);
    expect(result).toHaveLength(1);
  });

  it('never starves pending transactions behind a large confirmed backlog', async () => {
    const pending = txRow({ id: 'tx-pending', status: 'pending' });
    const confirmed = Array.from({ length: 199 }, (_, i) =>
      txRow({ id: `tx-confirmed-${i}`, status: 'confirmed' }),
    );
    mockCandidates([pending], confirmed);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    const result = await service.reconcile('user-1', {
      limit: 200,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    // the pending tx is scanned first despite 199 confirmed rows; the confirmed
    // slice expands to use the pending slice leftovers
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'tx-pending' }),
    );
    expect(result.scanned).toBe(200);
  });

  it('gives confirmed backlog a guaranteed slice even behind >200 unresolved rows', async () => {
    const pending = Array.from({ length: 250 }, (_, i) =>
      txRow({ id: `tx-pending-${i}`, status: 'pending' }),
    );
    const confirmed = Array.from({ length: 50 }, (_, i) =>
      txRow({ id: `tx-confirmed-${i}`, status: 'confirmed' }),
    );
    mockCandidates(pending.slice(0, 100), confirmed);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    const result = await service.reconcile('user-1', {
      limit: 200,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    // 100 pending + 100 confirmed slice: confirmed backlog makes progress even
    // with 250 unresolved rows ahead of it.
    expect(result.scanned).toBe(150);
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'tx-confirmed-0' }),
    );
  });

  it('drains a 201-row confirmed backlog across runs via the durable progress marker', async () => {
    // First run: 200 of 201 confirmed rows are scanned and marked reconciled.
    const confirmed = Array.from({ length: 200 }, (_, i) =>
      txRow({ id: `tx-c-${i}`, status: 'confirmed' }),
    );
    mockCandidates([], confirmed);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    // The exhaustion check still finds the 201st row, so the first run is
    // incomplete even though its whole slice was scanned.
    txCount.mockResolvedValueOnce(0).mockResolvedValue(1);
    const first = await service.reconcile('user-1', {
      limit: 200,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });
    expect(first.scanned).toBe(200);
    expect(recordSuccessfulOutbound).toHaveBeenCalled();
    const firstCompletion = runUpdateMany.mock.calls.find((c) => c[0]?.data?.status === 'completed');
    expect(firstCompletion[0].data.summary.complete).toBe(false);

    // Second run: the durable marker excludes the 200 already reconciled rows
    // and the exhaustion check confirms the scan is now exhaustive.
    txFindMany.mockResolvedValue([]);
    txCount.mockResolvedValue(0);
    runUpdateMany.mockClear();
    const second = await service.reconcile('user-1', {
      limit: 200,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });
    expect(second.scanned).toBe(0);
    const secondCompletion = runUpdateMany.mock.calls.find((c) => c[0]?.data?.status === 'completed');
    expect(secondCompletion[0].data.summary.complete).toBe(true);
  });

  it('records no-hash rows as unresolved work without calling RPC and blocks closure', async () => {
    const noHash = txRow({ id: 'tx-nohash', txHash: null, status: 'submitting' });
    mockCandidates([noHash]);
    // Nothing to query on the RPC for a hash-less row.
    getReceipt.mockClear();

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(getReceipt).not.toHaveBeenCalled();
    expect(recordSuccessfulOutbound).not.toHaveBeenCalled();
    expect(result.noHash).toBe(1);
    // The run is completed (state machine finished) but never clean.
    const completion = runUpdateMany.mock.calls.find((c) => c[0]?.data?.status === 'completed');
    expect(completion[0].data.summary.complete).toBe(false);
  });

  it('posts a wallet-originated USDC transfer, passes the run id, and confirms the transaction', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        transactionId: 'tx-1',
        sourceKey: 'tx:tx-1:log:0',
        status: 'posted',
        amountUsdMicros: 1_000_000n,
        chainId: 8453n,
        walletAddress: WALLET,
        assetId: USDC_BASE,
        assetDecimals: 6,
        baseUnitAmount: 1_000_000n,
        unitPriceMicros: 1_000_000n,
        priceSource: 'static_usd_peg',
        reconciliationRunId: 'run-1',
        receipt: expect.objectContaining({
          txHash: TX_HASH,
          receiptRef: `${TX_HASH}:log:0`,
          receiptLogIndex: 0,
          receiptBlockNumber: 12345n,
          receiptBlockHash: BLOCK_HASH,
          receiptBlockTimestamp: 1_786_320_000n,
          receiptStatus: 'success',
        }),
        metadata: { policyVersion: 1 },
      }),
    );
    expect(result).toMatchObject({ runId: 'run-1', scanned: 1, posted: 1, updated: 1 });
  });

  it('marks a successfully reconciled confirmed transaction with billingReconciledAt', async () => {
    mockCandidates([txRow({ status: 'confirmed' })]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(result.updated).toBe(1);
  });

  it('never meters a reverted receipt and marks the transaction failed with receipt evidence', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'reverted',
      receipt: { ...successReceipt(), status: 'reverted' },
    });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).not.toHaveBeenCalled();
    expect(txUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'tx-1', status: 'pending' }),
        data: expect.objectContaining({
          status: 'failed',
          failureReason: 'receipt_reverted',
          details: expect.objectContaining({
            receipt: expect.objectContaining({
              hash: TX_HASH,
              blockNumber: '12345',
              blockHash: BLOCK_HASH,
              status: 'reverted',
              timestamp: '1786320000',
              reconciledAt: expect.any(String),
            }),
          }),
        }),
      }),
    );
    // reverted receipt evidence never leaks logs or calldata
    const data = txUpdateMany.mock.calls.find(([args]) =>
      (args as { data?: Record<string, unknown> }).data?.failureReason === 'receipt_reverted',
    )?.[0].data;
    expect(data.details.receipt).not.toHaveProperty('logs');
    expect(data.details.receipt).not.toHaveProperty('calldata');
    expect(data.details.receipt).not.toHaveProperty('input');
    expect(result).toMatchObject({ reverted: 1, posted: 0 });
  });

  it('counts a zero-count CAS on reverted as casNoops', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'reverted',
      receipt: { ...successReceipt(), status: 'reverted' },
    });
    txUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(result).toMatchObject({ reverted: 0, casNoops: 1 });
  });

  it('counts a zero-count CAS on success as casNoops', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    txUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(result).toMatchObject({ updated: 1, casNoops: 0 });
  });

  it('keeps the transaction pending when the receipt is not found yet', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'not_found' });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).not.toHaveBeenCalled();
    expectNoTransactionStateMutation();
    expect(result).toMatchObject({ notFound: 1, updated: 0 });
  });

  it('keeps the transaction pending on transient RPC errors', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'error', message: 'receipt lookup failed' });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).not.toHaveBeenCalled();
    expectNoTransactionStateMutation();
    expect(result).toMatchObject({ transientError: 1, updated: 0 });
  });

  it('counts a tx hash mismatch as a conflict and never meters or confirms', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: {
        ...successReceipt(),
        transactionHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
      },
    });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).not.toHaveBeenCalled();
    expectNoTransactionStateMutation();
    expect(result).toMatchObject({ conflicts: 1, posted: 0, updated: 0 });
  });

  it('counts wallet-originated logs for userOp sends even when receipt.from is the bundler', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: { ...successReceipt(), from: '0x9999999999999999999999999999999999999999' },
    });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: 'tx:tx-1:log:0', status: 'posted' }),
    );
  });

  it('does not bill an outer bundle when the typed inner UserOperation failed', async () => {
    mockCandidates([txRow({ userOpHash: '0x' + 'a'.repeat(64), userOpSuccess: false })]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    const result = await service.reconcile('user-1', { targetPeriodStart: PERIOD_START, targetPeriodEnd: PERIOD_END });

    expect(recordSuccessfulOutbound).not.toHaveBeenCalled();
    expect(getReceipt).not.toHaveBeenCalled();
    expect(result.reverted).toBe(1);
    expect(txUpdateMany.mock.calls.some(([args]) =>
      (args as { data?: Record<string, unknown> }).data?.status === 'failed',
    )).toBe(true);
  });

  it('recovers a stored UserOperation hash from sanitized success and false results', async () => {
    mockCandidates([txRow({ txHash: null, userOpHash: '0x' + 'b'.repeat(64), userOpSuccess: null })]);
    waitForUserOperationReceipt.mockResolvedValueOnce({ success: true, transactionHash: TX_HASH });
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    await service.reconcile('user-1', { targetPeriodStart: PERIOD_START, targetPeriodEnd: PERIOD_END });

    expect(waitForUserOperationReceipt).toHaveBeenCalledWith({ chainId: 8453, userOpHash: '0x' + 'b'.repeat(64) });
    expect(recordSuccessfulOutbound).toHaveBeenCalled();

    jest.clearAllMocks();
    runCreate.mockResolvedValue({ id: 'run-1', workerId: null, billingAccountId: 'acc-1' });
    runFindFirst.mockResolvedValue(null);
    runUpdateMany.mockResolvedValue({ count: 1 });
    txCount.mockResolvedValue(0);
    mockCandidates([txRow({ txHash: null, userOpHash: '0x' + 'c'.repeat(64), userOpSuccess: null })]);
    waitForUserOperationReceipt.mockResolvedValue({ success: false, transactionHash: null });

    const failed = await service.reconcile('user-1', { targetPeriodStart: PERIOD_START, targetPeriodEnd: PERIOD_END });
    expect(recordSuccessfulOutbound).not.toHaveBeenCalled();
    expect(failed.reverted).toBe(1);
  });

  it('posts a backend_eoa send when receipt.from matches the wallet', async () => {
    mockCandidates([
      txRow({
        walletAddress: AGENT,
        details: { type: 'send', execution: 'backend_eoa', executionMode: 'eoa' },
      }),
    ]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: {
        ...successReceipt([
          transferLog({ topics: [TRANSFER_TOPIC0, paddedAddress(AGENT), paddedAddress(OTHER)] }),
        ]),
        from: AGENT,
      },
    });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: 'tx:tx-1:log:0', status: 'posted' }),
    );
  });

  it('quarantines a backend_eoa send whose receipt.from does not match the wallet', async () => {
    mockCandidates([
      txRow({
        walletAddress: AGENT,
        details: { type: 'send', execution: 'backend_eoa', executionMode: 'eoa' },
      }),
    ]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: { ...successReceipt(), from: '0x9999999999999999999999999999999999999999' },
    });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:eoa_sender_mismatch',
        status: 'quarantined',
        amountUsdMicros: 0n,
        reconciliationRunId: 'run-1',
        metadata: expect.objectContaining({
          reason: 'eoa_sender_mismatch',
          expectedSender: AGENT,
          actualSender: '0x9999999999999999999999999999999999999999',
        }),
      }),
    );
    expectNoTransactionStateMutation(); // never confirmed
    expect(result).toMatchObject({ quarantined: 1, posted: 0, updated: 0 });
  });

  it('posts USDC and USDT logs separately with distinct source keys', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([
        transferLog({ logIndex: 0 }),
        transferLog({
          address: USDT_BASE,
          topics: [TRANSFER_TOPIC0, paddedAddress(WALLET), paddedAddress(OTHER)],
          data: amountData(2_000_000n),
          logIndex: 1,
        }),
      ]),
    });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledTimes(1);
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: 'tx:tx-1:receipt', status: 'quarantined', amountUsdMicros: 0n }),
    );
  });

  it('skips inbound logs that are not wallet-originated', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([
        transferLog({ topics: [TRANSFER_TOPIC0, paddedAddress(OTHER), paddedAddress(WALLET)] }),
      ]),
    });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).not.toHaveBeenCalled();
    expect(result).toMatchObject({ posted: 0, quarantined: 0 });
  });

  it('quarantines unknown tokens with volume 0 and the run id', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([
        transferLog({ address: '0x2222222222222222222222222222222222222222' }),
      ]),
    });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: 'tx:tx-1:log:0', status: 'quarantined', amountUsdMicros: 0n, reconciliationRunId: 'run-1', metadata: expect.objectContaining({ reason: 'unknown_token' }) }),
    );
  });

  it('quarantines a native withdrawal with a deterministic native key and the run id', async () => {
    mockCandidates([
      txRow({
        operationType: 'withdraw',
        details: {
          type: 'withdraw',
          token: 'NATIVE',
          contractAddress: null,
          amount: '5000000000000000000',
        },
      }),
    ]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt([]) });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:native',
        status: 'quarantined',
        amountUsdMicros: 0n,
        reconciliationRunId: 'run-1',
        receipt: expect.objectContaining({ receiptLogIndex: null }),
        metadata: expect.objectContaining({
          reason: 'native_asset',
          amount: '5000000000000000000',
        }),
      }),
    );
  });

  it('quarantines removed and incomplete logs', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([
        transferLog({ removed: true, logIndex: 0 }),
        transferLog({ topics: [TRANSFER_TOPIC0], logIndex: 1 }),
      ]),
    });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledTimes(1);
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: 'tx:tx-1:receipt', metadata: expect.objectContaining({ reason: 'unsafe_removed' }) }),
    );
  });

  it('quarantines a Transfer log whose removed flag is missing or non-boolean (never posts usage)', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([
        transferLog({ removed: undefined, logIndex: 0 }),
        transferLog({ removed: 'false', logIndex: 1 }),
        transferLog({ removed: 0, logIndex: 2 }),
      ]),
    });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    // The receipt is quarantined once as a single atomic accounting unit.
    expect(recordSuccessfulOutbound).toHaveBeenCalledTimes(1);
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: 'tx:tx-1:receipt', status: 'quarantined', amountUsdMicros: 0n }),
    );
    expect(result).toMatchObject({ quarantined: 1, posted: 0 });
  });

  it('quarantines logs with malformed indexed addresses instead of fabricating an address', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([
        transferLog({ topics: [TRANSFER_TOPIC0, '0x1234', paddedAddress(OTHER)] }),
      ]),
    });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:log:0',
        status: 'quarantined',
        amountUsdMicros: 0n,
        metadata: { reason: 'incomplete_log' },
      }),
    );
  });

  it('quarantines logs with a malformed indexed `to` topic', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([
        transferLog({ topics: [TRANSFER_TOPIC0, paddedAddress(WALLET), 'not-a-topic'] }),
      ]),
    });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:log:0',
        status: 'quarantined',
        metadata: { reason: 'incomplete_log' },
      }),
    );
  });

  it('quarantines logs with invalid amount data', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([transferLog({ data: '0x1234' })]),
    });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:log:0',
        status: 'quarantined',
        metadata: { reason: 'incomplete_log' },
      }),
    );
  });

  it('quarantines logs with a malformed token address', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([transferLog({ address: '0x1234' })]),
    });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:log:0',
        status: 'quarantined',
        metadata: { reason: 'incomplete_log' },
      }),
    );
  });

  it('counts a non-array receipt.logs as an error and never confirms', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: { ...successReceipt(), logs: 'not-an-array' },
    });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).not.toHaveBeenCalled();
    expectNoTransactionStateMutation();
    expect(result).toMatchObject({ errors: 1, updated: 0 });
  });

  it('quarantines logs whose topics is null or not an array', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([
        transferLog({ topics: null, logIndex: 0 }),
        transferLog({ topics: 'not-an-array', logIndex: 1 }),
      ]),
    });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledTimes(1);
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: 'tx:tx-1:receipt', status: 'quarantined', metadata: expect.objectContaining({ reason: 'incomplete_log' }) }),
    );
  });

  it('quarantines logs with non-string or non-hex topic elements', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([
        transferLog({ topics: [TRANSFER_TOPIC0, 123, paddedAddress(OTHER)], logIndex: 0 }),
        transferLog({ topics: [TRANSFER_TOPIC0, 'zzzz', paddedAddress(OTHER)], logIndex: 1 }),
      ]),
    });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledTimes(1);
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: 'tx:tx-1:receipt', status: 'quarantined', metadata: expect.objectContaining({ reason: 'incomplete_log' }) }),
    );
  });

  it('quarantines indexed addresses with non-zero ABI padding', async () => {
    const nonZeroPaddedFrom = '0x' + '1'.repeat(24) + WALLET.slice(2);
    const nonZeroPaddedTo = '0x' + '2'.repeat(24) + OTHER.slice(2);
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([
        transferLog({
          topics: [TRANSFER_TOPIC0, nonZeroPaddedFrom, paddedAddress(OTHER)],
          logIndex: 0,
        }),
        transferLog({
          topics: [TRANSFER_TOPIC0, paddedAddress(WALLET), nonZeroPaddedTo],
          logIndex: 1,
        }),
      ]),
    });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:receipt',
        status: 'quarantined',
        metadata: expect.objectContaining({ reason: 'incomplete_log' }),
      }),
    );
    expect(recordSuccessfulOutbound).toHaveBeenCalledTimes(1);
  });

  it('quarantines missing topics with a valid log index', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([transferLog({ topics: undefined, logIndex: 3 })]),
    });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:log:3',
        status: 'quarantined',
        metadata: { reason: 'incomplete_log' },
      }),
    );
  });

  it('accepts string and bigint log indexes as canonical identities', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([transferLog({ logIndex: '5' }), transferLog({ logIndex: 6n })]),
    });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledTimes(1);
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: 'tx:tx-1:receipt', status: 'posted', amountUsdMicros: 2_000_000n }),
    );
  });

  it('quarantines missing, unsafe, and negative log indexes with safe identities', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([
        transferLog({ logIndex: undefined }),
        transferLog({ logIndex: 2 ** 53 }),
        transferLog({ logIndex: -1 }),
      ]),
    });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    // The malformed receipt is quarantined once as one atomic accounting unit.
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:receipt',
        status: 'quarantined',
        amountUsdMicros: 0n,
        reconciliationRunId: 'run-1',
        receipt: expect.objectContaining({ receiptLogIndex: null }),
        metadata: expect.objectContaining({ reason: 'invalid_log_index' }),
      }),
    );
    expect(recordSuccessfulOutbound).toHaveBeenCalledTimes(1);
  });

  it('quarantines a valid removed log and bubbles a posted-evidence conflict', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([transferLog({ removed: true, logIndex: 0 })]),
    });
    recordSuccessfulOutbound.mockRejectedValue(new ConflictException('evidence conflict'));

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(result).toMatchObject({ conflicts: 1, quarantined: 0, updated: 0 });
    expectNoTransactionStateMutation();
  });

  it('uses the worker target period while preserving receipt occurredAt (cross-month safe)', async () => {
    // The candidate was created in 2026-08 but mined in 2026-09; the accounting
    // The ledger period comes from the worker target, never receipt time or createdAt.
    // 1_788_220_800 = 2026-09-01T00:00:00Z; target period remains August.
    mockCandidates([txRow({ createdAt: new Date('2026-08-31T23:59:00.000Z') })]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: { ...successReceipt(), blockTimestamp: 1_788_220_800n },
    });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        periodStart: PERIOD_START,
        occurredAt: new Date('2026-09-01T00:00:00.000Z'),
      }),
    );
  });

  it('handles amounts beyond the JS safe integer range exactly', async () => {
    const huge = 2n ** 100n;
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([transferLog({ data: amountData(huge) })]),
    });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ baseUnitAmount: huge, amountUsdMicros: huge }),
    );
  });

  it('writes JSON-safe receipt evidence (no BigInt leaks)', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    const call = recordSuccessfulOutbound.mock.calls[0][0];
    expect(() => JSON.stringify(call.receipt.receiptData)).not.toThrow();
    expect(call.receipt.receiptData.blockNumber).toBe('12345');
    expect(call.receipt.receiptData.blockTimestamp).toBe('1786320000');
    expect(call.receipt.receiptData.gasUsed).toBe('100000');
    expect(typeof call.receipt.receiptData.blockNumber).toBe('string');
  });

  it('counts a writer ConflictException as a conflict and does not confirm', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    recordSuccessfulOutbound.mockRejectedValue(new ConflictException('evidence conflict'));

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(result).toMatchObject({ conflicts: 1, posted: 0, updated: 0 });
    expectNoTransactionStateMutation();
  });

  it('counts a writer P2002 as an error and does not confirm', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    recordSuccessfulOutbound.mockRejectedValue(p2002());

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(result).toMatchObject({ errors: 1, posted: 0, updated: 0 });
    expectNoTransactionStateMutation();
  });

  it('counts an exact writer replay as replayed and still confirms', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    recordSuccessfulOutbound.mockResolvedValue({ outcome: 'replayed' });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(result).toMatchObject({ replayed: 1, posted: 0, updated: 1 });
  });

  it('treats a finalized-period exact replay as replayed and completes the run', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    recordSuccessfulOutbound.mockResolvedValue({ outcome: 'replayed' });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(result).toMatchObject({ replayed: 1, conflicts: 0, posted: 0, updated: 1 });
    const completion = runUpdateMany.mock.calls.find((c) => c[0]?.data?.status === 'completed');
    expect(completion[0].data.summary).toMatchObject({
      complete: true,
      replayed: 1,
      conflicts: 0,
      accountingPeriods: ['2026-08-01T00:00:00.000Z'],
    });
  });

  it('counts a finalized-period divergent replay as a conflict and never confirms', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    recordSuccessfulOutbound.mockRejectedValue(
      new ConflictException('Billing usage event conflicts with an existing row'),
    );

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(result).toMatchObject({ conflicts: 1, posted: 0, updated: 0 });
    expectNoTransactionStateMutation();
    const completion = runUpdateMany.mock.calls.find((c) => c[0]?.data?.status === 'completed');
    expect(completion[0].data.summary).toMatchObject({ complete: false, conflicts: 1 });
  });

  it('counts finalized-period new evidence as a conflict and never confirms', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    recordSuccessfulOutbound.mockRejectedValue(
      new ConflictException(
        'Cannot append receipt evidence: the billing period is already finalized',
      ),
    );

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(result).toMatchObject({ conflicts: 1, posted: 0, updated: 0 });
    expectNoTransactionStateMutation();
  });

  it('records run failure with error details and summary instead of swallowing', async () => {
    txFindMany.mockRejectedValue(new Error('database down'));

    await expect(
      service.reconcile('user-1', {
        limit: 50,
        targetPeriodStart: PERIOD_START,
        targetPeriodEnd: PERIOD_END,
      }),
    ).rejects.toThrow('database down');

    expect(runUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'run-1', status: 'running' }),
        data: expect.objectContaining({
          status: 'failed',
          errorDetails: 'database down',
          summary: expect.objectContaining({ scanned: 0 }),
        }),
      }),
    );
  });

  it('re-scans already-confirmed transactions idempotently', async () => {
    mockCandidates([], [txRow({ status: 'confirmed' })]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(recordSuccessfulOutbound).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ scanned: 1, posted: 1, updated: 1 });
  });

  it('quarantines transactions on chains no longer in the supported config', async () => {
    mockCandidates([txRow({ chainId: 999_999n })]);

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(getReceipt).not.toHaveBeenCalled();
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:unsupported_chain',
        status: 'quarantined',
        reconciliationRunId: 'run-1',
        metadata: { reason: 'unsupported_chain' },
        // No receipt exists for an unsupported chain: the occurrence time is
        // the real persisted transaction createdAt (never a fabricated `now`),
        // and the block evidence is an explicit unknown sentinel — never a
        // synthetic receipt/block fact.
        occurredAt: new Date('2026-08-01T00:00:00.000Z'),
        receipt: expect.objectContaining({
          receiptBlockNumber: 0n,
          receiptBlockHash: '',
          receiptBlockTimestamp: 0n,
          receiptStatus: 'unknown',
          receiptData: expect.objectContaining({ evidence: 'none_unsupported_chain' }),
        }),
      }),
    );
    expect(result).toMatchObject({ quarantined: 1 });
  });

  it('creates the running run through the shared billing-period lock seam, account/period-scoped', async () => {
    mockCandidates([]);

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(withBillingPeriodLock).toHaveBeenCalledWith(
      'user-1',
      PERIOD_START,
      expect.any(Function),
    );
    expect(runFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          billingAccountId: 'acc-1',
          periodStart: PERIOD_START,
          runType: 'receipt_outbound',
          status: 'running',
        }),
      }),
    );
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'running',
          runType: 'receipt_outbound',
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          source: 'openfort_receipt',
          billingAccountId: 'acc-1',
          leaseExpiresAt: expect.any(Date),
          heartbeatAt: expect.any(Date),
        }),
      }),
    );
  });

  it('skips without overlapping when a live concurrent worker owns the active run', async () => {
    runFindFirst.mockResolvedValue({
      id: 'run-live',
      workerId: 'worker-a',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      billingAccountId: 'acc-1',
    });
    txFindMany.mockClear();

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
      workerId: 'worker-b',
    });

    expect(result.skipped).toBe(true);
    expect(runCreate).not.toHaveBeenCalled();
    expect(txFindMany).not.toHaveBeenCalled();
  });

  it('takes over a stale running run with an owner-checked compare-and-set and resumes', async () => {
    runFindFirst.mockResolvedValue({
      id: 'run-stale',
      workerId: 'worker-a',
      leaseExpiresAt: new Date(Date.now() - 60_000),
      billingAccountId: 'acc-1',
    });
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
      workerId: 'worker-b',
    });

    // takeover CAS matches running status + (null OR stale/expired lease)
    expect(runUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'run-stale',
          status: 'running',
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: expect.any(Date) } }],
        }),
        data: expect.objectContaining({ workerId: 'worker-b', heartbeatAt: expect.any(Date) }),
      }),
    );
    // the resumed run reuses the existing run id and completes with its own
    // evidence (no duplicate run created).
    expect(runCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ runId: 'run-stale', scanned: 1, posted: 1, skipped: false });
  });

  it('takes over a legacy running run with a NULL lease (never left stuck)', async () => {
    runFindFirst.mockResolvedValue({
      id: 'run-legacy',
      workerId: null, // pre-ownership run
      leaseExpiresAt: null, // legacy row with no lease
      billingAccountId: 'acc-1',
    });
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
      workerId: 'worker-b',
    });

    // The null-lease OR branch makes a legacy running row takeable.
    expect(runUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'run-legacy',
          status: 'running',
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: expect.any(Date) } }],
        }),
      }),
    );
    expect(runCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ runId: 'run-legacy', scanned: 1, skipped: false });
  });

  it('skips when a concurrent worker wins the stale-run takeover race', async () => {
    runFindFirst.mockResolvedValue({
      id: 'run-stale',
      workerId: 'worker-a',
      leaseExpiresAt: new Date(Date.now() - 60_000),
      billingAccountId: 'acc-1',
    });
    // The takeover CAS matches zero rows: another worker took it first.
    runUpdateMany.mockResolvedValue({ count: 0 });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
      workerId: 'worker-b',
    });

    expect(result.skipped).toBe(true);
    expect(txFindMany).not.toHaveBeenCalled();
  });

  it('an old owner can no longer complete a run it does not own', async () => {
    mockCandidates([txRow({ id: 'tx-1' })]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    runCreate.mockResolvedValue({ id: 'run-1', workerId: 'worker-a', billingAccountId: 'acc-1' });

    // The old owner's completion update must not match (taken over by another
    // worker, so workerId no longer equals 'worker-a'). Heartbeats still pass
    // until the takeover lands.
    runUpdateMany.mockImplementation((args: { where?: { workerId?: string }; data?: { status?: string } }) => {
      if (args.data?.status === 'completed') return Promise.resolve({ count: 0 });
      return Promise.resolve({ count: 1 });
    });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
      workerId: 'worker-a',
    });

    // The work still completed (idempotent evidence) but the completion write
    // is owner-checked: it can only match the old owner's own workerId, and it
    // matched zero rows, so the takeover owner's run state is never clobbered.
    expect(result).toMatchObject({ posted: 1, updated: 1 });
    const completion = runUpdateMany.mock.calls.find((c) => c[0]?.data?.status === 'completed');
    expect(completion[0].where).toMatchObject({
      id: 'run-1',
      status: 'running',
      workerId: 'worker-a',
    });
  });

  it('stops working immediately when lease ownership is lost mid-run (heartbeat ownership)', async () => {
    runCreate.mockResolvedValue({ id: 'run-1', workerId: 'worker-a', billingAccountId: 'acc-1' });
    mockCandidates([txRow({ id: 'tx-1' }), txRow({ id: 'tx-2' })]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    // The fenced fairness touch succeeds; the next worker-owned heartbeat
    // matches zero rows —
    // the run was taken over mid-run.
    let updateCount = 0;
    runUpdateMany.mockImplementation((args: { where?: { workerId?: string } }) => {
      updateCount += 1;
      if (updateCount >= 2 && args.where?.workerId === 'worker-a') {
        return Promise.resolve({ count: 0 });
      }
      return Promise.resolve({ count: 1 });
    });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
      workerId: 'worker-a',
    });

    expect(result.ownershipLost).toBe(true);
    expect(recordSuccessfulOutbound).not.toHaveBeenCalled();
  });

  it('gives every invocation a real owner id and refreshes the heartbeat timestamp', async () => {
    mockCandidates([txRow({ id: 'tx-1' })]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    // The dashboard path passes NO workerId — the service must generate one.
    runCreate.mockResolvedValue({ id: 'run-1', workerId: null, billingAccountId: 'acc-1' });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(result.ownershipLost).toBe(false);
    // The heartbeat is owner-checked with a NON-null generated owner id and a
    // fresh lease/heartbeat timestamp (never a stale captured time).
    const heartbeat = runUpdateMany.mock.calls.find(
      ([arg]) =>
        arg?.data &&
        typeof arg.data === 'object' &&
        'heartbeatAt' in (arg.data as Record<string, unknown>),
    );
    expect(heartbeat).toBeDefined();
    const where = heartbeat![0].where as { workerId?: string };
    expect(typeof where.workerId).toBe('string');
    expect(where.workerId!.length).toBeGreaterThan(0);
    expect(where.workerId).not.toBeNull();
    const data = heartbeat![0].data as { heartbeatAt?: Date; leaseExpiresAt?: Date };
    expect(data.heartbeatAt).toBeInstanceOf(Date);
    expect(data.leaseExpiresAt).toBeInstanceOf(Date);
    // Fresh heartbeat: timestamp is within the last few seconds, not the run start.
    expect(data.heartbeatAt!.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it('rejects completion/failure writes from an owner that no longer matches', async () => {
    runCreate.mockResolvedValue({ id: 'run-1', workerId: 'worker-a', billingAccountId: 'acc-1' });
    mockCandidates([txRow({ id: 'tx-1' })]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    // Every worker-owned update matches zero rows (run was taken over), so
    // completion and failure cannot be written by the old owner.
    runUpdateMany.mockResolvedValue({ count: 0 });

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
      workerId: 'worker-a',
    });

    // Every update is owner-checked (workerId present) and the old owner's
    // completion update matched zero rows — never a clobber of the new owner.
    expect(result.ownershipLost).toBe(true);
    for (const call of runUpdateMany.mock.calls) {
      const where = call[0].where as { workerId?: string };
      expect(where.workerId).toBe('worker-a');
    }
    const completion = runUpdateMany.mock.calls.find(
      ([arg]) => (arg?.data as { status?: string } | undefined)?.status === 'completed',
    );
    expect(completion).toBeDefined();
    expect(runUpdateMany.mock.results.find((r) => r.type === 'return')).toBeDefined();
  });

  it('treats a confirmed row with a NULL txHash as unresolved no-hash work that blocks closure', async () => {
    // Data-integrity anomalous: status confirmed but no txHash. It must be
    // scanned (never RPC'd), counted as noHash, and keep the run incomplete.
    const anomalous = txRow({ id: 'tx-anomalous', status: 'confirmed', txHash: null });
    mockCandidates([], [anomalous]);
    getReceipt.mockClear();

    const result = await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    expect(getReceipt).not.toHaveBeenCalled();
    expect(recordSuccessfulOutbound).not.toHaveBeenCalled();
    expect(result.noHash).toBe(1);
    const completion = runUpdateMany.mock.calls.find(
      ([arg]) => (arg?.data as { status?: string } | undefined)?.status === 'completed',
    );
    expect(completion).toBeDefined();
    expect((completion![0].data as { summary?: { complete?: boolean } }).summary?.complete).toBe(
      false,
    );
  });

  it('persists complete:false and counters for a notFound run', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'not_found' });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    const completion = runUpdateMany.mock.calls.find((c) => c[0]?.data?.status === 'completed');
    expect(completion[0].data.summary).toMatchObject({
      userId: 'user-1',
      complete: false,
      notFound: 1,
      scanned: 1,
    });
  });

  it('persists complete:false and counters for a transientError run', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'error', message: 'receipt lookup failed' });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    const completion = runUpdateMany.mock.calls.find((c) => c[0]?.data?.status === 'completed');
    expect(completion[0].data.summary).toMatchObject({
      userId: 'user-1',
      complete: false,
      transientError: 1,
    });
  });

  it('persists complete:true and highWaterMark for a clean exhausted run', async () => {
    mockCandidates([txRow({ id: 'tx-1', createdAt: new Date('2026-08-01T00:00:00.000Z') })]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    const completion = runUpdateMany.mock.calls.find((c) => c[0]?.data?.status === 'completed');
    expect(completion[0].data.summary).toMatchObject({
      userId: 'user-1',
      complete: true,
      highWaterMark: { createdAt: '2026-08-01T00:00:00.000Z', id: 'tx-1' },
      remainingUnresolved: 0,
    });
  });

  it('does not mark a run complete when the final exhaustion check finds work', async () => {
    mockCandidates([txRow({ id: 'tx-1' })]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    // The scan exhausted its slice, but a fresh unresolved row still exists.
    txCount.mockResolvedValueOnce(0).mockResolvedValueOnce(1).mockResolvedValue(1);

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    const completion = runUpdateMany.mock.calls.find((c) => c[0]?.data?.status === 'completed');
    expect(completion[0].data.summary.complete).toBe(false);
    expect(completion[0].data.summary.remainingUnresolved).toBe(1);
  });

  it('picks the true max (createdAt, id) regardless of priority order', async () => {
    const pending = txRow({
      id: 'tx-pending',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const confirmed = [
      txRow({
        id: 'tx-c1',
        status: 'confirmed',
        createdAt: new Date('2026-08-03T00:00:00.000Z'),
      }),
      txRow({
        id: 'tx-c2',
        status: 'confirmed',
        createdAt: new Date('2026-08-02T00:00:00.000Z'),
      }),
    ];
    mockCandidates([pending], confirmed);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    const completion = runUpdateMany.mock.calls.find((c) => c[0]?.data?.status === 'completed');
    expect(completion[0].data.summary).toMatchObject({
      complete: true,
      highWaterMark: { createdAt: '2026-08-03T00:00:00.000Z', id: 'tx-c1' },
    });
  });

  it('breaks createdAt ties by the lexicographically largest id', async () => {
    mockCandidates([
      txRow({ id: 'tx-a', createdAt: new Date('2026-08-01T00:00:00.000Z') }),
      txRow({ id: 'tx-b', createdAt: new Date('2026-08-01T00:00:00.000Z') }),
    ]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    const completion = runUpdateMany.mock.calls.find((c) => c[0]?.data?.status === 'completed');
    expect(completion[0].data.summary.highWaterMark).toEqual({
      createdAt: '2026-08-01T00:00:00.000Z',
      id: 'tx-b',
    });
  });

  it('writes highWaterMark: null for an empty candidate set', async () => {
    mockCandidates([]);

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    const completion = runUpdateMany.mock.calls.find((c) => c[0]?.data?.status === 'completed');
    expect(completion[0].data.summary).toMatchObject({
      complete: true,
      highWaterMark: null,
    });
  });

  it('keeps complete:false and highWaterMark null when a candidate lacks createdAt', async () => {
    mockCandidates([txRow({ id: 'tx-1', createdAt: undefined })]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    const completion = runUpdateMany.mock.calls.find((c) => c[0]?.data?.status === 'completed');
    expect(completion[0].data.summary.highWaterMark).toBeNull();
    expect(completion[0].data.summary.complete).toBe(false);
    expect(completion[0].data.summary.errors).toBe(1);
  });

  it('keeps a slice-filled run complete:false even without errors', async () => {
    const filled = Array.from({ length: 50 }, (_, i) =>
      txRow({ id: `tx-${i}`, createdAt: new Date('2026-08-01T00:00:00.000Z') }),
    );
    mockCandidates(filled.slice(0, 25));
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    // 25 more unresolved rows remain after the bounded scan slice.
    txCount.mockResolvedValueOnce(0).mockResolvedValue(25);

    await service.reconcile('user-1', {
      limit: 50,
      targetPeriodStart: PERIOD_START,
      targetPeriodEnd: PERIOD_END,
    });

    const completion = runUpdateMany.mock.calls.find((c) => c[0]?.data?.status === 'completed');
    expect(completion[0].data.summary).toMatchObject({
      userId: 'user-1',
      complete: false,
      scanned: 25,
    });
  });

  it('persists complete:false and sanitized error details on failure', async () => {
    txFindMany.mockRejectedValue(new Error('database down'));

    await expect(
      service.reconcile('user-1', {
        limit: 50,
        targetPeriodStart: PERIOD_START,
        targetPeriodEnd: PERIOD_END,
      }),
    ).rejects.toThrow('database down');

    const failed = runUpdateMany.mock.calls.find((c) => c[0]?.data?.status === 'failed');
    expect(failed[0].data.errorDetails).toBe('database down');
    expect(failed[0].data.summary).toMatchObject({
      userId: 'user-1',
      complete: false,
      scanned: 0,
    });
  });
});
