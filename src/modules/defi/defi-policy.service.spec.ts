import { encodeFunctionData, parseAbi } from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import { SecurityEventService } from '../security-events/security-event.service';
import { DefiCatalogService } from './defi-catalog.service';
import { DefiPolicyService, buildDefiRequestCommitment } from './defi-policy.service';
import { buildReviewedManifest } from './registry/defi-manifest';
import { DefiChainPolicy, DefiExecutionContext, DefiInteraction, DefiPolicyDenial } from './defi.types';
import { POLYMARKET_PUSD_WRAP_ABI, POLYMARKET_PUSD_WRAP_IDENTITY, POLYMARKET_PUSD_WRAP_SCOPE } from './execution/pusd-identity';
import { POLYMARKET_CLOB_AUTH_CAPABILITY_ID, POLYMARKET_CLOB_AUTH_ATTESTATION } from './signing/polymarket-clob-auth';

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

  it('authorizes capabilities in its reviewed catalog snapshot with all mode but not empty custom mode', async () => {
    const { policy } = makePolicy();
    await expect(policy.authorizeContractCalls([{ to: ADDRESS, data: touch() }], { ...ctx, capabilityMode: 'all', allowedCapabilityIds: [] })).resolves.toMatchObject({ matches: [{ capabilityId: capabilities[0] }] });
    await expect(policy.authorizeContractCalls([{ to: ADDRESS, data: touch() }], { ...ctx, capabilityMode: 'custom', allowedCapabilityIds: [] })).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([{ to: ADDRESS, data: touch() }], { ...ctx, capabilityMode: 'future' as any, allowedCapabilityIds: capabilities })).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
  });

  it('allows a newly reviewed catalog member through all mode without an ID grant and denies it to old custom membership', async () => {
    const previous = makePolicy().policy;
    const newAbi = parseAbi(['function newlyActive(address owner)'])[0];
    const newFunction: any = {
      capabilityId: 'fixture:newly-active:v1', type: 'contract_call', chainId: 1,
      contract: ADDRESS, signature: 'newlyActive(address)', functionName: 'newlyActive',
      abi: newAbi, policy: { ref: 'fixture', version: 1 }, status: 'active',
      provenance: { sourceRef: 'fixture newly reviewed ABI', verifiedAt: '2026-01-02', status: 'verified' },
    };
    const addedChain = [{ ...catalog[0], contracts: [{ ...catalog[0].contracts[0], functions: [...catalog[0].contracts[0].functions, newFunction] }] }];
    const addedManifest = buildReviewedManifest([{ chains: addedChain }]);
    const db = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    const updated = new DefiPolicyService(db as unknown as PrismaService, {} as SecurityEventService,
      new DefiCatalogService(addedChain, db as unknown as PrismaService, addedManifest));
    const call = { to: ADDRESS, data: encodeFunctionData({ abi: [newAbi], functionName: 'newlyActive', args: [OWNER] }) };
    await expect(previous.authorizeContractCalls([call], { ...ctx, capabilityMode: 'all', allowedCapabilityIds: [] }))
      .rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(updated.authorizeContractCalls([call], { ...ctx, capabilityMode: 'all', allowedCapabilityIds: [] }))
      .resolves.toMatchObject({ matches: [{ capabilityId: newFunction.capabilityId }] });
    await expect(updated.authorizeContractCalls([call], { ...ctx, capabilityMode: 'custom', allowedCapabilityIds: capabilities }))
      .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
  });

  it('accepts payable native value only as an exact nonnegative uint256', async () => {
    const { policy } = makePolicy();
    await expect(policy.authorizeContractCalls([{ to: ADDRESS, data: deposit(), value: '5' }], ctx)).resolves.toMatchObject({ interactions: [{ value: '5' }] });
    await expect(policy.authorizeContractCalls([{ to: ADDRESS, data: deposit(), value: (1n << 256n) - 1n }], ctx)).resolves.toBeDefined();
  });

  it('denies unrelated signing and rejects empty batches and invalid owners', async () => {
    await expect(makePolicy().policy.authorizeSigning({}, ctx as any)).rejects.toBeInstanceOf(DefiPolicyDenial);
    const { policy } = makePolicy();
    await expect(policy.authorizeContractCalls([], ctx)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([{ to: ADDRESS, data: touch() }], { ...ctx, executionOwner: 'not-an-address' })).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it('rechecks exact live signing permission, grant, pause, wallet bindings, and timestamp after locks', async () => {
    const { policy } = makePolicy();
    const agent = '0x2222222222222222222222222222222222222222';
    const payload = { domain: { name: 'ClobAuthDomain', version: '1', chainId: 137 }, types: { ClobAuth: [{ name: 'address', type: 'address' }, { name: 'timestamp', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'message', type: 'string' }] }, primaryType: 'ClobAuth', message: { address: agent, timestamp: String(Math.floor(Date.now() / 1000)), nonce: '0', message: POLYMARKET_CLOB_AUTH_ATTESTATION } };
    const context = { ...ctx, chainId: 137, executionMode: 'eoa', executionOwner: agent, allowedCapabilityIds: [POLYMARKET_CLOB_AUTH_CAPABILITY_ID], capabilityMode: 'custom', agentOpenfortAccountId: 'agent-account', walletAddress: OWNER, agentWalletAddress: agent } as any;
    const auth = await policy.authorizeSigning(payload, context);
    const key = { userId: 'user', revoked: false, frozenAt: null, expiresAt: null, canSign: true, canUseEoaExecution: true, capabilityMode: 'custom', allowedCapabilityIds: [POLYMARKET_CLOB_AUTH_CAPABILITY_ID] };
    const wallet = { id: 'wallet', userId: 'user', status: 'active', frozenAt: null, walletAddress: OWNER, agentWalletAddress: agent, agentOpenfortAccountId: 'agent-account' };
    const tx: any = { $queryRaw: jest.fn(), defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) }, apiKey: { findUnique: jest.fn().mockResolvedValue(key) }, userWallet: { findFirst: jest.fn().mockResolvedValue(wallet) }, user: { findUnique: jest.fn().mockResolvedValue({ id: 'user', frozenAt: null }) } };
    const actual = { userId: 'user', apiKeyId: ctx.apiKeyId, chainId: 137, executionMode: 'eoa', type: 'typed_data', digest: auth.typedDataDigest, walletId: 'wallet', walletAddress: OWNER, agentWalletAddress: agent, agentOpenfortAccountId: 'agent-account' };
    await expect(policy.assertSigningStillAuthorized(tx, auth, actual)).resolves.toBeUndefined();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    const allAuth = await policy.authorizeSigning(payload, { ...context, capabilityMode: 'all', allowedCapabilityIds: [] });
    tx.apiKey.findUnique.mockResolvedValue({ ...key, capabilityMode: 'custom', allowedCapabilityIds: [] });
    await expect(policy.assertSigningStillAuthorized(tx, allAuth, actual)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    const customAuth = await policy.authorizeSigning(payload, context);
    tx.apiKey.findUnique.mockResolvedValue({ ...key, capabilityMode: 'all', allowedCapabilityIds: [] });
    await expect(policy.assertSigningStillAuthorized(tx, customAuth, actual)).resolves.toBeUndefined();
    tx.apiKey.findUnique.mockResolvedValue(key);
    tx.apiKey.findUnique.mockResolvedValue({ ...key, revoked: true });
    await expect(policy.assertSigningStillAuthorized(tx, auth, actual)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    tx.apiKey.findUnique.mockResolvedValue({ ...key, expiresAt: new Date(Date.now() - 1000) });
    await expect(policy.assertSigningStillAuthorized(tx, auth, actual)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    tx.apiKey.findUnique.mockResolvedValue(key);
    tx.apiKey.findUnique.mockResolvedValue({ ...key, allowedCapabilityIds: [] });
    await expect(policy.assertSigningStillAuthorized(tx, auth, actual)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    tx.apiKey.findUnique.mockResolvedValue({ ...key, canUseEoaExecution: false });
    await expect(policy.assertSigningStillAuthorized(tx, auth, actual)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    tx.apiKey.findUnique.mockResolvedValue(key);
    tx.defiPolicyState.findUnique.mockResolvedValue({ id: 'global', pausedScopeKeys: [`capability:${POLYMARKET_CLOB_AUTH_CAPABILITY_ID}`] });
    await expect(policy.assertSigningStillAuthorized(tx, auth, actual)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
    tx.defiPolicyState.findUnique.mockResolvedValue({ id: 'global', pausedScopeKeys: [] });
    tx.userWallet.findFirst.mockResolvedValue({ ...wallet, frozenAt: new Date() });
    await expect(policy.assertSigningStillAuthorized(tx, auth, actual)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    tx.userWallet.findFirst.mockResolvedValue(wallet);
    for (const mismatch of [{ userId: 'someone-else' }, { apiKeyId: 'other-key' }, { chainId: 1 }, { executionMode: 'session_key' }, { type: 'message' }]) {
      await expect(policy.assertSigningStillAuthorized(tx, auth, { ...actual, ...mismatch })).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
    await expect(policy.assertSigningStillAuthorized(tx, auth, { ...actual, agentOpenfortAccountId: 'other' })).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.assertSigningStillAuthorized(tx, auth, { ...actual, digest: '0x' + '0'.repeat(64) })).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 301_000);
    await expect(policy.assertSigningStillAuthorized(tx, auth, actual)).rejects.toBeInstanceOf(DefiPolicyDenial);
    clock.mockRestore();
  });

  it('allows exact ClobAuth dynamically in all mode and denies empty custom mode', async () => {
    const { policy } = makePolicy();
    const agent = '0x2222222222222222222222222222222222222222';
    const input = { domain: { name: 'ClobAuthDomain', version: '1', chainId: 137 }, types: { ClobAuth: [{ name: 'address', type: 'address' }, { name: 'timestamp', type: 'string' }, { name: 'nonce', type: 'uint256' }, { name: 'message', type: 'string' }] }, primaryType: 'ClobAuth', message: { address: agent, timestamp: String(Math.floor(Date.now() / 1000)), nonce: 0, message: POLYMARKET_CLOB_AUTH_ATTESTATION } };
    const base = { ...ctx, chainId: 137, executionMode: 'eoa', executionOwner: agent, allowedCapabilityIds: [], capabilityMode: 'all', agentOpenfortAccountId: 'agent-account', walletAddress: OWNER, agentWalletAddress: agent };
    await expect(policy.authorizeSigning(input, base as any)).resolves.toMatchObject({ capabilityId: POLYMARKET_CLOB_AUTH_CAPABILITY_ID, context: { capabilityMode: 'all', allowedCapabilityIds: [] } });
    await expect(policy.authorizeSigning(input, { ...base, capabilityMode: 'custom' } as any)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
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

  it('rechecks snapshot and live all/custom capability modes at final transaction acceptance', async () => {
    const { policy } = makePolicy();
    const makeTx = (capabilityMode: string, allowedCapabilityIds: string[]) => ({
      $queryRaw: jest.fn(),
      defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) },
      apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: 'user', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, capabilityMode, allowedCapabilityIds }) },
    });
    const all = await policy.authorizeContractCalls([{ to: ADDRESS, data: touch() }], { ...ctx, capabilityMode: 'all', allowedCapabilityIds: [] });
    await expect(policy.assertStillAuthorized(makeTx('all', []) as never, all)).resolves.toBeUndefined();
    await expect(policy.assertStillAuthorized(makeTx('custom', []) as never, all)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    const custom = await policy.authorizeContractCalls([{ to: ADDRESS, data: touch() }], { ...ctx, capabilityMode: 'custom' });
    await expect(policy.assertStillAuthorized(makeTx('all', []) as never, custom)).resolves.toBeUndefined();
    await expect(policy.assertStillAuthorized(makeTx('future', capabilities) as never, custom)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
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
