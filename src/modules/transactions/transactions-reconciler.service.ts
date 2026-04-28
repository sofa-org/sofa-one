import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionsService } from './transactions.service';

@Injectable()
export class TransactionsReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TransactionsReconcilerService.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private readonly batchSize: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly configService: ConfigService,
  ) {
    this.enabled = this.configService.get<boolean>('transactions.reconciler.enabled', true);
    this.intervalMs = this.configService.get<number>('transactions.reconciler.intervalMs', 60_000);
    this.staleAfterMs = this.configService.get<number>(
      'transactions.reconciler.staleAfterMs',
      300_000,
    );
    this.batchSize = this.configService.get<number>('transactions.reconciler.batchSize', 50);
  }

  onModuleInit() {
    if (!this.enabled) {
      this.logger.log('Transaction reconciler disabled');
      return;
    }

    this.timer = setInterval(() => {
      void this.reconcileOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async reconcileOnce() {
    if (this.running) return { skipped: true, reason: 'already_running' };

    this.running = true;
    try {
      const olderThan = new Date(Date.now() - this.staleAfterMs);
      const result = await this.transactionsService.reconcileStaleTransactions({
        olderThan,
        limit: this.batchSize,
      });

      if (result.checked > 0) {
        this.logger.log(`Reconciled ${result.checked} stale transactions`);
      }

      return { skipped: false, ...result };
    } catch (error) {
      this.logger.error(
        'Transaction reconciler run failed',
        error instanceof Error ? error.stack : error,
      );
      return { skipped: true, reason: 'failed' };
    } finally {
      this.running = false;
    }
  }
}
