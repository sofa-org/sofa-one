import { encodeFunctionData, type Hex } from 'viem';
import { DefiCatalogService } from './defi-catalog.service';
import { DefiPolicyService } from './defi-policy.service';
import type { DefiExecutionContext, DefiExecutionScope, DefiFunctionPolicy } from './defi.types';
import { buildReviewedManifest } from './registry/defi-manifest';
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST } from './registry/production-registry';
import { UNISWAP_DEPLOYMENTS, UNISWAP_POOL_MANAGERS } from './execution/uniswap-deployments';
import { executionScopeHash } from './execution/scope';

const OWNER = '0x1111111111111111111111111111111111111111';
const FROM = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';
const ZERO = '0x0000000000000000000000000000000000000000';
const INITIALIZE = 'initializePool((address,address,uint24,int24,address),uint160)';
const TRANSFERS = ['transferFrom(address,address,uint256)', 'safeTransferFrom(address,address,uint256)', 'safeTransferFrom(address,address,uint256,bytes)'];
const invalid = { audit: { code: 'DEFI_INVALID_PARAMETERS' } };
const paused = { audit: { code: 'DEFI_CAPABILITY_PAUSED' } };
const ungranted = { audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } };
const unavailable = { audit: { code: 'DEFI_POLICY_UNAVAILABLE' } };
const context = (chainId = 1): DefiExecutionContext => ({ userId: 'u', walletId: 'w', apiKeyId: '00000000-0000-4000-8000-000000000001', chainId, executionMode: 'session_key', executionOwner: OWNER, capabilityMode: 'all', allowedCapabilityIds: [] });
const capability = (chainId: number, signature: string) => PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.chainId === chainId && fn.contract === UNISWAP_DEPLOYMENTS[chainId].positionManager && fn.signature === signature)!;
const encode = (fn: DefiFunctionPolicy, args: readonly unknown[]): Hex => encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args } as never);
const argsFor = (signature: string, recipient = OWNER, data: Hex = '0x'): readonly unknown[] => signature === INITIALIZE ? [[ZERO, TOKEN, 3000, 60, ZERO], 2n ** 96n] : [FROM, recipient, 7n, ...(signature.endsWith(',bytes)') ? [data] : [])];
function setup() {
  const state = { id: 'global', pausedScopeKeys: [] as string[] };
  const key = { userId: 'u', walletId: 'w', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, capabilityMode: 'all', allowedCapabilityIds: [] as string[] };
  const db = { $queryRaw: jest.fn(), defiPolicyState: { findUnique: jest.fn(async () => state) }, apiKey: { findUnique: jest.fn(async () => key) }, userWallet: { findFirst: jest.fn(async () => ({ id: 'w' })) } };
  const catalog = new DefiCatalogService(PRODUCTION_DEFI_CATALOG, db as never, PRODUCTION_DEFI_MANIFEST);
  return { state, key, db, catalog, policy: new DefiPolicyService(db as never, {} as never, catalog) };
}

describe('direct deployment-bound V4 primitives', () => {
  it.each(Object.keys(UNISWAP_DEPLOYMENTS).map(Number))('authorizes hookless initialization and incoming approved NFTs on chain %i, then rechecks acceptance', async (chainId) => {
    for (const signature of [INITIALIZE, ...TRANSFERS]) {
      const f = setup();
      const fn = capability(chainId, signature);
      const call = { to: fn.contract, data: encode(fn, argsFor(signature)) };
      f.key.capabilityMode = 'custom';
      f.key.allowedCapabilityIds = [fn.capabilityId];
      const auth = await f.policy.authorizeContractCalls([call], { ...context(chainId), capabilityMode: 'custom', allowedCapabilityIds: [fn.capabilityId] });
      expect(auth.executionPlan.map((node) => [node.match.capabilityId, node.match.executionScopeHash, node.match.nativeValue])).toEqual([[fn.capabilityId, executionScopeHash(fn.executionScope!), '0']]);
      await f.policy.assertStillAuthorized(f.db as never, auth);
      await expect(f.policy.authorizeContractCalls([call], { ...context(chainId), capabilityMode: 'custom', allowedCapabilityIds: [] })).rejects.toMatchObject(ungranted);
      f.key.allowedCapabilityIds = [];
      await expect(f.policy.assertStillAuthorized(f.db as never, auth)).rejects.toMatchObject(ungranted);
    }
  });

  it.each(['all', 'custom'] as const)('enforces recipient/data/hook/native/canonical restrictions in %s mode', async (mode) => {
    const { policy } = setup();
    const ctx = { ...context(), capabilityMode: mode, allowedCapabilityIds: mode === 'all' ? [] : [INITIALIZE, ...TRANSFERS].map((signature) => capability(1, signature).capabilityId) };
    for (const signature of [INITIALIZE, ...TRANSFERS]) {
      const fn = capability(1, signature);
      const call = { to: fn.contract, data: encode(fn, argsFor(signature)) };
      await expect(policy.authorizeContractCalls([{ ...call, value: '1' }], ctx)).rejects.toMatchObject(invalid);
      await expect(policy.authorizeContractCalls([{ ...call, data: `${call.data}00` }], ctx)).rejects.toMatchObject(invalid);
      if (signature !== INITIALIZE) for (const recipient of [FROM, ZERO, '0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002']) {
        await expect(policy.authorizeContractCalls([{ to: fn.contract, data: encode(fn, argsFor(signature, recipient)) }], ctx)).rejects.toMatchObject(invalid);
      }
    }
    const init = capability(1, INITIALIZE);
    await expect(policy.authorizeContractCalls([{ to: init.contract, data: encode(init, [[ZERO, TOKEN, 3000, 60, FROM], 2n ** 96n]) }], ctx)).rejects.toMatchObject(invalid);
    const safe = capability(1, TRANSFERS[2]);
    await expect(policy.authorizeContractCalls([{ to: safe.contract, data: encode(safe, argsFor(safe.signature, OWNER, '0x1234')) }], ctx)).rejects.toMatchObject(invalid);
    const safeData = encode(safe, argsFor(safe.signature));
    for (const index of [3, 4]) {
      const oversized = `${safeData.slice(0, 10 + index * 64)}${'ff'.repeat(32)}${safeData.slice(10 + (index + 1) * 64)}` as Hex;
      await expect(policy.authorizeContractCalls([{ to: safe.contract, data: oversized }], ctx)).rejects.toMatchObject(invalid);
    }
  });

  it('checks PM, PoolManager, supplied ERC20 currencies, capability, chain and global pauses initially and finally', async () => {
    const f = setup();
    const fn = capability(1, INITIALIZE);
    const call = { to: fn.contract, data: encode(fn, [[FROM, TOKEN, 3000, 60, ZERO], 2n ** 96n]) };
    const auth = await f.policy.authorizeContractCalls([call], context());
    await f.policy.assertStillAuthorized(f.db as never, auth);
    for (const key of ['global', 'chain:1', `capability:${fn.capabilityId}`, ...[fn.contract, UNISWAP_POOL_MANAGERS[1], FROM, TOKEN].map((address) => `contract:1:${address}`)]) {
      f.state.pausedScopeKeys = [key];
      await expect(f.policy.authorizeContractCalls([call], context())).rejects.toMatchObject(paused);
      await expect(f.policy.assertStillAuthorized(f.db as never, auth)).rejects.toMatchObject(paused);
    }
    f.state.pausedScopeKeys = [];
    const transfer = capability(1, TRANSFERS[0]);
    const transferCall = { to: transfer.contract, data: encode(transfer, argsFor(transfer.signature)) };
    const transferAuth = await f.policy.authorizeContractCalls([transferCall], context());
    f.state.pausedScopeKeys = [`contract:1:${UNISWAP_POOL_MANAGERS[1]}`];
    await expect(f.policy.assertStillAuthorized(f.db as never, transferAuth)).rejects.toMatchObject(paused);
    await expect(f.policy.authorizeContractCalls([transferCall], context())).rejects.toMatchObject(paused);
  });

  it('reserves exact identity, ABI and mandatory primitive scope in manifest and runtime, even with all grants', async () => {
    const fn = capability(1, INITIALIZE);
    const mutations = [
      { ...fn, executionScope: undefined },
      { ...fn, executionScope: { kind: 'uniswap-v4-position-manager-v1' } as const },
      { ...fn, contract: FROM },
      { ...fn, chainId: 56 },
      { ...fn, abi: { ...fn.abi, stateMutability: 'nonpayable' as const } },
      { ...fn, executionScope: { ...fn.executionScope, nativeValuePolicy: 'inherit' } as DefiExecutionScope },
    ];
    for (const changed of mutations) expect(() => buildReviewedManifest([{ chains: [{ chainId: changed.chainId, status: 'active', contracts: [{ address: changed.contract, status: 'active', functions: [changed] }] }] }])).toThrow();
    for (const changed of mutations.filter((entry) => entry.contract === fn.contract && entry.chainId === 1 && (!entry.executionScope || Object.keys(entry.executionScope).length === 1))) {
      const f = setup();
      const chain = f.catalog.activeChain(1)!;
      jest.spyOn(f.catalog, 'activeChain').mockReturnValue({ ...chain, contracts: chain.contracts.map((contract) => contract.address === fn.contract ? { ...contract, functions: contract.functions.map((entry) => entry.capabilityId === fn.capabilityId ? changed : entry) } : contract) });
      await expect(f.policy.authorizeContractCalls([{ to: fn.contract, data: encode(fn, argsFor(fn.signature)) }], context())).rejects.toMatchObject(unavailable);
    }
    expect(() => executionScopeHash({ kind: 'uniswap-v4-position-manager-primitive-v1', allowedChildren: [] } as unknown as DefiExecutionScope)).toThrow();
  });

  it('does not extend the old PM multicall child language to direct primitives', async () => {
    const f = setup();
    const wrapper = capability(1, 'multicall(bytes[])');
    for (const signature of [INITIALIZE, ...TRANSFERS]) {
      const fn = capability(1, signature);
      const call = { to: wrapper.contract, data: encode(wrapper, [[encode(fn, argsFor(signature))]]) };
      await expect(f.policy.authorizeContractCalls([call], context())).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    }
  });
});
