import { encodeAbiParameters, encodeFunctionData, parseAbiParameters, type Hex } from 'viem';
import { DefiCatalogService } from './defi-catalog.service';
import { DefiPolicyService } from './defi-policy.service';
import type { DefiExecutionContext } from './defi.types';
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST } from './registry/production-registry';
import { buildReviewedManifest } from './registry/defi-manifest';
import { UNISWAP_DEPLOYMENTS, UNISWAP_ROUTER_ABI, UNISWAP_V4_POSITION_ABI } from './execution/uniswap-deployments';

const OWNER = '0x1111111111111111111111111111111111111111';
const A = '0x2222222222222222222222222222222222222222';
const B = '0x3333333333333333333333333333333333333333';
const ZERO = '0x0000000000000000000000000000000000000000';
const enc = (types: string, values: readonly unknown[]): Hex => encodeAbiParameters(parseAbiParameters(types), values);
const router = (commands: Hex, inputs: readonly Hex[]): Hex => encodeFunctionData({ abi: [UNISWAP_ROUTER_ABI], functionName: 'execute', args: [commands, inputs, 2_000_000_000n] });
const swap = router('0x08', [enc('address,uint256,uint256,address[],bool,uint256[]', [OWNER, 10n, 1n, [A, B], true, []])]);
const mint = (recipient = OWNER): Hex => encodeFunctionData({ abi: [UNISWAP_V4_POSITION_ABI], functionName: 'modifyLiquidities', args: [enc('bytes,bytes[]', ['0x020d14', [
  enc('(address,address,uint24,int24,address),int24,int24,uint256,uint128,uint128,address,bytes', [[A, B, 3000, 60, ZERO], -120, 120, 1n, 10n, 10n, recipient, '0x']),
  enc('address,address', [A, B]),
  enc('address,address', [ZERO, OWNER]),
]]), 2_000_000_000n] });
const context = (chainId = 1): DefiExecutionContext => ({ userId: 'user', walletId: 'wallet', apiKeyId: '00000000-0000-4000-8000-000000000001', chainId, executionMode: 'session_key', executionOwner: OWNER, capabilityMode: 'all', allowedCapabilityIds: [] });
const capability = (chainId: number, contract: string) => PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.chainId === chainId && fn.contract.toLowerCase() === contract)!;
function setup() {
  const state = { id: 'global', pausedScopeKeys: [] as string[] };
  const key = { userId: 'user', walletId: 'wallet', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, capabilityMode: 'all', allowedCapabilityIds: [] as string[] };
  const db = { $queryRaw: jest.fn(), defiPolicyState: { findUnique: jest.fn(async () => state) }, apiKey: { findUnique: jest.fn(async () => key) }, userWallet: { findFirst: jest.fn(async () => ({ id: 'wallet' })) } };
  const catalog = new DefiCatalogService(PRODUCTION_DEFI_CATALOG, db as never, PRODUCTION_DEFI_MANIFEST);
  return { state, key, db, policy: new DefiPolicyService(db as never, {} as never, catalog) };
}

describe('Uniswap production catalog authorization', () => {
  it.each(Object.keys(UNISWAP_DEPLOYMENTS).map(Number))('authorizes chain %s swaps and explicit LP mint under its own grant', async (chainId) => {
    const { policy } = setup();
    const deployment = UNISWAP_DEPLOYMENTS[chainId];
    for (const [to, data] of [[deployment.router, swap], [deployment.positionManager, mint()]] as const) {
      const id = capability(chainId, to).capabilityId;
      const auth = await policy.authorizeContractCalls([{ to, data }], { ...context(chainId), capabilityMode: 'custom', allowedCapabilityIds: [id] });
      expect(auth.executionPlan.map((node) => node.match.capabilityId)).toEqual([id]);
      await expect(policy.authorizeContractCalls([{ to, data }], { ...context(chainId), capabilityMode: 'custom', allowedCapabilityIds: [] })).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    }
  });

  it('does not reuse a same-address BSC grant on Polygon', async () => {
    const { policy } = setup();
    const id = capability(56, UNISWAP_DEPLOYMENTS[56].router).capabilityId;
    await expect(policy.authorizeContractCalls([{ to: UNISWAP_DEPLOYMENTS[137].router, data: swap }], { ...context(137), capabilityMode: 'custom', allowedCapabilityIds: [id] })).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
  });

  it('requires independent PM authority for the mint child and rejects sender-sentinel owner confusion', async () => {
    const { policy } = setup();
    const deployment = UNISWAP_DEPLOYMENTS[1];
    const root = capability(1, deployment.router).capabilityId;
    const child = capability(1, deployment.positionManager).capabilityId;
    const interactions = [{ to: deployment.router, data: router('0x14', [mint()]) }];
    const custom = { ...context(), capabilityMode: 'custom' as const, allowedCapabilityIds: [root] };
    await expect(policy.authorizeContractCalls(interactions, custom)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    const auth = await policy.authorizeContractCalls(interactions, { ...custom, allowedCapabilityIds: [root, child] });
    expect(auth.executionPlan.map((node) => node.match.capabilityId)).toEqual([root, child]);
    await expect(policy.authorizeContractCalls([{ to: deployment.router, data: router('0x14', [mint('0x0000000000000000000000000000000000000001')]) }], context())).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it.each(['token', 'child'])('rechecks a newly paused %s at atomic acceptance', async (target) => {
    const { policy, state, db } = setup();
    const deployment = UNISWAP_DEPLOYMENTS[1];
    const call = target === 'token' ? { to: deployment.router, data: swap } : { to: deployment.router, data: router('0x14', [mint()]) };
    const auth = await policy.authorizeContractCalls([call], context());
    state.pausedScopeKeys.push(`contract:1:${target === 'token' ? A : deployment.positionManager}`);
    await expect(policy.assertStillAuthorized(db as never, auth)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
    await expect(policy.authorizeContractCalls([call], context())).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
  });

  it('rejects live grant removal after successful preflight', async () => {
    const { policy, key, db } = setup();
    const auth = await policy.authorizeContractCalls([{ to: UNISWAP_DEPLOYMENTS[1].router, data: swap }], context());
    key.capabilityMode = 'custom';
    await expect(policy.assertStillAuthorized(db as never, auth)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
  });

  it('rejects a catalog downgrade to outer-only ABI validation', () => {
    const fn = capability(1, UNISWAP_DEPLOYMENTS[1].router);
    const withoutScope = { ...fn, executionScope: undefined };
    const chain = [{ chainId: 1, status: 'active' as const, contracts: [{ address: fn.contract, status: 'active' as const, functions: [withoutScope] }] }];
    expect(() => buildReviewedManifest([{ chains: chain }])).toThrow('mandatory scope');
  });

  it('bounds operations across separate top-level roots, not only within one router call', async () => {
    const { policy } = setup();
    const input = enc('address,address,uint256', [A, OWNER, 0n]);
    const call = { to: UNISWAP_DEPLOYMENTS[1].router, data: router(`0x${'04'.repeat(33)}`, Array.from({ length: 33 }, () => input)) };
    await expect(policy.authorizeContractCalls([call, call], context())).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });
});
