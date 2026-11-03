import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SecurityEventService } from '../security-events/security-event.service';

const WINDOW_MS = 60_000;
const LIMIT = 60;
const LOCK_PREFIX = 'polymarket_order_signing_wallet:';

@Injectable()
export class PolymarketSigningBudgetService {
  constructor(private readonly securityEvents: SecurityEventService) {}

  async acquireWalletLock(tx: Prisma.TransactionClient, walletId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_PREFIX + walletId}))`;
  }

  async recordAcceptedInTransaction(tx: Prisma.TransactionClient, input: { walletId: string; userId: string; apiKeyId: string; apiKeyPrefix?: string }) {
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    const cutoff = new Date(now.getTime() - WINDOW_MS);
    const count = await tx.securityEvent.count({ where: { walletId: input.walletId, eventType: 'polymarket_order_signing_accepted', createdAt: { gt: cutoff } } });
    if (count >= LIMIT) {
      const oldest = await tx.securityEvent.findFirst({ where: { walletId: input.walletId, eventType: 'polymarket_order_signing_accepted', createdAt: { gt: cutoff } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
      const retryAfterSeconds = Math.max(1, Math.ceil((WINDOW_MS - (now.getTime() - (oldest?.createdAt.getTime() ?? cutoff.getTime()))) / 1000));
      throw new HttpException({ code: 'POLYMARKET_SIGN_RATE_LIMITED', message: 'Polymarket order signing rate limit exceeded', retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const event = await this.securityEvents.record({ actorType: 'api_key', eventType: 'polymarket_order_signing_accepted', userId: input.userId, apiKeyId: input.apiKeyId, walletId: input.walletId, result: 'allowed', reason: 'polymarket_order_signing_accepted', metadata: { apiKeyPrefix: input.apiKeyPrefix ?? null, windowSeconds: 60 }, createdAt: now }, tx, { deferExport: true });
    return event;
  }

  async exportAccepted(event: unknown): Promise<void> { await this.securityEvents.exportCommitted(event); }
}
