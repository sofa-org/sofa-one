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
  const runUpdate = jest.fn();
  const txFindMany = jest.fn();
  const walletFindUnique = jest.fn();
  const txUpdateMany = jest.fn();
  const getReceipt = jest.fn();
  const recordSuccessfulOutbound = jest.fn();
  const withBillingPeriodLock = jest.fn();

  /** Stub the two-stage candidate queries: non-confirmed first, confirmed fill. */
  function mockCandidates(nonConfirmed: unknown[], confirmed: unknown[] = []) {
    txFindMany.mockResolvedValueOnce(nonConfirmed).mockResolvedValue(confirmed);
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingReconciliationService,
        {
          provide: PrismaService,
          useValue: {
            billingReconciliationRun: { create: runCreate, update: runUpdate },
            transaction: { findMany: txFindMany, updateMany: txUpdateMany },
            userWallet: { findUnique: walletFindUnique },
          },
        },
        {
          provide: OpenfortService,
          useValue: { getTransactionReceipt: getReceipt },
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

    runCreate.mockResolvedValue({ id: 'run-1' });
    runUpdate.mockResolvedValue({});
    walletFindUnique.mockResolvedValue({ walletAddress: WALLET });
    recordSuccessfulOutbound.mockResolvedValue({ outcome: 'inserted' });
    txUpdateMany.mockResolvedValue({ count: 1 });
    txFindMany.mockResolvedValue([]);
    // The shared lock seam invokes the callback with a transaction client whose
    // billingReconciliationRun.create is the same runCreate mock.
    withBillingPeriodLock.mockImplementation(async (_userId, _periodStart, work) =>
      work({ billingReconciliationRun: { create: runCreate } }),
    );
  });

  it('scans non-confirmed candidates first, then fills with confirmed', async () => {
    mockCandidates([]);

    await service.reconcile('user-1', { limit: 10 });

    expect(txFindMany).toHaveBeenNthCalledWith(1, {
      where: {
        userId: 'user-1',
        txHash: { not: null },
        operationType: { in: ['send', 'withdraw'] },
        status: { in: ['submitting', 'pending', 'unknown'] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 10,
    });
    expect(txFindMany).toHaveBeenNthCalledWith(2, {
      where: {
        userId: 'user-1',
        txHash: { not: null },
        operationType: { in: ['send', 'withdraw'] },
        status: 'confirmed',
        id: { notIn: [] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 10,
    });
  });

  it('never starves pending transactions behind a large confirmed backlog', async () => {
    const pending = txRow({ id: 'tx-pending', status: 'pending' });
    const confirmed = Array.from({ length: 199 }, (_, i) =>
      txRow({ id: `tx-confirmed-${i}`, status: 'confirmed' }),
    );
    mockCandidates([pending], confirmed);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    const result = await service.reconcile('user-1', { limit: 200 });

    // the pending tx is scanned first despite 199 confirmed rows
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: 'tx-pending' }),
    );
    expect(result.scanned).toBe(200);
  });

  it('posts a wallet-originated USDC transfer, passes the run id, and confirms the transaction', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    const result = await service.reconcile('user-1');

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
    expect(txUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tx-1', status: { in: ['submitting', 'pending', 'confirmed', 'unknown'] } },
        data: expect.objectContaining({ status: 'confirmed' }),
      }),
    );
    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-1' },
        data: expect.objectContaining({ status: 'completed' }),
      }),
    );
    expect(result).toMatchObject({ runId: 'run-1', scanned: 1, posted: 1, updated: 1 });
  });

  it('never meters a reverted receipt and marks the transaction failed with receipt evidence', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'reverted',
      receipt: { ...successReceipt(), status: 'reverted' },
    });

    const result = await service.reconcile('user-1');

    expect(recordSuccessfulOutbound).not.toHaveBeenCalled();
    expect(txUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tx-1', status: { in: ['submitting', 'pending', 'confirmed', 'unknown'] } },
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
    const data = txUpdateMany.mock.calls[0][0].data;
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
    txUpdateMany.mockResolvedValue({ count: 0 });

    const result = await service.reconcile('user-1');

    expect(result).toMatchObject({ reverted: 0, casNoops: 1 });
  });

  it('counts a zero-count CAS on success as casNoops', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    txUpdateMany.mockResolvedValue({ count: 0 });

    const result = await service.reconcile('user-1');

    expect(result).toMatchObject({ updated: 0, casNoops: 1 });
  });

  it('keeps the transaction pending when the receipt is not found yet', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'not_found' });

    const result = await service.reconcile('user-1');

    expect(recordSuccessfulOutbound).not.toHaveBeenCalled();
    expect(txUpdateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ notFound: 1, updated: 0 });
  });

  it('keeps the transaction pending on transient RPC errors', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'error', message: 'receipt lookup failed' });

    const result = await service.reconcile('user-1');

    expect(recordSuccessfulOutbound).not.toHaveBeenCalled();
    expect(txUpdateMany).not.toHaveBeenCalled();
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

    const result = await service.reconcile('user-1');

    expect(recordSuccessfulOutbound).not.toHaveBeenCalled();
    expect(txUpdateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ conflicts: 1, posted: 0, updated: 0 });
  });

  it('counts wallet-originated logs for userOp sends even when receipt.from is the bundler', async () => {
    // userOp: receipt.from is the bundler/entrypoint, not the wallet
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: { ...successReceipt(), from: '0x9999999999999999999999999999999999999999' },
    });

    await service.reconcile('user-1');

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: 'tx:tx-1:log:0', status: 'posted' }),
    );
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

    await service.reconcile('user-1');

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

    const result = await service.reconcile('user-1');

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
    expect(txUpdateMany).not.toHaveBeenCalled(); // never confirmed
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

    await service.reconcile('user-1');

    expect(recordSuccessfulOutbound).toHaveBeenCalledTimes(2);
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: 'tx:tx-1:log:0', assetId: USDC_BASE }),
    );
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:log:1',
        assetId: USDT_BASE,
        amountUsdMicros: 2_000_000n,
      }),
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

    const result = await service.reconcile('user-1');

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

    await service.reconcile('user-1');

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:log:0',
        status: 'quarantined',
        amountUsdMicros: 0n,
        reconciliationRunId: 'run-1',
        metadata: expect.objectContaining({ reason: 'unknown_token' }),
      }),
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

    await service.reconcile('user-1');

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

    await service.reconcile('user-1');

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: 'tx:tx-1:log:0', metadata: { reason: 'removed_log' } }),
    );
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:log:1',
        metadata: { reason: 'incomplete_log' },
      }),
    );
  });

  it('quarantines logs with malformed indexed addresses instead of fabricating an address', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([
        transferLog({ topics: [TRANSFER_TOPIC0, '0x1234', paddedAddress(OTHER)] }),
      ]),
    });

    await service.reconcile('user-1');

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

    await service.reconcile('user-1');

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

    await service.reconcile('user-1');

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

    await service.reconcile('user-1');

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

    const result = await service.reconcile('user-1');

    expect(recordSuccessfulOutbound).not.toHaveBeenCalled();
    expect(txUpdateMany).not.toHaveBeenCalled();
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

    await service.reconcile('user-1');

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:log:0',
        status: 'quarantined',
        metadata: { reason: 'incomplete_log' },
      }),
    );
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:log:1',
        status: 'quarantined',
        metadata: { reason: 'incomplete_log' },
      }),
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

    await service.reconcile('user-1');

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:log:0',
        status: 'quarantined',
        metadata: { reason: 'incomplete_log' },
      }),
    );
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:log:1',
        status: 'quarantined',
        metadata: { reason: 'incomplete_log' },
      }),
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

    await service.reconcile('user-1');

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:log:0',
        status: 'quarantined',
        metadata: { reason: 'incomplete_log' },
      }),
    );
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:log:1',
        status: 'quarantined',
        metadata: { reason: 'incomplete_log' },
      }),
    );
  });

  it('quarantines missing topics with a valid log index', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([transferLog({ topics: undefined, logIndex: 3 })]),
    });

    await service.reconcile('user-1');

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

    await service.reconcile('user-1');

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: 'tx:tx-1:log:5', status: 'posted' }),
    );
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: 'tx:tx-1:log:6', status: 'posted' }),
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

    await service.reconcile('user-1');

    // each malformed log gets a distinct deterministic safe identity based on
    // its receipt log array index, with receiptLogIndex null
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:log:invalid:0',
        status: 'quarantined',
        amountUsdMicros: 0n,
        reconciliationRunId: 'run-1',
        receipt: expect.objectContaining({ receiptLogIndex: null }),
        metadata: { reason: 'invalid_log_index' },
      }),
    );
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: 'tx:tx-1:log:invalid:1' }),
    );
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKey: 'tx:tx-1:log:invalid:2' }),
    );
  });

  it('quarantines a valid removed log and bubbles a posted-evidence conflict', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: successReceipt([transferLog({ removed: true, logIndex: 0 })]),
    });
    recordSuccessfulOutbound.mockRejectedValue(new ConflictException('evidence conflict'));

    const result = await service.reconcile('user-1');

    // the ConflictException bubbles to the run's conflicts and the tx is never
    // marked confirmed
    expect(result).toMatchObject({ conflicts: 1, quarantined: 0, updated: 0 });
    expect(txUpdateMany).not.toHaveBeenCalled();
  });

  it('derives periodStart from the receipt block timestamp UTC month', async () => {
    // 1_788_220_800 = 2026-09-01T00:00:00Z -> periodStart 2026-09-01
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({
      status: 'success',
      receipt: { ...successReceipt(), blockTimestamp: 1_788_220_800n },
    });

    await service.reconcile('user-1');

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
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

    await service.reconcile('user-1');

    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ baseUnitAmount: huge, amountUsdMicros: huge }),
    );
  });

  it('writes JSON-safe receipt evidence (no BigInt leaks)', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    await service.reconcile('user-1');

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

    const result = await service.reconcile('user-1');

    expect(result).toMatchObject({ conflicts: 1, posted: 0, updated: 0 });
    expect(txUpdateMany).not.toHaveBeenCalled();
  });

  it('counts a writer P2002 as an error and does not confirm', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    recordSuccessfulOutbound.mockRejectedValue(p2002());

    const result = await service.reconcile('user-1');

    expect(result).toMatchObject({ errors: 1, posted: 0, updated: 0 });
    expect(txUpdateMany).not.toHaveBeenCalled();
  });

  it('counts an exact writer replay as replayed and still confirms', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    recordSuccessfulOutbound.mockResolvedValue({ outcome: 'replayed' });

    const result = await service.reconcile('user-1');

    expect(result).toMatchObject({ replayed: 1, posted: 0, updated: 1 });
  });

  it('treats a finalized-period exact replay as replayed and completes the run', async () => {
    // BillingService returns { outcome: 'replayed' } for exact existing evidence
    // even when the accounting period is already finalized.
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    recordSuccessfulOutbound.mockResolvedValue({ outcome: 'replayed' });

    const result = await service.reconcile('user-1');

    expect(result).toMatchObject({ replayed: 1, conflicts: 0, posted: 0, updated: 1 });
    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'completed',
          summary: expect.objectContaining({
            complete: true,
            replayed: 1,
            conflicts: 0,
            accountingPeriods: ['2026-08-01T00:00:00.000Z'],
          }),
        }),
      }),
    );
  });

  it('counts a finalized-period divergent replay as a conflict and never confirms', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    recordSuccessfulOutbound.mockRejectedValue(
      new ConflictException('Billing usage event conflicts with an existing row'),
    );

    const result = await service.reconcile('user-1');

    expect(result).toMatchObject({ conflicts: 1, posted: 0, updated: 0 });
    expect(txUpdateMany).not.toHaveBeenCalled();
    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          summary: expect.objectContaining({ complete: false, conflicts: 1 }),
        }),
      }),
    );
  });

  it('counts finalized-period new evidence as a conflict and never confirms', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    recordSuccessfulOutbound.mockRejectedValue(
      new ConflictException(
        'Cannot append receipt evidence: the billing period is already finalized',
      ),
    );

    const result = await service.reconcile('user-1');

    expect(result).toMatchObject({ conflicts: 1, posted: 0, updated: 0 });
    expect(txUpdateMany).not.toHaveBeenCalled();
  });

  it('records run failure with error details and summary instead of swallowing', async () => {
    txFindMany.mockRejectedValue(new Error('database down'));

    await expect(service.reconcile('user-1')).rejects.toThrow('database down');

    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-1' },
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

    const result = await service.reconcile('user-1');

    expect(recordSuccessfulOutbound).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ scanned: 1, posted: 1, updated: 1 });
  });

  it('quarantines transactions on chains no longer in the supported config', async () => {
    mockCandidates([txRow({ chainId: 999_999n })]);

    const result = await service.reconcile('user-1');

    expect(getReceipt).not.toHaveBeenCalled();
    expect(recordSuccessfulOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: 'tx:tx-1:unsupported_chain',
        status: 'quarantined',
        reconciliationRunId: 'run-1',
        metadata: { reason: 'unsupported_chain' },
      }),
    );
    expect(result).toMatchObject({ quarantined: 1 });
  });

  it('creates the running run through the shared billing-period lock seam', async () => {
    mockCandidates([]);

    await service.reconcile('user-1');

    expect(withBillingPeriodLock).toHaveBeenCalledWith(
      'user-1',
      expect.any(Date),
      expect.any(Function),
    );
    // the run is created inside the lock callback via the transaction client
    expect(runCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'running',
        runType: 'receipt_outbound',
        source: 'openfort_receipt',
      }),
    });
  });

  it('persists complete:false and counters for a notFound run', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'not_found' });

    await service.reconcile('user-1');

    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-1' },
        data: expect.objectContaining({
          status: 'completed',
          summary: expect.objectContaining({
            userId: 'user-1',
            complete: false,
            notFound: 1,
            scanned: 1,
          }),
        }),
      }),
    );
  });

  it('persists complete:false and counters for a transientError run', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'error', message: 'receipt lookup failed' });

    await service.reconcile('user-1');

    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'completed',
          summary: expect.objectContaining({
            userId: 'user-1',
            complete: false,
            transientError: 1,
          }),
        }),
      }),
    );
  });

  it('persists complete:true and highWaterMark for a clean exhausted run', async () => {
    mockCandidates([txRow({ id: 'tx-1', createdAt: new Date('2026-08-01T00:00:00.000Z') })]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    await service.reconcile('user-1', { limit: 50 });

    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'completed',
          summary: expect.objectContaining({
            userId: 'user-1',
            complete: true,
            highWaterMark: {
              createdAt: '2026-08-01T00:00:00.000Z',
              id: 'tx-1',
            },
          }),
        }),
      }),
    );
  });

  it('picks the true max (createdAt, id) regardless of priority order', async () => {
    // priority order: pending first, then confirmed fill. The max createdAt is
    // NOT the last candidate in that order.
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

    await service.reconcile('user-1', { limit: 50 });

    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          summary: expect.objectContaining({
            complete: true,
            highWaterMark: { createdAt: '2026-08-03T00:00:00.000Z', id: 'tx-c1' },
          }),
        }),
      }),
    );
  });

  it('breaks createdAt ties by the lexicographically largest id', async () => {
    mockCandidates([
      txRow({ id: 'tx-a', createdAt: new Date('2026-08-01T00:00:00.000Z') }),
      txRow({ id: 'tx-b', createdAt: new Date('2026-08-01T00:00:00.000Z') }),
    ]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    await service.reconcile('user-1', { limit: 50 });

    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          summary: expect.objectContaining({
            highWaterMark: { createdAt: '2026-08-01T00:00:00.000Z', id: 'tx-b' },
          }),
        }),
      }),
    );
  });

  it('writes highWaterMark: null for an empty candidate set', async () => {
    mockCandidates([]);

    await service.reconcile('user-1');

    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          summary: expect.objectContaining({
            complete: true,
            highWaterMark: null,
          }),
        }),
      }),
    );
  });

  it('counts a finalized-period late append as a conflict and never confirms', async () => {
    mockCandidates([txRow()]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });
    // BillingService rejects receipt-backed appends after the period is
    // finalized (period-close barrier).
    recordSuccessfulOutbound.mockRejectedValue(
      new ConflictException(
        'Cannot append receipt evidence: the billing period is already finalized',
      ),
    );

    const result = await service.reconcile('user-1');

    expect(result).toMatchObject({ conflicts: 1, posted: 0, updated: 0 });
    expect(txUpdateMany).not.toHaveBeenCalled(); // never confirmed
    // the run is not complete and the conflict is surfaced as review risk
    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'completed',
          summary: expect.objectContaining({
            complete: false,
            conflicts: 1,
            userId: 'user-1',
          }),
        }),
      }),
    );
  });

  it('keeps complete:false and highWaterMark null when a candidate lacks createdAt', async () => {
    mockCandidates([txRow({ id: 'tx-1', createdAt: undefined })]);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    await service.reconcile('user-1', { limit: 50 });

    const call = runUpdate.mock.calls[0][0];
    expect(call.data.summary.highWaterMark).toBeNull();
    expect(call.data.summary.complete).toBe(false);
    expect(call.data.summary.errors).toBe(1);
  });

  it('keeps a limit-filled run complete:false even without errors', async () => {
    const filled = Array.from({ length: 50 }, (_, i) =>
      txRow({ id: `tx-${i}`, createdAt: new Date('2026-08-01T00:00:00.000Z') }),
    );
    mockCandidates(filled);
    getReceipt.mockResolvedValue({ status: 'success', receipt: successReceipt() });

    await service.reconcile('user-1', { limit: 50 });

    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'completed',
          summary: expect.objectContaining({
            userId: 'user-1',
            complete: false,
            scanned: 50,
          }),
        }),
      }),
    );
  });

  it('persists complete:false and sanitized error details on failure', async () => {
    txFindMany.mockRejectedValue(new Error('database down'));

    await expect(service.reconcile('user-1')).rejects.toThrow('database down');

    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-1' },
        data: expect.objectContaining({
          status: 'failed',
          errorDetails: 'database down',
          summary: expect.objectContaining({
            userId: 'user-1',
            complete: false,
            scanned: 0,
          }),
        }),
      }),
    );
  });
});
