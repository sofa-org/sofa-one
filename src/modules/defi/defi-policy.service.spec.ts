import { encodeFunctionData, parseAbi } from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import { SecurityEventService } from '../security-events/security-event.service';
import { DefiCatalogService } from './defi-catalog.service';
import { DefiPolicyService } from './defi-policy.service';
import { buildReviewedManifest } from './registry/defi-manifest';
import { DefiChainPolicy, DefiExecutionContext, DefiInteraction, DefiPolicyDenial } from './defi.types';

const ABI = parseAbi(['function touch(address owner, uint256 amount)']);
const ADDRESS = '0x0000000000000000000000000000000000000001';
const OWNER = '0x0000000000000000000000000000000000000002';
const catalog: DefiChainPolicy[] = [{ chainId: 1, status: 'active', contracts: [{ address: ADDRESS, status: 'active', functions: [{
  capabilityId: 'fixture:touch:v1', type: 'contract_call', chainId: 1, contract: ADDRESS,
  functionSignature: 'touch(address,uint256)', signature: 'touch(address,uint256)', functionName: 'touch', abi: ABI[0],
  policy: { ref: 'fixture', version: 1 }, status: 'active', validate: (args) => args[0] === OWNER && args[1] === 7n,
  describe: (_args, _context, index) => ({ kind: 'action', index, operation: 'supply', deploymentRef: 'fixture', token: OWNER, amount: 7n }),
}] }] }];
const ctx = { userId: 'user', apiKeyId: 'key', walletId: 'wallet', chainId: 1, executionMode: 'session_key', executionOwner: OWNER, allowedCapabilityIds: ['fixture:touch:v1'] };
const callData = encodeFunctionData({ abi: ABI, functionName: 'touch', args: [OWNER, 7n] });
const manifest = buildReviewedManifest([{chains:[],assets:[{ref:`asset:1:${OWNER}`,chainId:1,address:OWNER,symbol:'USDC',decimals:6,maxOperationRaw:100n,deploymentRef:'asset-dep'}],deployments:[{ref:'asset-dep',chainId:1,address:OWNER,status:'candidate',sourceRef:'fixture',identityChecks:[]}],priceFeeds:[],pools:[],activationEvidence:[]}]);
const makePolicy = (pausedScopeKeys: string[] = []) => {
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) } };
  return { policy: new DefiPolicyService(prisma as unknown as PrismaService, {} as SecurityEventService, new DefiCatalogService(catalog, prisma as unknown as PrismaService, manifest)), prisma };
};

describe('DefiPolicyService', () => {
  it('authorizes fixed ABI calls after hierarchy, grant, pause, canonical, value and synchronous validator checks', async () => {
    const { policy } = makePolicy();
    const result = await policy.authorizeContractCalls([{ to: ADDRESS, data: callData, value: 0 }], ctx);
    expect(result.matches).toEqual([{ capabilityId: 'fixture:touch:v1', type: 'contract_call', chainId: 1, contract: ADDRESS, functionSignature: 'touch(address,uint256)', policy: { ref: 'fixture', version: 1 } }]);
  });

  it.each([
    ['unknown chain', { ...ctx, chainId: 2 }, { to: ADDRESS, data: '0xdeadbeef' }, 'DEFI_CAPABILITY_NOT_FOUND'],
    ['unknown contract', ctx, { to: OWNER, data: callData }, 'DEFI_CONTRACT_NOT_ALLOWED'],
    ['unknown function', ctx, { to: ADDRESS, data: '0xdeadbeef' }, 'DEFI_FUNCTION_NOT_ALLOWED'],
    ['missing grant', { ...ctx, allowedCapabilityIds: [] }, { to: ADDRESS, data: callData }, 'DEFI_CAPABILITY_NOT_GRANTED'],
    ['global pause', ctx, { to: ADDRESS, data: callData }, 'DEFI_CAPABILITY_PAUSED', ['global']],
    ['chain pause', ctx, { to: ADDRESS, data: callData }, 'DEFI_CAPABILITY_PAUSED', ['chain:1']],
    ['contract pause', ctx, { to: ADDRESS, data: callData }, 'DEFI_CAPABILITY_PAUSED', [`contract:1:${ADDRESS}`]],
    ['capability pause', ctx, { to: ADDRESS, data: callData }, 'DEFI_CAPABILITY_PAUSED', ['capability:fixture:touch:v1']],
    ['noncanonical calldata', ctx, { to: ADDRESS, data: `${callData}00` }, 'DEFI_INVALID_PARAMETERS'],
    ['nonzero native value', ctx, { to: ADDRESS, data: callData, value: 1n }, 'DEFI_INVALID_PARAMETERS'],
    ['validator rejects args', ctx, { to: ADDRESS, data: encodeFunctionData({ abi: ABI, functionName: 'touch', args: [OWNER, 8n] }) }, 'DEFI_INVALID_PARAMETERS'],
  ])('denies %s with the stable code before downstream execution', async (_name: string, context: DefiExecutionContext, interaction: DefiInteraction, code: string, pause: string[] = []) => {
    const { policy } = makePolicy([...pause]);
    await expect(policy.authorizeContractCalls([interaction], context)).rejects.toMatchObject({ audit: { code } });
  });

  it('always denies signing in this release', () => expect(() => makePolicy().policy.authorizeSigning({}, ctx)).toThrow(DefiPolicyDenial));
  it('rejects empty batches and invalid owners', async () => {
    const { policy } = makePolicy();
    await expect(policy.authorizeContractCalls([], ctx)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([{ to: ADDRESS, data: callData }], { ...ctx, executionOwner: 'not-an-address' })).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });
  it('fails closed when pause state is absent', async () => {
    const { policy, prisma } = makePolicy();
    jest.mocked(prisma.defiPolicyState.findUnique).mockResolvedValue(null);
    await expect(policy.authorizeContractCalls([{ to: ADDRESS, data: callData }], ctx)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
  });

  it('final authorization rechecks row locks, grants, pause state, and identity with distinct stable denials', async () => {
    const { policy } = makePolicy();
    const authorization = await policy.authorizeContractCalls([{ to: ADDRESS, data: callData }], ctx);
    const tx = {
      $queryRaw: jest.fn(),
      defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) },
      apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: 'user', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: ['fixture:touch:v1'] }) },
    };
    const evidence = { requestCommitment: authorization.requestCommitment, manifestHash: authorization.manifestHash, chainId: 1, executionOwner: OWNER, blockNumber: 1n, blockHash: `0x${'1'.repeat(64)}`, observedAtMs: Date.now(), expiresAtMs: Date.now()+10_000, checksDigest: `0x${'2'.repeat(64)}` } as const;
    await expect(policy.assertStillAuthorized(tx as never, authorization, evidence)).resolves.toBeUndefined();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    tx.defiPolicyState.findUnique.mockResolvedValue({ id: 'global', pausedScopeKeys: ['global'] });
    await expect(policy.assertStillAuthorized(tx as never, authorization, evidence)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
    tx.defiPolicyState.findUnique.mockResolvedValue({ id: 'global', pausedScopeKeys: [] });
    tx.apiKey.findUnique.mockResolvedValue({ userId: 'user', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: [] });
    await expect(policy.assertStillAuthorized(tx as never, authorization, evidence)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
  });

  it('records allowlisted denial metadata without calldata and never masks denial if audit fails', async () => {
    const events = { record: jest.fn().mockResolvedValue(undefined) };
    const { prisma } = makePolicy();
    const policy = new DefiPolicyService(prisma as unknown as PrismaService, events as unknown as SecurityEventService, new DefiCatalogService(catalog, prisma as unknown as PrismaService, manifest));
    const denial = await policy.authorizeContractCalls([{ to: ADDRESS, data: '0xdeadbeef' }], ctx).then(() => { throw new Error('Expected denial'); }, (error) => error as DefiPolicyDenial) as unknown as DefiPolicyDenial;
    await expect(policy.recordDenied(denial)).resolves.toBeUndefined();
    const input = events.record.mock.calls[0][0];
    expect(input.metadata).toMatchObject({ code: 'DEFI_FUNCTION_NOT_ALLOWED', chainId: 1, executionMode: 'session_key', executionOwner: OWNER });
    expect(JSON.stringify(input)).not.toContain(callData);
    events.record.mockRejectedValue(new Error('audit unavailable'));
    await expect(policy.recordDenied(denial)).resolves.toBeUndefined();
  });

  it('defers allowed event export to the transaction caller', async () => {
    const events = { record: jest.fn().mockResolvedValue({ eventType: 'defi.capability_allowed' }) };
    const { prisma } = makePolicy();
    const policy = new DefiPolicyService(prisma as unknown as PrismaService, events as unknown as SecurityEventService, new DefiCatalogService(catalog, prisma as unknown as PrismaService, manifest));
    const authorization = await policy.authorizeContractCalls([{ to: ADDRESS, data: callData }], ctx);
    await policy.recordAllowedInTx({} as never, authorization);
    expect(events.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'defi.capability_allowed' }), {}, { deferExport: true });
  });
});
