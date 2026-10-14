import { PrismaService } from '../../core/database/prisma.service';
import { SecurityEventService } from '../security-events/security-event.service';
import { DefiPauseService } from './defi-pause.service';
import { DefiPauseOperator, DefiPauseScope, defiPauseScopeKey } from './defi.types';

const operator: DefiPauseOperator = { operatorId: '123e4567-e89b-42d3-a456-426614174000', reason: 'Emergency protocol review', reference: 'SEC-123' };
function harness(initial: string[] = []) {
  const state: { id: string; pausedScopeKeys: string[] } = { id: 'global', pausedScopeKeys: [...initial] };
  const tx = {
    $queryRaw: jest.fn(),
    defiPolicyState: {
      findUnique: jest.fn(async () => state),
      update: jest.fn(async ({ data }: { data: { pausedScopeKeys: string[] } }) => { state.pausedScopeKeys = data.pausedScopeKeys; return state; }),
    },
  };
  const prisma = {} as { $transaction: jest.Mock; options?: unknown };
  prisma.$transaction = jest.fn(async (work: (client: typeof tx) => unknown, options: unknown) => { prisma.options = options; return work(tx); });
  const events = { record: jest.fn().mockResolvedValue({ id: 'event', eventType: 'defi.paused' }), exportCommitted: jest.fn() };
  return { service: new DefiPauseService(prisma as unknown as PrismaService, events as unknown as SecurityEventService), state, tx, prisma, events };
}

describe('DefiPauseService', () => {
  const scopes: DefiPauseScope[] = [
    { kind: 'global' }, { kind: 'chain', chainId: 1 },
    { kind: 'contract', chainId: 1, address: '0x0000000000000000000000000000000000000001' },
    { kind: 'capability', capabilityId: 'cap:fixture:v1' },
  ];

  it.each(scopes)('locks and atomically audits pause scope %s', async (scope) => {
    const h = harness();
    await expect(h.service.setPaused(scope, true, operator)).resolves.toEqual({ changed: true });
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(h.state.pausedScopeKeys).toEqual([defiPauseScopeKey(scope)]);
    expect(h.events.record).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'system', eventType: 'defi.paused', result: 'allowed', reason: operator.reason }), h.tx, { deferExport: true });
    expect(h.events.exportCommitted).toHaveBeenCalledTimes(1);
    expect(h.prisma.options).toMatchObject({ isolationLevel: 'ReadCommitted' });
  });

  it('does not write or export audit on a no-op', async () => {
    const h = harness(['global']);
    await expect(h.service.setPaused({ kind: 'global' }, true, operator)).resolves.toEqual({ changed: false });
    expect(h.tx.defiPolicyState.update).not.toHaveBeenCalled();
    expect(h.events.record).not.toHaveBeenCalled();
    expect(h.events.exportCommitted).not.toHaveBeenCalled();
  });

  it('validates operator evidence and fails closed with stable error when singleton is missing', async () => {
    const h = harness();
    await expect(h.service.setPaused({ kind: 'global' }, true, { ...operator, operatorId: 'not-a-uuid' })).rejects.toThrow(/operator/);
    h.tx.defiPolicyState.findUnique.mockResolvedValue(null as never);
    await expect(h.service.setPaused({ kind: 'global' }, true, operator)).rejects.toMatchObject({ response: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    expect(h.events.record).not.toHaveBeenCalled();
  });

  it('never exports an audit when the transaction rolls back', async () => {
    const h = harness();
    h.events.record.mockRejectedValue(new Error('audit insert failed'));
    await expect(h.service.setPaused({ kind: 'chain', chainId: 1 }, true, operator)).rejects.toMatchObject({ response: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    expect(h.events.exportCommitted).not.toHaveBeenCalled();
  });
});
