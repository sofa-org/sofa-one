import { encodeFunctionData, parseAbi } from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import { SecurityEventService } from '../security-events/security-event.service';
import { DefiCatalogService } from './defi-catalog.service';
import { DefiPolicyService, buildDefiRequestCommitment } from './defi-policy.service';
import { buildReviewedManifest } from './registry/defi-manifest';
import { DefiChainPolicy, DefiExecutionContext, DefiInteraction, DefiPolicyDenial } from './defi.types';
import { POLYMARKET_PUSD_WRAP_ABI, POLYMARKET_PUSD_WRAP_IDENTITY, POLYMARKET_PUSD_WRAP_SCOPE } from './execution/pusd-identity';

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

  describe('restricted Polygon pUSD wrap lane', () => {
    const wrapFn: any = {
      capabilityId: POLYMARKET_PUSD_WRAP_IDENTITY.capabilityId, type: 'contract_call', chainId: 137,
      contract: POLYMARKET_PUSD_WRAP_IDENTITY.contract, signature: POLYMARKET_PUSD_WRAP_IDENTITY.signature,
      functionName: 'wrap', abi: POLYMARKET_PUSD_WRAP_ABI[0], executionScope: POLYMARKET_PUSD_WRAP_SCOPE,
      policy: { ref: 'fixture', version: 1 }, status: 'active',
      provenance: { sourceRef: 'fixture verified ABI', verifiedAt: '2026-01-01', status: 'verified' },
    };
    const chain: DefiChainPolicy[] = [{ chainId: 137, status: 'active', contracts: [{ address: wrapFn.contract, status: 'active', functions: [wrapFn] }] }];
    const wrapManifest = buildReviewedManifest([{ chains: chain }]);
    const wrapContext: DefiExecutionContext = { ...ctx, chainId: 137, allowedCapabilityIds: [wrapFn.capabilityId] };
    const call = (asset: string = POLYMARKET_PUSD_WRAP_IDENTITY.asset, recipient: string = OTHER, amount = 9n, value?: string): DefiInteraction => ({
      to: wrapFn.contract,
      data: encodeFunctionData({ abi: POLYMARKET_PUSD_WRAP_ABI, functionName: 'wrap', args: [asset as `0x${string}`, recipient as `0x${string}`, amount] }),
      ...(value === undefined ? {} : { value }),
    });
    const makeWrapPolicy = (pausedScopeKeys: string[] = []) => {
      const db = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) } };
      return new DefiPolicyService(db as unknown as PrismaService, {} as SecurityEventService,
        new DefiCatalogService(chain, db as unknown as PrismaService, wrapManifest));
    };

    it('accepts canonical zero-native USDC.e wrap with the exact admitted identity and scope', async () => {
      await expect(makeWrapPolicy().authorizeContractCalls([call()], wrapContext)).resolves.toMatchObject({
        matches: [{ capabilityId: wrapFn.capabilityId, executionScopeHash: expect.any(String) }],
      });
    });

    it.each([
      ['wrong asset', call(OTHER)],
      ['native USDC', call('0x3c499c542cef5e3811e1192ce70d8cc03d5c3359')],
      ['nonzero native value', call(POLYMARKET_PUSD_WRAP_IDENTITY.asset, OTHER, 1n, '1')],
    ])('denies %s regardless of destination policy', async (_label, interaction) => {
      await expect(makeWrapPolicy().authorizeContractCalls([interaction], wrapContext))
        .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    });

    it('rejects mixed top-level calls and wrap hidden inside a scope', async () => {
      await expect(makeWrapPolicy().authorizeContractCalls([call(), { to: ADDRESS, data: touch() }], wrapContext))
        .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      const scoped: any = { ...wrapFn, executionScope: { kind: 'empty-callback-data-v1', bytesArgIndex: 0 } };
      const badChain: DefiChainPolicy[] = [{ chainId: 137, status: 'active', contracts: [{ address: scoped.contract, status: 'active', functions: [scoped] }] }];
      expect(() => buildReviewedManifest([{ chains: badChain }])).toThrow(/Invalid Polymarket pUSD wrap identity/);
    });

    it('rejects a moved reserved capability ID even when it has no pUSD scope', async () => {
      const moved: any = {
        ...catalog[0].contracts[0].functions[0],
        capabilityId: POLYMARKET_PUSD_WRAP_IDENTITY.capabilityId,
      };
      const movedCatalog: DefiChainPolicy[] = [{ chainId: 1, status: 'active', contracts: [{ address: ADDRESS, status: 'active', functions: [moved] }] }];
      const db = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
      const policy = new DefiPolicyService(db as unknown as PrismaService, {} as SecurityEventService,
        { manifest: () => wrapManifest, activeChain: () => movedCatalog[0] } as unknown as DefiCatalogService);
      await expect(policy.authorizeContractCalls([{ to: ADDRESS, data: touch() }], {
        ...ctx, allowedCapabilityIds: [POLYMARKET_PUSD_WRAP_IDENTITY.capabilityId],
      })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    });

    it('enforces grant, pause, and final authorization against live grant/pause state', async () => {
      await expect(makeWrapPolicy().authorizeContractCalls([call()], { ...wrapContext, allowedCapabilityIds: [] }))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(makeWrapPolicy(['global']).authorizeContractCalls([call()], wrapContext))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
      const policy = makeWrapPolicy();
      const authorization = await policy.authorizeContractCalls([call()], wrapContext);
      const tx: any = {
        $queryRaw: jest.fn(),
        defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) },
        apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: 'user', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: [wrapFn.capabilityId] }) },
      };
      await expect(policy.assertStillAuthorized(tx, authorization)).resolves.toBeUndefined();
      tx.defiPolicyState.findUnique.mockResolvedValue({ id: 'global', pausedScopeKeys: ['global'] });
      await expect(policy.assertStillAuthorized(tx, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
    });
  });
});
