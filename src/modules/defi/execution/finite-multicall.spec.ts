import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, type AbiFunction, type Hex } from 'viem';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import type { DefiExecutionContext, DefiExecutionScope, DefiFunctionPolicy, FiniteMulticallScope } from '../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../registry/defi-manifest';
import type { DefiRegistryFragment } from '../registry/defi-manifest.types';
import { executionScopeHash } from './scope';
import { preflightPendleMulticall } from './planner';
import { UNISWAP_DEPLOYMENTS, UNISWAP_POOL_MANAGERS, UNISWAP_V4_POSITION_ABI } from './uniswap-deployments';

const target = '0x3333333333333333333333333333333333333333';
const owner = '0x2222222222222222222222222222222222222222';
const token = '0x4444444444444444444444444444444444444444';
const zero = '0x0000000000000000000000000000000000000000';
const sender = '0x0000000000000000000000000000000000000001';
const self = '0x0000000000000000000000000000000000000002';
const provenance = { sourceRef: 'finite multicall security fixture', verifiedAt: '2026-01-01', status: 'verified' as const };
const invalid = { audit: { code: 'DEFI_INVALID_PARAMETERS' } };
const unavailable = { audit: { code: 'DEFI_POLICY_UNAVAILABLE' } };
const forbidden = { audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } };

function fn(id: string, signature: string, abi: AbiFunction, contract = target, executionScope?: DefiExecutionScope): DefiFunctionPolicy {
  return { capabilityId: id, type: 'contract_call', chainId: 1, contract, signature, functionName: abi.name, abi, status: 'active', provenance, ...(executionScope ? { executionScope } : {}) };
}
function binding(child: DefiFunctionPolicy) {
  return { capabilityId: child.capabilityId, signature: child.signature, abiHash: functionAbiHash(child), ...(child.executionScope ? { executionScopeHash: executionScopeHash(child.executionScope) } : {}) };
}
function manifestFor(functions: readonly DefiFunctionPolicy[]) {
  return buildReviewedManifest(functions.map<DefiRegistryFragment>((child) => ({ chains: [{ chainId: child.chainId, status: 'active', contracts: [{ address: child.contract, status: 'active', functions: [child] }] }] })));
}
function harness(functions: readonly DefiFunctionPolicy[]) {
  const manifest = manifestFor(functions);
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const catalog = new DefiCatalogService(manifest.chains, prisma as never, manifest);
  const service = new DefiPolicyService(prisma as never, {} as never, catalog);
  const context: DefiExecutionContext = { userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId: 1, executionMode: 'session_key', executionOwner: owner, allowedCapabilityIds: functions.map((child) => child.capabilityId) };
  return { manifest, prisma, catalog, service, context };
}
function transaction(grants: readonly string[], capabilityMode: 'all' | 'custom' = 'custom') {
  return { $queryRaw: jest.fn(), defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) }, userWallet: { findFirst: jest.fn().mockResolvedValue({ id: 'w' }) }, apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: 'u', walletId: 'w', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, capabilityMode, allowedCapabilityIds: grants }) } };
}
function financial(mutability: 'payable' | 'nonpayable' = 'payable', outputs = true, nativeValuePolicy: 'inherit' | 'zero' = 'inherit') {
  const children = [
    fn('financial:refund', 'refundETH()', parseAbi(['function refundETH() payable'])[0]),
    fn('financial:take', 'take(address,uint256,address,bytes)', { type: 'function', name: 'take', stateMutability: 'nonpayable', inputs: [{ name: 'borrowerAddress_', type: 'address', internalType: 'address' }, { name: 'maxAmount_', type: 'uint256', internalType: 'uint256' }, { name: 'callee_', type: 'address', internalType: 'address' }, { name: 'data_', type: 'bytes', internalType: 'bytes' }], outputs: [{ name: 'collateralTaken_', type: 'uint256', internalType: 'uint256' }] }, target, { kind: 'empty-callback-data-v1', bytesArgIndex: 3 }),
    fn('financial:deposit', 'deposit(uint256,address)', { type: 'function', name: 'deposit', stateMutability: 'nonpayable', inputs: [{ name: 'assets', type: 'uint256', internalType: 'uint256' }, { name: 'receiver', type: 'address', internalType: 'address' }], outputs: [{ name: 'shares', type: 'uint256', internalType: 'uint256' }] }),
  ];
  const scope: FiniteMulticallScope = { kind: 'same-target-financial-multicall-v1', bytesArrayArgIndex: 0, nativeValuePolicy, allowedChildren: children.map(binding) };
  const wrapper = fn('financial:root', 'multicall(bytes[])', parseAbi([`function multicall(bytes[] data)${mutability === 'payable' ? ' payable' : ''}${outputs ? ' returns (bytes[] results)' : ''}`])[0] as AbiFunction, target, scope);
  const refund = encodeFunctionData({ abi: [children[0].abi], functionName: 'refundETH' });
  const take = (data: Hex = '0x') => encodeFunctionData({ abi: [children[1].abi], functionName: 'take', args: [owner, 7n, owner, data] } as never);
  const deposit = encodeFunctionData({ abi: [children[2].abi], functionName: 'deposit', args: [2n ** 255n, owner] } as never);
  const root = (calls: readonly Hex[], value = '0') => ({ to: target, data: encodeFunctionData({ abi: [wrapper.abi], functionName: 'multicall', args: [calls] } as never), value });
  return { ...harness([wrapper, ...children]), wrapper, children, scope, refund, take, deposit, root };
}
function pendle(named = true) {
  const child = fn('pendle:child', 'mintPyFromSy(address,address,uint256,uint256)', parseAbi(['function mintPyFromSy(address receiver,address YT,uint256 netSyIn,uint256 minPyOut) returns (uint256 netPyOut)'])[0]);
  const declaration = named ? 'function multicall((bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] results)' : 'function multicall((bool,bytes)[]) payable returns ((bool,bytes)[])';
  const wrapper = fn('pendle:root', 'multicall((bool,bytes)[])', parseAbi([declaration])[0], target, { kind: 'pendle-router-multicall-v1', allowedChildren: [binding(child)] });
  const data = encodeFunctionData({ abi: [child.abi], functionName: child.functionName, args: [owner, token, 2n ** 255n, 0n] } as never);
  const root = (allowFailure: boolean, callData: Hex = data, value = '0') => ({ to: target, data: encodeFunctionData({ abi: [wrapper.abi], functionName: 'multicall', args: [named ? [{ allowFailure, callData }] : [[allowFailure, callData]]] } as never), value });
  return { ...harness([wrapper, child]), wrapper, child, data, root };
}
function params(types: string, values: readonly unknown[]): Hex {
  return encodeAbiParameters(parseAbiParameters(types), values);
}
type Operation = readonly [number, Hex];
function v4(chainId = 1) {
  const address = UNISWAP_DEPLOYMENTS[chainId].positionManager;
  const child = { ...fn('v4:child', 'modifyLiquidities(bytes,uint256)', UNISWAP_V4_POSITION_ABI, address, { kind: 'uniswap-v4-position-manager-v1' }), chainId };
  const descriptor = { ...binding(child), executionScopeHash: executionScopeHash(child.executionScope!) };
  const wrapper = { ...fn('v4:root', 'multicall(bytes[])', parseAbi(['function multicall(bytes[] data) payable returns (bytes[] results)'])[0], address, { kind: 'uniswap-v4-position-manager-multicall-v1', allowedChildren: [descriptor] }), chainId };
  const modify = (operations: readonly Operation[]) => encodeFunctionData({ abi: [child.abi], functionName: child.functionName, args: [params('bytes actions,bytes[] params', [`0x${operations.map(([code]) => code.toString(16).padStart(2, '0')).join('')}`, operations.map(([, data]) => data)]), 1n] } as never);
  const root = (calls: readonly Hex[], value = '0') => ({ to: address, data: encodeFunctionData({ abi: [wrapper.abi], functionName: 'multicall', args: [calls] } as never), value });
  const setup = harness([wrapper, child]);
  return { ...setup, context: { ...setup.context, chainId }, wrapper, child, root, modify, address };
}
const replaceWord = (data: Hex, index: number, value: bigint): Hex => `${data.slice(0, 10 + index * 64)}${value.toString(16).padStart(64, '0')}${data.slice(10 + (index + 1) * 64)}` as Hex;

describe('finite financial multicall', () => {
  it.each([[true, 'payable'], [false, 'payable'], [true, 'nonpayable'], [false, 'nonpayable']] as const)('plans actual output=%s mutability=%s and enforces the scoped child decoder', async (outputs, mutability) => {
    const f = financial(mutability, outputs);
    const auth = await f.service.authorizeContractCalls([f.root([f.refund, f.take(), f.deposit])], f.context);
    expect(auth.executionPlan.map((node) => [node.path, node.match.capabilityId, node.match.nativeValue])).toEqual([[[0], f.wrapper.capabilityId, '0'], [[0, 0], f.children[0].capabilityId, '0'], [[0, 1], f.children[1].capabilityId, '0'], [[0, 2], f.children[2].capabilityId, '0']]);
    expect(auth.executionPlan[2].match.executionScopeHash).toBe(executionScopeHash(f.children[1].executionScope!));
    await f.service.assertStillAuthorized(transaction(f.context.allowedCapabilityIds) as never, auth);
    await expect(f.service.authorizeContractCalls([f.root([f.take('0x01')])], f.context)).rejects.toMatchObject(invalid);
    if (mutability === 'nonpayable') await expect(f.service.authorizeContractCalls([f.root([f.refund], '1')], f.context)).rejects.toMatchObject(invalid);
  });
  it('inherits value once without overriding intrinsic nonpayability and applies explicit zero policy', async () => {
    const f = financial();
    const auth = await f.service.authorizeContractCalls([f.root([f.refund, f.refund], '7')], f.context);
    expect(auth.interactions.map((call) => call.value)).toEqual(['7']);
    expect(auth.executionPlan.map((node) => node.match.nativeValue)).toEqual(['7', '7', '7']);
    await expect(f.service.authorizeContractCalls([f.root([f.deposit], '1')], f.context)).rejects.toMatchObject(invalid);
    const z = financial('payable', false, 'zero');
    await expect(z.service.authorizeContractCalls([z.root([z.refund], '1')], z.context)).rejects.toMatchObject(invalid);
    expect((await z.service.authorizeContractCalls([z.root([z.refund])], z.context)).executionPlan[1].match.capabilityId).toBe(z.children[0].capabilityId);
    expect(executionScopeHash(z.scope)).not.toBe(executionScopeHash({ ...z.scope, nativeValuePolicy: 'inherit' }));
  });
  it('requires an exact scoped-child hash iff the actual child has the permitted scope', () => {
    const f = financial();
    for (const hash of [undefined, `0x${'ff'.repeat(32)}`]) {
      const scope = { ...f.scope, allowedChildren: f.scope.allowedChildren.map((entry, index) => index === 1 ? { ...entry, executionScopeHash: hash } : entry) } as DefiExecutionScope;
      expect(() => manifestFor([{ ...f.wrapper, executionScope: scope }, ...f.children])).toThrow();
    }
    const scope = { ...f.scope, allowedChildren: f.scope.allowedChildren.map((entry, index) => index === 0 ? { ...entry, executionScopeHash: executionScopeHash(f.children[1].executionScope!) } : entry) } as DefiExecutionScope;
    expect(() => manifestFor([{ ...f.wrapper, executionScope: scope }, ...f.children])).toThrow();
    expect(() => manifestFor([f.wrapper, f.children[0], { ...f.children[1], executionScope: { kind: 'empty-callback-data-v1', bytesArgIndex: 0 } }, f.children[2]])).toThrow();
  });
  it('rejects nonfinancial scopes and inconsistent root shapes without widening the old grammars', () => {
    const f = financial();
    for (const abi of [
      { ...f.wrapper.abi, stateMutability: 'view' },
      { ...f.wrapper.abi, inputs: [{ type: 'bytes' }] },
      { ...f.wrapper.abi, outputs: [{ type: 'bytes' }] },
      { ...f.wrapper.abi, outputs: [{ type: 'bytes[]' }, { type: 'bytes[]' }] },
    ]) expect(() => manifestFor([{ ...f.wrapper, abi } as DefiFunctionPolicy, ...f.children])).toThrow();
    for (const scope of [
      { ...f.scope, nativeValuePolicy: 'arbitrary' },
      { ...f.scope, bytesArrayArgIndex: 1 },
      { ...f.scope, allowedChildren: [] },
      { ...f.scope, allowedChildren: [...f.scope.allowedChildren, f.scope.allowedChildren[0]] },
    ]) expect(() => executionScopeHash(scope as DefiExecutionScope)).toThrow();
    const scoped = { ...f.children[0], executionScope: { kind: 'uniswap-v4-position-manager-v1' } as const };
    expect(() => manifestFor([f.wrapper, scoped, ...f.children.slice(1)])).toThrow();
  });
  it('rejects wrappers, unknown children, malformed ABI and aggregate/node overflows', async () => {
    const f = financial();
    for (const data of ['0x12345678' as Hex, f.root([f.refund]).data]) await expect(f.service.authorizeContractCalls([f.root([data])], f.context)).rejects.toMatchObject(forbidden);
    for (const data of [replaceWord(f.root([f.refund]).data, 1, 1n << 255n), `${f.root([f.refund]).data}00` as Hex]) await expect(f.service.authorizeContractCalls([{ to: target, data }], f.context)).rejects.toMatchObject(invalid);
    const auth = await f.service.authorizeContractCalls([f.root(Array(9).fill(f.refund))], f.context);
    expect(auth.executionPlan[9].path).toEqual([0, 8]);
    await expect(f.service.authorizeContractCalls([f.root(Array(10).fill(f.refund))], f.context)).rejects.toMatchObject(invalid);
    await expect(f.service.authorizeContractCalls([f.root([`${f.refund}${'00'.repeat(65_536)}` as Hex])], f.context)).rejects.toMatchObject(invalid);
  });
});

describe('Pendle optional-failure multicall', () => {
  it.each([true, false])('authorizes every attempted child with allowFailure=%s and commits the flag', async (allowFailure) => {
    for (const named of [true, false]) {
      const f = pendle(named);
      const auth = await f.service.authorizeContractCalls([f.root(allowFailure)], f.context);
      expect(auth.executionPlan.map((node) => [node.path, node.match.capabilityId])).toEqual([[[0], f.wrapper.capabilityId], [[0, 0], f.child.capabilityId]]);
      const other = await f.service.authorizeContractCalls([f.root(!allowFailure)], f.context);
      expect(auth.requestCommitment).not.toBe(other.requestCommitment);
      expect(auth.executionPlan[0].data).not.toBe(other.executionPlan[0].data);
      await f.service.assertStillAuthorized(transaction(f.context.allowedCapabilityIds) as never, auth);
      await expect(f.service.assertStillAuthorized(transaction(f.context.allowedCapabilityIds) as never, { ...auth, executionPlan: [other.executionPlan[0], auth.executionPlan[1]] })).rejects.toMatchObject(unavailable);
      await expect(f.service.authorizeContractCalls([f.root(allowFailure, '0x12345678')], f.context)).rejects.toMatchObject(forbidden);
      await expect(f.service.authorizeContractCalls([f.root(allowFailure, f.data, '1')], f.context)).rejects.toMatchObject(invalid);
    }
  });
  it('preflights tuple flags, offsets, counts, lengths and canonical payload padding before decoding', async () => {
    const f = pendle();
    const call = f.root(true);
    // Words: root offset, length, element offset, bool, bytes offset, bytes length.
    for (const data of [replaceWord(call.data, 0, 64n), replaceWord(call.data, 1, 1n << 255n), replaceWord(call.data, 2, 0n), replaceWord(call.data, 3, 2n), replaceWord(call.data, 4, 96n), replaceWord(call.data, 5, 1n << 255n), `${call.data}00` as Hex]) {
      expect(() => preflightPendleMulticall(data)).toThrow();
      await expect(f.service.authorizeContractCalls([{ ...call, data }], f.context)).rejects.toMatchObject(invalid);
    }
    const short = f.root(false, '0x12345678').data;
    expect(() => preflightPendleMulticall(`${short.slice(0, -2)}01`)).toThrow();
  });
  it('rejects payable/scoped children, wrong tuple ABI and a nested wrapper even when optional', async () => {
    const f = pendle();
    expect(() => manifestFor([f.wrapper, { ...f.child, abi: { ...f.child.abi, stateMutability: 'payable' } }])).toThrow();
    expect(() => manifestFor([f.wrapper, { ...f.child, executionScope: { kind: 'empty-callback-data-v1', bytesArgIndex: 0 } }])).toThrow();
    for (const abi of [
      { ...f.wrapper.abi, stateMutability: 'nonpayable' },
      { ...f.wrapper.abi, inputs: [{ type: 'tuple[]', components: [{ type: 'uint256' }, { type: 'bytes' }] }] },
      { ...f.wrapper.abi, outputs: [] },
    ]) expect(() => manifestFor([{ ...f.wrapper, abi } as DefiFunctionPolicy, f.child])).toThrow();
    await expect(f.service.authorizeContractCalls([f.root(true, f.root(false).data)], f.context)).rejects.toMatchObject(forbidden);
  });
});

describe('Uniswap V4 self-delegatecall multicall', () => {
  it.each(Object.keys(UNISWAP_DEPLOYMENTS).map(Number))('preserves actual caller and direct V4 behavior on chain %i', async (chainId) => {
    const f = v4(chainId);
    const data = f.modify([[0x12, params('address', [token])], [0x14, params('address,address', [zero, sender])]]);
    const auth = await f.service.authorizeContractCalls([f.root([data])], f.context);
    expect(auth.executionPlan.map((node) => [node.path, node.match.capabilityId, node.match.executionScopeHash])).toEqual([[[0], f.wrapper.capabilityId, executionScopeHash(f.wrapper.executionScope!)], [[0, 0], f.child.capabilityId, executionScopeHash(f.child.executionScope!)]]);
    const direct = await f.service.authorizeContractCalls([{ to: f.address, data }], f.context);
    expect(direct.executionPlan[0].match.capabilityId).toBe(f.child.capabilityId);
    await f.service.assertStillAuthorized(transaction(f.context.allowedCapabilityIds) as never, auth);
  });
  it('retains full-drain checks, unknown/nested child rejection and exact identity gate', async () => {
    const f = v4();
    const take: Operation = [0x0e, params('address,address,uint256', [token, self, 1n])];
    await expect(f.service.authorizeContractCalls([f.root([f.modify([take])])], f.context)).rejects.toMatchObject(invalid);
    const swept = f.modify([take, [0x14, params('address,address', [token, sender])]]);
    expect((await f.service.authorizeContractCalls([f.root([swept])], f.context)).executionPlan[1].data).toBe(swept);
    await expect(f.service.authorizeContractCalls([f.root([swept], '1')], f.context)).rejects.toMatchObject(invalid);
    const refunded = f.modify([take, [0x14, params('address,address', [token, sender])], [0x14, params('address,address', [zero, sender])]]);
    expect((await f.service.authorizeContractCalls([f.root([refunded], '1')], f.context)).executionPlan[1].match.nativeValue).toBe('1');
    for (const data of ['0x12345678' as Hex, f.root([swept]).data]) await expect(f.service.authorizeContractCalls([f.root([data])], f.context)).rejects.toMatchObject(forbidden);
    expect(() => manifestFor([{ ...f.wrapper, contract: target }, { ...f.child, contract: target }])).toThrow();
    expect(() => manifestFor([{ ...f.wrapper, executionScope: undefined }, f.child])).toThrow();
    expect(() => manifestFor([{ ...f.wrapper, abi: { ...f.wrapper.abi, outputs: [] } }, f.child])).toThrow();
  });
  it('requires explicit actual child ABI and execution-scope hashes', () => {
    const f = v4();
    const scope = f.wrapper.executionScope!;
    if (scope.kind !== 'uniswap-v4-position-manager-multicall-v1') throw new Error('Invalid fixture');
    for (const patch of [{ abiHash: `0x${'ff'.repeat(32)}` }, { executionScopeHash: `0x${'ff'.repeat(32)}` }, { executionScopeHash: undefined }]) expect(() => manifestFor([{ ...f.wrapper, executionScope: { ...scope, allowedChildren: [{ ...scope.allowedChildren[0], ...patch }] } as DefiExecutionScope }, f.child])).toThrow();
  });
  it('shares operations and touched-target pauses over all wrapper children and roots', async () => {
    const f = v4();
    const data = f.modify([[0x12, params('address', [token])]]);
    const call = f.root([data, data]);
    const auth = await f.service.authorizeContractCalls([call], f.context);
    expect(auth.executionPlan.map((node) => node.path)).toEqual([[0], [0, 0], [0, 1]]);
    for (const address of [token, UNISWAP_POOL_MANAGERS[1]]) {
      f.prisma.defiPolicyState.findUnique.mockResolvedValue({ id: 'global', pausedScopeKeys: [`contract:1:${address}`] });
      await expect(f.service.authorizeContractCalls([call], f.context)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
      const tx = transaction(f.context.allowedCapabilityIds);
      tx.defiPolicyState.findUnique.mockResolvedValue({ id: 'global', pausedScopeKeys: [`contract:1:${address}`] });
      await expect(f.service.assertStillAuthorized(tx as never, auth)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
    }
  });
  it('shares the existing 64-action budget while counting wrapper and modify calls as ten-node execution nodes', async () => {
    const f = v4();
    const close: Operation = [0x12, params('address', [token])];
    const one = f.modify([close]);
    const nine = await f.service.authorizeContractCalls([f.root(Array(9).fill(one))], f.context);
    expect(nine.executionPlan.map((node) => node.path)).toEqual([[0], ...Array.from({ length: 9 }, (_, index) => [0, index])]);
    await expect(f.service.authorizeContractCalls([f.root(Array(10).fill(one))], f.context)).rejects.toMatchObject(invalid);
    const thirtyTwo = f.modify(Array(32).fill(close));
    const call = f.root([thirtyTwo, thirtyTwo]);
    expect((await f.service.authorizeContractCalls([call], f.context)).executionPlan.map((node) => node.path)).toEqual([[0], [0, 0], [0, 1]]);
    await expect(f.service.authorizeContractCalls([f.root([thirtyTwo, thirtyTwo, one])], f.context)).rejects.toMatchObject(invalid);
    const roots = [f.root([thirtyTwo]), f.root([thirtyTwo])];
    expect((await f.service.authorizeContractCalls(roots, f.context)).executionPlan.map((node) => node.path)).toEqual([[0], [0, 0], [1], [1, 0]]);
    await expect(f.service.authorizeContractCalls([...roots, { to: f.address, data: one }], f.context)).rejects.toMatchObject(invalid);
    const direct = f.modify(Array(64).fill(close));
    expect((await f.service.authorizeContractCalls([{ to: f.address, data: direct }], f.context)).executionPlan[0].data).toBe(direct);
  });
});

describe('finite multicall grants, pauses and final binding recomputation', () => {
  const fixtures = [() => { const f = financial(); return { ...f, child: f.children[1], call: f.root([f.take()]) }; }, ...[true, false].map((flag) => () => { const f = pendle(); return { ...f, call: f.root(flag) }; }), () => { const f = v4(); return { ...f, call: f.root([f.modify([[0x12, params('address', [token])]])]) }; }];
  it.each(fixtures)('requires all attempted child/root grants and pauses, including all-mode final changes', async (create) => {
    const f = create();
    for (const capabilityMode of ['custom', 'all'] as const) {
      const context = { ...f.context, capabilityMode, allowedCapabilityIds: capabilityMode === 'all' ? [] : f.context.allowedCapabilityIds };
      const auth = await f.service.authorizeContractCalls([f.call], context);
      for (const id of [f.wrapper.capabilityId, f.child.capabilityId]) {
        const grants = [f.wrapper.capabilityId, f.child.capabilityId].filter((entry) => entry !== id);
        await expect(f.service.authorizeContractCalls([f.call], { ...f.context, allowedCapabilityIds: grants })).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
        await expect(f.service.assertStillAuthorized(transaction(grants) as never, auth)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
        f.prisma.defiPolicyState.findUnique.mockResolvedValue({ id: 'global', pausedScopeKeys: [`capability:${id}`] });
        await expect(f.service.authorizeContractCalls([f.call], context)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
        const tx = transaction(context.allowedCapabilityIds, capabilityMode);
        tx.defiPolicyState.findUnique.mockResolvedValue({ id: 'global', pausedScopeKeys: [`capability:${id}`] });
        await expect(f.service.assertStillAuthorized(tx as never, auth)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
        f.prisma.defiPolicyState.findUnique.mockResolvedValue({ id: 'global', pausedScopeKeys: [] });
      }
      const node = auth.executionPlan[1];
      const tampered = { ...auth, executionPlan: [auth.executionPlan[0], { ...node, match: { ...node.match, executionScopeHash: `0x${'ff'.repeat(32)}` as Hex } }] };
      await expect(f.service.assertStillAuthorized(transaction(context.allowedCapabilityIds, capabilityMode) as never, tampered)).rejects.toMatchObject(unavailable);
    }
  });
});
