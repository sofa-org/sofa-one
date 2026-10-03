import { encodeFunctionData, parseAbi } from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import { SecurityEventService } from '../security-events/security-event.service';
import { DefiCatalogService } from './defi-catalog.service';
import { DefiPolicyService, buildDefiRequestCommitment } from './defi-policy.service';
import { buildReviewedManifest } from './registry/defi-manifest';
import { DefiChainPolicy, DefiExecutionContext, DefiInteraction, DefiPolicyDenial } from './defi.types';

const ABI = parseAbi(['function touch(address owner, uint256 amount)', 'function deposit(address owner, uint256 amount) payable']);
const ADDRESS = '0x0000000000000000000000000000000000000001';
const OWNER = '0x0000000000000000000000000000000000000002';
const OTHER = '0x0000000000000000000000000000000000000003';
const capabilities = ['fixture:touch:v1', 'fixture:deposit:v1'];
const catalog: DefiChainPolicy[] = [{ chainId: 1, status: 'active', contracts: [{ address: ADDRESS, status: 'active', functions: ABI.map((abi, index) => ({
  capabilityId: capabilities[index], type: 'contract_call' as const, chainId: 1, contract: ADDRESS,
  signature: `${abi.name}(${abi.inputs.map((input) => input.type).join(',')})`, functionName: abi.name, abi,
  policy: { ref: 'fixture', version: 1 }, status: 'active' as const,
  provenance: { sourceRef: 'fixture verified ABI', verifiedAt: '2026-01-01', status: 'verified' as const },
})) }] }];
const ctx: DefiExecutionContext = { userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId: 1, executionMode: 'session_key', executionOwner: OWNER, allowedCapabilityIds: capabilities };
const touch = (owner: `0x${string}` = OWNER as `0x${string}`, amount = 7n) => encodeFunctionData({ abi: ABI, functionName: 'touch', args: [owner, amount] });
const deposit = (owner: `0x${string}` = OWNER as `0x${string}`, amount = 7n) => encodeFunctionData({ abi: ABI, functionName: 'deposit', args: [owner, amount] });
const manifest = buildReviewedManifest([{ chains: catalog }]);
const makePolicy = (pausedScopeKeys: string[] = []) => {
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) } };
  return { policy: new DefiPolicyService(prisma as unknown as PrismaService, {} as SecurityEventService, new DefiCatalogService(catalog, prisma as unknown as PrismaService, manifest)), prisma };
};

describe('DefiPolicyService', () => {
  it('authorizes an explicitly granted fixed ABI call without restricting caller-selected financial arguments', async () => {
    const { policy } = makePolicy();
    const result = await policy.authorizeContractCalls([{ to: ADDRESS, data: touch(OTHER, 2n ** 255n) }], ctx);
    expect(result.matches[0]).toMatchObject({ capabilityId: capabilities[0], type: 'contract_call', chainId: 1, contract: ADDRESS, functionSignature: 'touch(address,uint256)', abiHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
  });

  it.each([
    ['unknown chain', { ...ctx, chainId: 2 }, { to: ADDRESS, data: touch() }, 'DEFI_CAPABILITY_NOT_FOUND'],
    ['unknown contract', ctx, { to: OTHER, data: touch() }, 'DEFI_CONTRACT_NOT_ALLOWED'],
    ['unknown selector', ctx, { to: ADDRESS, data: '0xdeadbeef' }, 'DEFI_FUNCTION_NOT_ALLOWED'],
    ['missing grant', { ...ctx, allowedCapabilityIds: [] }, { to: ADDRESS, data: touch() }, 'DEFI_CAPABILITY_NOT_GRANTED'],
    ['global pause', ctx, { to: ADDRESS, data: touch() }, 'DEFI_CAPABILITY_PAUSED', ['global']],
    ['chain pause', ctx, { to: ADDRESS, data: touch() }, 'DEFI_CAPABILITY_PAUSED', ['chain:1']],
    ['contract pause', ctx, { to: ADDRESS, data: touch() }, 'DEFI_CAPABILITY_PAUSED', [`contract:1:${ADDRESS}`]],
    ['capability pause', ctx, { to: ADDRESS, data: touch() }, 'DEFI_CAPABILITY_PAUSED', ['capability:fixture:touch:v1']],
    ['trailing noncanonical calldata', ctx, { to: ADDRESS, data: `${touch()}00` }, 'DEFI_INVALID_PARAMETERS'],
    ['negative value', ctx, { to: ADDRESS, data: touch(), value: '-1' }, 'DEFI_INVALID_PARAMETERS'],
    ['overflow value', ctx, { to: ADDRESS, data: touch(), value: (1n << 256n).toString() }, 'DEFI_INVALID_PARAMETERS'],
    ['nonpayable nonzero value', ctx, { to: ADDRESS, data: touch(), value: 1n }, 'DEFI_INVALID_PARAMETERS'],
    ['malformed calldata', ctx, { to: ADDRESS, data: `${touch().slice(0, 10)}00` }, 'DEFI_INVALID_PARAMETERS'],
  ])('denies %s with stable code', async (_name: string, context: DefiExecutionContext, interaction: DefiInteraction, code: string, pause: string[] = []) => {
    const { policy } = makePolicy([...pause]);
    await expect(policy.authorizeContractCalls([interaction], context)).rejects.toMatchObject({ audit: { code } });
  });

  it('accepts arbitrary spender and unlimited approval-style arguments when the exact function is granted', async () => {
    const { policy } = makePolicy();
    const data = touch(OTHER, (1n << 256n) - 1n);
    await expect(policy.authorizeContractCalls([{ to: ADDRESS, data }], ctx)).resolves.toMatchObject({ interactions: [{ data }] });
  });

  it('accepts payable native value only as an exact nonnegative uint256', async () => {
    const { policy } = makePolicy();
    await expect(policy.authorizeContractCalls([{ to: ADDRESS, data: deposit(), value: '5' }], ctx)).resolves.toMatchObject({ interactions: [{ value: '5' }] });
    await expect(policy.authorizeContractCalls([{ to: ADDRESS, data: deposit(), value: (1n << 256n) - 1n }], ctx)).resolves.toBeDefined();
  });

  it('always denies signing and rejects empty batches and invalid owners', async () => {
    expect(() => makePolicy().policy.authorizeSigning({}, ctx)).toThrow(DefiPolicyDenial);
    const { policy } = makePolicy();
    await expect(policy.authorizeContractCalls([], ctx)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([{ to: ADDRESS, data: touch() }], { ...ctx, executionOwner: 'not-an-address' })).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it('fails closed when pause state is absent', async () => {
    const { policy, prisma } = makePolicy();
    jest.mocked(prisma.defiPolicyState.findUnique).mockResolvedValue(null);
    await expect(policy.authorizeContractCalls([{ to: ADDRESS, data: touch() }], ctx)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
  });

  it('rechecks immutable request commitment, live grant, pause, key state, and catalog identity under locks with no RPC', async () => {
    const { policy } = makePolicy();
    const authorization = await policy.authorizeContractCalls([{ to: ADDRESS, data: touch(OTHER, 99n) }], ctx);
    expect(Object.isFrozen(authorization)).toBe(true);
    expect(Object.isFrozen(authorization.interactions[0])).toBe(true);
    expect(authorization.requestCommitment).toBe(buildDefiRequestCommitment(authorization.interactions, authorization.context, authorization.manifestHash));
    const tx = {
      $queryRaw: jest.fn(),
      defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) },
      apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: 'user', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: capabilities }) },
    };
    await expect(policy.assertStillAuthorized(tx as never, authorization)).resolves.toBeUndefined();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    tx.defiPolicyState.findUnique.mockResolvedValue({ id: 'global', pausedScopeKeys: ['global'] });
    await expect(policy.assertStillAuthorized(tx as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
    tx.defiPolicyState.findUnique.mockResolvedValue({ id: 'global', pausedScopeKeys: [] });
    tx.apiKey.findUnique.mockResolvedValue({ userId: 'user', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: [] });
    await expect(policy.assertStillAuthorized(tx as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    tx.apiKey.findUnique.mockResolvedValue({ userId: 'user', revoked: true, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: capabilities });
    await expect(policy.assertStillAuthorized(tx as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    tx.apiKey.findUnique.mockResolvedValue({ userId: 'somebody-else', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: capabilities });
    await expect(policy.assertStillAuthorized(tx as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    tx.apiKey.findUnique.mockResolvedValue({ userId: 'user', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: capabilities });
    await expect(policy.assertStillAuthorized(tx as never, { ...authorization, requestCommitment: `0x${'0'.repeat(64)}` })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    const tamperedMatch = { ...authorization, matches: [{ ...authorization.matches[0], abiHash: `0x${'0'.repeat(64)}` as `0x${string}` }, authorization.matches[1]] };
    await expect(policy.assertStillAuthorized(tx as never, tamperedMatch)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(14);
  });

  it('records allowlisted denial metadata without calldata and never masks denial if audit fails', async () => {
    const events = { record: jest.fn().mockResolvedValue(undefined) };
    const { prisma } = makePolicy();
    const policy = new DefiPolicyService(prisma as unknown as PrismaService, events as unknown as SecurityEventService, new DefiCatalogService(catalog, prisma as unknown as PrismaService, manifest));
    const denial = await policy.authorizeContractCalls([{ to: ADDRESS, data: '0xdeadbeef' }], ctx).then(() => { throw new Error('Expected denial'); }, (error) => error as DefiPolicyDenial);
    await expect(policy.recordDenied(denial)).resolves.toBeUndefined();
    const input = events.record.mock.calls[0][0];
    expect(input.metadata).toMatchObject({ code: 'DEFI_FUNCTION_NOT_ALLOWED', chainId: 1, executionMode: 'session_key', executionOwner: OWNER });
    expect(JSON.stringify(input)).not.toContain(touch());
    events.record.mockRejectedValue(new Error('audit unavailable'));
    await expect(policy.recordDenied(denial)).resolves.toBeUndefined();
  });

  it('defers allowed event export to the transaction caller', async () => {
    const events = { record: jest.fn().mockResolvedValue({ eventType: 'defi.capability_allowed' }) };
    const { prisma } = makePolicy();
    const policy = new DefiPolicyService(prisma as unknown as PrismaService, events as unknown as SecurityEventService, new DefiCatalogService(catalog, prisma as unknown as PrismaService, manifest));
    const authorization = await policy.authorizeContractCalls([{ to: ADDRESS, data: touch() }], ctx);
    await policy.recordAllowedInTx({} as never, authorization);
    expect(events.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'defi.capability_allowed' }), {}, { deferExport: true });
  });
});
