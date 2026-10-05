import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, toFunctionSelector } from 'viem';
import type { Hex } from 'viem';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import type { DefiExecutionContext } from '../defi.types';
import { ENSO_STATIC_WEIROLL_CHILD_IDENTITIES, ENSO_STATIC_WEIROLL_ROOT_IDENTITY } from '../execution/enso-identity';
import { PRODUCTION_DEFI_MANIFEST } from './production-registry';
import { V9_SDAI_BINDINGS } from '../catalog-tooling/v9-identities';

const COMET_DIRECT_IDS = [
  'compound-iii:v3-comet:1:0xc3d688b66703497daa19211eedff47f25384cdc3:supply-to',
  'compound-iii:v3-comet:1:0xc3d688b66703497daa19211eedff47f25384cdc3:withdraw-to',
];

const rootAbi = parseAbi(['function routeSingle((uint8 tokenType, bytes data) tokenIn, bytes data) payable returns (bytes response)']);
const shortcutAbi = parseAbi(['function executeShortcut(bytes32 accountId, bytes32 requestId, bytes32[] commands, bytes[] state)']);
const encodeFn = encodeFunctionData as (parameters: any) => Hex;
const dynamicAbi = (signature: string) => (parseAbi as unknown as (signatures: string[]) => any)([`function ${signature}`]);
const maxUint = (1n << 256n) - 1n;
const walletOwner = '0x0000000000000000000000000000000000000002';
const keyId = '00000000-0000-4000-8000-000000000001';
const rootId = ENSO_STATIC_WEIROLL_ROOT_IDENTITY.capabilityId;
const childIds = ENSO_STATIC_WEIROLL_CHILD_IDENTITIES.map((binding) => binding.capabilityId);
const allGrants = [rootId, ...childIds];
const baseContext: DefiExecutionContext = {
  userId: 'enso-production-fixture', apiKeyId: keyId, walletId: 'wallet', chainId: 1,
  executionMode: 'session_key', executionOwner: walletOwner, allowedCapabilityIds: allGrants,
};

function mockPrisma(pausedScopeKeys: string[] = []) {
  return { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) } };
}
function makePolicy(pausedScopeKeys: string[] = []) {
  const prisma = mockPrisma(pausedScopeKeys);
  const catalog = new DefiCatalogService(PRODUCTION_DEFI_MANIFEST.chains, prisma as never, PRODUCTION_DEFI_MANIFEST);
  return { policy: new DefiPolicyService(prisma as never, {} as never, catalog), prisma };
}
function childCall(index: number, extreme = false): Hex {
  const child = ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[index];
  const abi = dynamicAbi(child.signature);
  const address = (digit: string) => `0x${digit.repeat(40)}` as Hex;
  if (index === 0) return encodeFn({ abi, functionName: 'exactInputSingle', args: [[
    address('1'), address('2'), extreme ? (1 << 24) - 1 : 3000, address('3'), extreme ? maxUint : 5n,
    extreme ? maxUint : 4n, extreme ? (1n << 160n) - 1n : 0n,
  ]] as never });
  if (index === 1) return encodeFn({ abi, functionName: 'supply', args: [address('4'), extreme ? maxUint : 7n, address('5'), extreme ? (1 << 16) - 1 : 0] as never });
  return encodeFn({ abi, functionName: 'approve', args: [address('6'), extreme ? maxUint : 9n] as never });
}
function command(index: number, flag: 0x21 | 0x23, stateIndex: number): Hex {
  const child = ENSO_STATIC_WEIROLL_CHILD_IDENTITIES[index];
  const selector = toFunctionSelector(child.signature);
  const indices = flag === 0x21 ? [stateIndex, 255, 255, 255, 255, 255] : [stateIndex, stateIndex + 1, 255, 255, 255, 255];
  return `0x${selector.slice(2)}${flag.toString(16)}${indices.map((item) => item.toString(16).padStart(2, '0')).join('')}ff${child.contract.slice(2)}` as Hex;
}
function interaction(tokenType: 0 | 1, calls: readonly Hex[], nativeAmount = 0n, nativeValue = 0n, values: readonly bigint[] = []): { to: string; data: Hex; value: string } {
  const tokenData = tokenType === 0
    ? encodeAbiParameters(parseAbiParameters('uint256'), [nativeAmount])
    : encodeAbiParameters(parseAbiParameters('address,uint256'), [`0x${'7'.repeat(40)}`, nativeAmount]);
  const commands: Hex[] = [];
  const state: Hex[] = [];
  for (let index = 0; index < calls.length; index += 1) {
    if (values[index] !== undefined) {
      commands.push(command(index % ENSO_STATIC_WEIROLL_CHILD_IDENTITIES.length, 0x23, state.length));
      state.push(encodeAbiParameters(parseAbiParameters('uint256'), [values[index]]), calls[index]);
    } else {
      commands.push(command(index % ENSO_STATIC_WEIROLL_CHILD_IDENTITIES.length, 0x21, state.length));
      state.push(calls[index]);
    }
  }
  const inner = encodeFunctionData({ abi: shortcutAbi, functionName: 'executeShortcut', args: [`0x${'a'.repeat(64)}`, `0x${'b'.repeat(64)}`, commands, state] });
  return {
    to: ENSO_STATIC_WEIROLL_ROOT_IDENTITY.contract,
    data: encodeFunctionData({ abi: rootAbi, functionName: 'routeSingle', args: [{ tokenType, data: tokenData }, inner] }),
    value: nativeValue.toString(),
  };
}
function finalTx(grants: string[] = allGrants, pausedScopeKeys: string[] = []) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) },
    apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: baseContext.userId, revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: grants }) },
  };
}

describe('integrated v8 Enso production policy fixture', () => {
  it('loads the admitted root and all three children from generated production manifest, then authorizes canonical native and ERC-20 routes', async () => {
    const historicalV8Projection = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => !V9_SDAI_BINDINGS.some((binding) => binding.capabilityId === fn.capabilityId) && !COMET_DIRECT_IDS.includes(fn.capabilityId));
    expect(historicalV8Projection).toHaveLength(669);
    const rootFn = PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.capabilityId === rootId)!;
    expect(rootFn.status).toBe('active');
    expect(rootFn.executionScope?.kind).toBe('enso-static-weiroll-v1');
    for (const child of ENSO_STATIC_WEIROLL_CHILD_IDENTITIES) {
      const fn = PRODUCTION_DEFI_MANIFEST.capabilities.find((candidate) => candidate.capabilityId === child.capabilityId)!;
      expect(fn).toBeDefined();
      expect(fn.status).toBe('active');
      expect(fn.signature).toBe(child.signature);
      expect(fn.contract.toLowerCase()).toBe(child.contract.toLowerCase());
    }
    const { policy } = makePolicy();
    const calls = [childCall(0), childCall(1), childCall(2)];
    const native = interaction(0, calls, 5n, 5n);
    const erc20 = interaction(1, calls, maxUint, 0n);
    const nativeAuth = await policy.authorizeContractCalls([native], baseContext);
    expect(nativeAuth.executionPlan.map((node) => node.match.capabilityId)).toEqual(allGrants);
    await expect(policy.assertStillAuthorized(finalTx() as never, nativeAuth)).resolves.toBeUndefined();
    const erc20Auth = await policy.authorizeContractCalls([erc20], baseContext);
    expect(erc20Auth.executionPlan.map((node) => node.match.capabilityId)).toEqual(allGrants);
    await expect(policy.assertStillAuthorized(finalTx() as never, erc20Auth)).resolves.toBeUndefined();
  });

  it('enforces independent initial/final grants, pause, revocation, and existing SHARE-before-UPDATE lock order', async () => {
    const interactionValue = interaction(1, [childCall(0), childCall(1), childCall(2)], 1n);
    const { policy } = makePolicy();
    for (const id of allGrants) {
      await expect(policy.authorizeContractCalls([interactionValue], { ...baseContext, allowedCapabilityIds: allGrants.filter((value) => value !== id) })).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      const authorization = await policy.authorizeContractCalls([interactionValue], baseContext);
      await expect(policy.assertStillAuthorized(finalTx(allGrants.filter((value) => value !== id)) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(makePolicy([`capability:${id}`]).policy.authorizeContractCalls([interactionValue], baseContext)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
      await expect(policy.assertStillAuthorized(finalTx(allGrants, [`capability:${id}`]) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
    }
    await expect(policy.authorizeContractCalls([interactionValue], { ...baseContext, allowedCapabilityIds: [] })).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    const authorization = await policy.authorizeContractCalls([interactionValue], baseContext);
    const tx = finalTx();
    await expect(policy.assertStillAuthorized(tx as never, authorization)).resolves.toBeUndefined();
    const lockQueries = tx.$queryRaw.mock.calls.map(([strings]) => strings.join(' ').replace(/\s+/g, ' ').trim());
    expect(lockQueries).toHaveLength(2);
    expect(lockQueries[0]).toContain('FOR SHARE');
    expect(lockQueries[1]).toContain('FOR UPDATE');
    const revoked = finalTx();
    revoked.apiKey.findUnique.mockResolvedValue({ userId: baseContext.userId, revoked: true, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: allGrants });
    await expect(policy.assertStillAuthorized(revoked as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
  });

  it('keeps ABI financial freedom, per-node values, and the aggregate root-inclusive ten-node bound', async () => {
    const { policy } = makePolicy();
    const maxCalls = [childCall(0, true), childCall(1, true), childCall(2, true)];
    const extremeAuth = await policy.authorizeContractCalls([interaction(1, maxCalls, 1n)], baseContext);
    expect(extremeAuth.executionPlan).toHaveLength(4);
    const payableValue = (1n << 256n) - 1n;
    const overRoot = interaction(1, [childCall(0)], 0n, 0n, [payableValue]);
    const overRootAuth = await policy.authorizeContractCalls([overRoot], baseContext);
    expect(overRootAuth.executionPlan[1].match.nativeValue).toBe(payableValue.toString());
    const calls9 = Array.from({ length: 9 }, (_, index) => childCall(index % ENSO_STATIC_WEIROLL_CHILD_IDENTITIES.length));
    const rootPlusNine = await policy.authorizeContractCalls([interaction(1, calls9)], baseContext);
    expect(rootPlusNine.executionPlan).toHaveLength(10);
    await expect(policy.authorizeContractCalls([interaction(1, [...calls9, childCall(0)])], baseContext)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const calls4 = calls9.slice(0, 4);
    const exactlyTenAcrossRoots = await policy.authorizeContractCalls([interaction(1, calls4), interaction(1, calls4)], baseContext);
    expect(exactlyTenAcrossRoots.executionPlan).toHaveLength(10);
    await expect(policy.authorizeContractCalls([interaction(1, calls9.slice(0, 5)), interaction(1, calls4)], baseContext)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([interaction(1, [childCall(1)], 0n, 1n)], baseContext)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(policy.authorizeContractCalls([interaction(1, [childCall(1)], 0n, 0n, [1n])], baseContext)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });
});
