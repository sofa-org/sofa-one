jest.mock('./transactions.service', () => ({
  TransactionsService: class TransactionsService {},
}));

import { TransactionsReconcilerService } from './transactions-reconciler.service';

describe('TransactionsReconcilerService', () => {
  const transactionsService = {
    reconcileStaleTransactions: jest.fn(),
  };
  const configService = {
    get: jest.fn((key: string, fallback: unknown) => {
      const values: Record<string, unknown> = {
        'transactions.reconciler.enabled': true,
        'transactions.reconciler.intervalMs': 1000,
        'transactions.reconciler.staleAfterMs': 5000,
        'transactions.reconciler.batchSize': 7,
      };
      return values[key] ?? fallback;
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    transactionsService.reconcileStaleTransactions.mockResolvedValue({
      checked: 0,
      transactions: [],
    });
  });

  it('runs reconciliation with configured stale window and batch size', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-28T10:00:00.000Z'));
    const service = new TransactionsReconcilerService(
      transactionsService as any,
      configService as any,
    );

    await expect(service.reconcileOnce()).resolves.toEqual({
      skipped: false,
      checked: 0,
      transactions: [],
    });

    expect(transactionsService.reconcileStaleTransactions).toHaveBeenCalledWith({
      olderThan: new Date('2026-04-28T09:59:55.000Z'),
      limit: 7,
    });
    jest.useRealTimers();
  });

  it('skips overlapping reconciliation runs', async () => {
    let resolveRun!: (value: { checked: number; transactions: never[] }) => void;
    transactionsService.reconcileStaleTransactions.mockReturnValue(
      new Promise((resolve) => {
        resolveRun = resolve;
      }),
    );
    const service = new TransactionsReconcilerService(
      transactionsService as any,
      configService as any,
    );

    const firstRun = service.reconcileOnce();
    await expect(service.reconcileOnce()).resolves.toEqual({
      skipped: true,
      reason: 'already_running',
    });

    resolveRun({ checked: 0, transactions: [] });
    await expect(firstRun).resolves.toEqual({ skipped: false, checked: 0, transactions: [] });
  });
});
