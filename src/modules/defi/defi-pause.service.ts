import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { SecurityEventService } from '../security-events/security-event.service';
import { DefiDbClient, DefiPauseOperator, DefiPauseScope, defiPauseScopeKey } from './defi.types';
import { ServiceUnavailableException } from '@nestjs/common';

@Injectable()
export class DefiPauseService {
  constructor(private readonly prisma: PrismaService, private readonly events: SecurityEventService) {}
  async lockForAuthorization(tx: DefiDbClient) {
    try {
      await tx.$queryRaw`SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE`;
      const state = await tx.defiPolicyState.findUnique({ where: { id: 'global' } });
      if (!state) throw unavailable();
      return state;
    } catch { throw unavailable(); }
  }
  async setPaused(scope: DefiPauseScope, paused: boolean, operator: DefiPauseOperator): Promise<{ changed: boolean }> {
    validateOperator(operator);
    if (typeof paused !== 'boolean') throw invalidRequest('Invalid pause action');
    let scopeKey: string;
    try { scopeKey = defiPauseScopeKey(scope); } catch { throw invalidRequest('Invalid DeFi pause scope'); }
    let event;
    try {
      event = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM defi_policy_state WHERE id = 'global' FOR UPDATE`;
        const state = await tx.defiPolicyState.findUnique({ where: { id: 'global' } });
        if (!state) throw unavailable();
        const keys = new Set<string>(state.pausedScopeKeys);
        if (keys.has(scopeKey) === paused) return { changed: false as const, event: undefined };
        if (paused) keys.add(scopeKey);
        else keys.delete(scopeKey);
        await tx.defiPolicyState.update({ where: { id: 'global' }, data: { pausedScopeKeys: [...keys].sort(), updatedAt: new Date() } });
        const event = await this.events.record({ actorType: 'system', eventType: paused ? 'defi.paused' : 'defi.unpaused', result: 'allowed', reason: operator.reason.trim(), metadata: { scope: scopeKey, operatorId: operator.operatorId, reference: operator.reference } as Prisma.InputJsonValue }, tx, { deferExport: true });
        return { changed: true as const, event };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch { throw unavailable(); }
    if (event.event) await this.events.exportCommitted(event.event as { eventType?: string });
    return { changed: event.changed };
  }
}

function validateOperator(operator: DefiPauseOperator): void {
  if (!operator || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operator.operatorId)) throw invalidRequest('Invalid DeFi pause operator');
  if (typeof operator.reason !== 'string' || operator.reason.trim().length < 8 || operator.reason.trim().length > 255 || [...operator.reason].some((character) => { const code = character.charCodeAt(0); return code <= 0x1f || code === 0x7f; })) throw invalidRequest('Invalid DeFi pause reason');
  if (typeof operator.reference !== 'string' || !/^[A-Za-z0-9._:/-]{1,120}$/.test(operator.reference)) throw invalidRequest('Invalid DeFi pause reference');
}
function unavailable(): ServiceUnavailableException { return new ServiceUnavailableException({ code: 'DEFI_POLICY_UNAVAILABLE', message: 'DeFi policy is unavailable' }); }
function invalidRequest(message: string): BadRequestException { return new BadRequestException({ code: 'DEFI_INVALID_PARAMETERS', message }); }
