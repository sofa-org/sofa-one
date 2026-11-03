import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import type { DefiExecutionContext, DefiExecutionScope, DefiFunctionPolicy } from '../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../registry/defi-manifest';
import type { DefiRegistryFragment } from '../registry/defi-manifest.types';
import { executionScopeHash } from './scope';

const target = '0x1111111111111111111111111111111111111111';
const owner = '0x2222222222222222222222222222222222222222';
const provenance = { sourceRef: 'router security fixture', verifiedAt: '2026-01-01', status: 'verified' as const };
const childDefinitions = [
  ['exactInput((bytes,address,uint256,uint256))', 'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)'],
  ['refundETH()', 'function refundETH() payable'],
  ['pull(address,uint256)', 'function pull(address token,uint256 value)'],
] as const;
const rootDefinitions = [
  ['multicall(bytes[])', 'function multicall(bytes[] data) payable returns (bytes[] results)', 0],
  ['multicall(uint256,bytes[])', 'function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)', 1],
  ['multicall(bytes32,bytes[])', 'function multicall(bytes32 previousBlockhash,bytes[] data) payable returns (bytes[] results)', 1],
] as const;
const manifestFor = (functions: readonly DefiFunctionPolicy[]) => buildReviewedManifest(functions.map<DefiRegistryFragment>((fn) => ({ chains: [{ chainId: fn.chainId, status: 'active', contracts: [{ address: fn.contract, status: 'active', functions: [fn] }] }] })));

function fixture() {
  const children: DefiFunctionPolicy[] = childDefinitions.map(([signature, declaration], index) => {
    const abi = parseAbi([declaration])[0];
    return { capabilityId: `router:child:${index}`, type: 'contract_call', chainId: 1, contract: target, functionName: abi.name, signature, abi, status: 'active', provenance };
  });
  const allowedChildren = children.map((child) => ({ capabilityId: child.capabilityId, signature: child.signature, abiHash: functionAbiHash(child) }));
  const wrappers: DefiFunctionPolicy[] = rootDefinitions.map(([signature, declaration, bytesArrayArgIndex], index) => ({
    capabilityId: `router:root:${index}`, type: 'contract_call', chainId: 1, contract: target, functionName: 'multicall', signature,
    abi: parseAbi([declaration])[0], status: 'active', provenance,
    executionScope: { kind: 'same-target-router-multicall-v1', bytesArrayArgIndex, allowedChildren },
  }));
  const functions = [...wrappers, ...children];
  const manifest = manifestFor(functions);
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const catalog = new DefiCatalogService(manifest.chains, prisma as never, manifest);
  const service = new DefiPolicyService(prisma as never, {} as never, catalog);
  const context: DefiExecutionContext = { userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId: 1, executionMode: 'session_key', executionOwner: owner, allowedCapabilityIds: functions.map((fn) => fn.capabilityId) };
  const swap = encodeFunctionData({ abi: [children[0].abi], functionName: 'exactInput', args: [{ path: '0x123456', recipient: owner, amountIn: 2n ** 255n, amountOutMinimum: 0n }] } as never);
  const refund = encodeFunctionData({ abi: [children[1].abi], functionName: 'refundETH' });
  const pull = encodeFunctionData({ abi: [children[2].abi], functionName: 'pull', args: [owner, 1n] } as never);
  const root = (index: number, calls: readonly Hex[], value = '0') => ({
    to: target,
    data: encodeFunctionData({ abi: [wrappers[index].abi], functionName: 'multicall', args: index === 0 ? [calls] : [index === 1 ? 2n ** 255n : `0x${'ab'.repeat(32)}`, calls] } as never),
    value,
  });
  return { children, wrappers, functions, manifest, prisma, catalog, service, context, swap, refund, pull, root };
}

function transaction(grants: readonly string[], capabilityMode: 'all' | 'custom' = 'custom') {
  return {
    $queryRaw: jest.fn(),
    defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) },
    userWallet: { findFirst: jest.fn().mockResolvedValue({ id: 'w' }) },
    apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: 'u', walletId: 'w', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, capabilityMode, allowedCapabilityIds: grants }) },
  };
}

const replaceWord = (data: Hex, word: number, value: bigint): Hex => `${data.slice(0, 10 + word * 64)}${value.toString(16).padStart(64, '0')}${data.slice(10 + (word + 1) * 64)}` as Hex;
const invalidParameters = { audit: { code: 'DEFI_INVALID_PARAMETERS' } };

describe('closed financial router multicall', () => {
  it.each([0, 1, 2])('plans and reauthorizes overload %i with canonical dynamic children and inherited native value', async (index) => {
    const { service, context, wrappers, children, root, swap, refund } = fixture();
    const auth = await service.authorizeContractCalls([root(index, [swap, refund], '7')], context);
    expect(auth.executionPlan.map((node) => [node.path, node.match.capabilityId, node.match.nativeValue])).toEqual([
      [[0], wrappers[index].capabilityId, '7'], [[0, 0], children[0].capabilityId, '7'], [[0, 1], children[1].capabilityId, '7'],
    ]);
    await expect(service.assertStillAuthorized(transaction(context.allowedCapabilityIds) as never, auth)).resolves.toBeUndefined();
  });

  it.each([0, 1, 2])('rejects malformed or noncanonical outer/inner ABI for overload %i', async (index) => {
    const { service, context, root, swap, refund } = fixture();
    const call = root(index, [swap, refund]);
    const arrayIndex = index === 0 ? 0 : 1;
    const arrayWord = index === 0 ? 1 : 2;
    for (const data of [
      replaceWord(call.data, arrayIndex, 0n),
      replaceWord(call.data, arrayIndex, 65n),
      replaceWord(call.data, arrayIndex, 2n ** 255n),
      replaceWord(call.data, arrayWord, 2n ** 255n),
      replaceWord(call.data, arrayWord + 1, 0n),
      replaceWord(call.data, arrayWord + 2, 64n),
      `${call.data}00` as Hex,
    ]) await expect(service.authorizeContractCalls([{ ...call, data }], context)).rejects.toMatchObject(invalidParameters);
    await expect(service.authorizeContractCalls([root(index, [`${swap}${'00'.repeat(32)}` as Hex])], context)).rejects.toMatchObject(invalidParameters);
    // Move an otherwise valid bytes[] behind an unused word: preflight is bounded,
    // but canonical ABI comparison must reject the gap before granting any child.
    const withGap = `${call.data.slice(0, 10 + arrayWord * 64)}${'00'.repeat(32)}${call.data.slice(10 + arrayWord * 64)}` as Hex;
    await expect(service.authorizeContractCalls([{ ...call, data: replaceWord(withGap, arrayIndex, BigInt((arrayWord + 1) * 32)) }], context)).rejects.toMatchObject(invalidParameters);
    await expect(service.authorizeContractCalls([root(index, [])], context)).rejects.toMatchObject(invalidParameters);
  });

  it.each([0, 1, 2])('rejects malformed inner tuple/path offsets, lengths and padding beneath overload %i', async (index) => {
    const { service, context, root, swap } = fixture();
    for (const data of [
      replaceWord(swap, 0, 64n),
      replaceWord(swap, 1, 0n),
      replaceWord(swap, 5, 2n ** 255n),
      `${swap.slice(0, -2)}01` as Hex,
    ]) await expect(service.authorizeContractCalls([root(index, [data])], context)).rejects.toMatchObject(invalidParameters);
  });

  it.each([0, 1, 2])('rejects unknown and every nested wrapper overload beneath overload %i', async (index) => {
    const { service, context, root, swap } = fixture();
    for (const data of ['0x12345678' as Hex, ...[0, 1, 2].map((nested) => root(nested, [swap]).data)]) {
      await expect(service.authorizeContractCalls([root(index, [data])], context)).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    }
  });

  it('rejects any child execution scope even when its selector and ABI binding are allowed', async () => {
    const { service, catalog, context, root, swap } = fixture();
    const chain = catalog.activeChain(1)!;
    jest.spyOn(catalog, 'activeChain').mockReturnValue({ ...chain, contracts: chain.contracts.map((contract) => ({ ...contract, functions: contract.functions.map((fn) => fn.functionName === 'exactInput' ? { ...fn, executionScope: { kind: 'empty-callback-data-v1', bytesArgIndex: 0 } as const } : fn) })) });
    await expect(service.authorizeContractCalls([root(1, [swap])], context)).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
  });

  it('inherits native value into nonpayable children and retains the 64KiB aggregate bound', async () => {
    const { service, context, children, root, pull, swap } = fixture();
    await expect(service.authorizeContractCalls([root(2, [pull])], context)).resolves.toMatchObject({
      executionPlan: [{ path: [0] }, { path: [0, 0], match: { capabilityId: children[2].capabilityId, nativeValue: '0' } }],
    });
    await expect(service.authorizeContractCalls([root(2, [pull], '1')], context)).rejects.toMatchObject(invalidParameters);
    const hugeChild = `${swap}${'00'.repeat(65_536)}` as Hex;
    await expect(service.authorizeContractCalls([root(1, [hugeChild])], context)).rejects.toMatchObject(invalidParameters);
  });

  it.each([0, 1, 2])('counts root plus actual children at the exact ten-node boundary for overload %i', async (index) => {
    const { service, context, root, refund } = fixture();
    const ten = await service.authorizeContractCalls([root(index, Array.from({ length: 9 }, () => refund))], context);
    expect(ten.executionPlan).toHaveLength(10);
    await expect(service.authorizeContractCalls([root(index, Array.from({ length: 10 }, () => refund))], context)).rejects.toMatchObject(invalidParameters);
    await expect(service.authorizeContractCalls([root(index, Array.from({ length: 9 }, () => refund)), { to: target, data: refund }], context)).rejects.toMatchObject(invalidParameters);
  });

  it.each([0, 1, 2])('requires independent root/actual-child grants and rechecks their removal for overload %i', async (index) => {
    const { service, context, wrappers, children, root, swap } = fixture();
    const call = root(index, [swap]);
    for (const missing of [wrappers[index].capabilityId, children[0].capabilityId]) {
      const grants = context.allowedCapabilityIds.filter((id) => id !== missing);
      await expect(service.authorizeContractCalls([call], { ...context, allowedCapabilityIds: grants })).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      const auth = await service.authorizeContractCalls([call], context);
      await expect(service.assertStillAuthorized(transaction(grants) as never, auth)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    }
    // Configured-but-unused children do not acquire implicit per-call grant requirements.
    await expect(service.authorizeContractCalls([call], { ...context, allowedCapabilityIds: [wrappers[index].capabilityId, children[0].capabilityId] })).resolves.toMatchObject({
      executionPlan: [{ path: [0], match: { capabilityId: wrappers[index].capabilityId } }, { path: [0, 0], match: { capabilityId: children[0].capabilityId } }],
    });
    const allContext = { ...context, capabilityMode: 'all' as const, allowedCapabilityIds: [] };
    const allAuth = await service.authorizeContractCalls([call], allContext);
    await expect(service.assertStillAuthorized(transaction([], 'all') as never, allAuth)).resolves.toBeUndefined();
    await expect(service.assertStillAuthorized(transaction([wrappers[index].capabilityId]) as never, allAuth)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
  });

  it.each(['custom', 'all'] as const)('enforces every pause scope at initial/final authorization in %s mode', async (capabilityMode) => {
    const { service, prisma, context, wrappers, children, root, swap } = fixture();
    const ctx = { ...context, capabilityMode, allowedCapabilityIds: capabilityMode === 'all' ? [] : context.allowedCapabilityIds };
    for (const index of [0, 1, 2]) {
      const call = root(index, [swap]);
      for (const paused of ['global', 'chain:1', `contract:1:${target}`, `capability:${wrappers[index].capabilityId}`, `capability:${children[0].capabilityId}`]) {
        prisma.defiPolicyState.findUnique.mockResolvedValue({ id: 'global', pausedScopeKeys: [] });
        const auth = await service.authorizeContractCalls([call], ctx);
        prisma.defiPolicyState.findUnique.mockResolvedValue({ id: 'global', pausedScopeKeys: [paused] });
        await expect(service.authorizeContractCalls([call], ctx)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
        const tx = transaction(ctx.allowedCapabilityIds, capabilityMode);
        tx.defiPolicyState.findUnique.mockResolvedValue({ id: 'global', pausedScopeKeys: [paused] });
        await expect(service.assertStillAuthorized(tx as never, auth)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
      }
    }
  });

  it('rejects final plan/path/data/binding tampering and revoked authority', async () => {
    const { service, context, root, swap } = fixture();
    const auth = await service.authorizeContractCalls([root(2, [swap])], context);
    for (const patch of [{ path: [0, 1] }, { data: '0x12345678' }, { match: { ...auth.executionPlan[1].match, abiHash: `0x${'00'.repeat(32)}` } }]) {
      await expect(service.assertStillAuthorized(transaction(context.allowedCapabilityIds) as never, { ...auth, executionPlan: [auth.executionPlan[0], { ...auth.executionPlan[1], ...patch }] } as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    }
    const revoked = transaction(context.allowedCapabilityIds);
    revoked.apiKey.findUnique.mockResolvedValue({ userId: 'u', walletId: 'w', revoked: true, frozenAt: null, expiresAt: null, canSendTransaction: true, capabilityMode: 'custom', allowedCapabilityIds: context.allowedCapabilityIds });
    await expect(service.assertStillAuthorized(revoked as never, auth)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
  });

  it('normalizes child bindings but commits argument index, child identity and ABI hash', () => {
    const { wrappers } = fixture();
    const scope = wrappers[0].executionScope!;
    if (scope.kind !== 'same-target-router-multicall-v1') throw new Error('Invalid router fixture');
    expect(executionScopeHash(scope)).toBe(executionScopeHash({ ...scope, allowedChildren: [...scope.allowedChildren].reverse() }));
    expect(executionScopeHash(scope)).not.toBe(executionScopeHash({ ...scope, bytesArrayArgIndex: 1 }));
    for (const patch of [{ capabilityId: 'router:other' }, { abiHash: `0x${'ff'.repeat(32)}` as Hex }]) {
      expect(executionScopeHash(scope)).not.toBe(executionScopeHash({ ...scope, allowedChildren: scope.allowedChildren.map((child, index) => index ? child : { ...child, ...patch }) }));
    }
    for (const altered of [
      { ...scope, extra: true }, { ...scope, bytesArrayArgIndex: 2 },
      { ...scope, allowedChildren: [] }, { ...scope, allowedChildren: scope.allowedChildren.slice(1) },
      { ...scope, allowedChildren: [...scope.allowedChildren, scope.allowedChildren[0]] },
      { ...scope, allowedChildren: scope.allowedChildren.map((child, index) => index === 1 ? { ...child, capabilityId: scope.allowedChildren[0].capabilityId } : child) },
      { ...scope, allowedChildren: scope.allowedChildren.map((child, index) => index === 1 ? { ...child, signature: scope.allowedChildren[0].signature } : child) },
      { ...scope, allowedChildren: [...scope.allowedChildren, { ...scope.allowedChildren[0], capabilityId: 'router:permit', signature: 'permit(address)' }] },
    ]) expect(() => executionScopeHash(altered as DefiExecutionScope)).toThrow();
  });

  it.each([0, 1, 2])('rejects inconsistent fixed root ABI/index/output/payability for overload %i', (index) => {
    const { wrappers, children } = fixture();
    const wrapper = wrappers[index];
    const scope = wrapper.executionScope!;
    if (scope.kind !== 'same-target-router-multicall-v1') throw new Error('Invalid router fixture');
    for (const patch of [
      { executionScope: { ...scope, bytesArrayArgIndex: index === 0 ? 1 : 0 } },
      { abi: { ...wrapper.abi, stateMutability: 'nonpayable' } },
      { abi: { ...wrapper.abi, outputs: [] } },
      { abi: { ...wrapper.abi, outputs: [{ type: 'bytes', name: 'results' }] } },
      { abi: { ...wrapper.abi, outputs: [{ type: 'bytes[]' }, { type: 'bytes[]' }] } },
      { abi: { ...wrapper.abi, inputs: [...wrapper.abi.inputs, { type: 'address' }] } },
    ]) expect(() => manifestFor([{ ...wrapper, ...patch } as DefiFunctionPolicy, ...children])).toThrow();
  });

  it.each<[string, Partial<DefiFunctionPolicy>]>([
    ['inactive', { status: 'inactive' }],
    ['unverified', { provenance: { ...provenance, status: 'candidate' } }],
    ['wrong-chain', { chainId: 10 }],
    ['wrong-target', { contract: owner }],
    ['changed-ABI', { abi: { ...parseAbi([childDefinitions[0][1]])[0], outputs: [] } }],
    ['scoped-child', { executionScope: { kind: 'empty-callback-data-v1', bytesArgIndex: 0 } }],
  ])('rejects %s manifest child provenance or identity', (_name, patch) => {
    const { wrappers, children } = fixture();
    expect(() => manifestFor([...wrappers, { ...children[0], ...patch }, ...children.slice(1)])).toThrow();
  });

  it('rejects missing, wrong-signature and stale-hash manifest child bindings', () => {
    const { wrappers, children } = fixture();
    const wrapper = wrappers[1];
    const scope = wrapper.executionScope!;
    if (scope.kind !== 'same-target-router-multicall-v1') throw new Error('Invalid router fixture');
    for (const patch of [{ capabilityId: 'router:missing' }, { signature: 'exactOutput((bytes,address,uint256,uint256))' }, { abiHash: `0x${'00'.repeat(32)}` as Hex }]) {
      const changed = { ...wrapper, executionScope: { ...scope, allowedChildren: scope.allowedChildren.map((child, index) => index ? child : { ...child, ...patch }) } };
      expect(() => manifestFor([changed, ...children])).toThrow();
    }
  });
});
