import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, type AbiFunction, type Hex } from 'viem';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import type { DefiExecutionContext, DefiExecutionScope, DefiFunctionPolicy } from '../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../registry/defi-manifest';
import { executionScopeHash } from './scope';

const target = '0x04422053addbc9bb2759b248b574e3fca76bc145';
const owner = '0x2222222222222222222222222222222222222222';
const adapter = '0x7ca32dcd9269b0beb21a4f364ded5cffcb7b3635';
const mapleTarget = '0xa5cdee01aa7a5e0620df5f27f26e552fdf7f5f20';
const mapleAdapter = '0x896d345123642d85750291625ea89c65648e4e0c';
const recipient = '0x4444444444444444444444444444444444444444';
const provenance = { sourceRef: 'typed financial security fixture', verifiedAt: '2026-01-01', status: 'verified' as const };
const liquidateAbi = parseAbi(['function liquidate((uint256 tokenId,uint256 amount0Min,uint256 amount1Min,address recipient,bytes permitData,uint256 deadline) params) returns (uint256 amount0,uint256 amount1)'])[0];
const deallocateAbi = parseAbi(['function forceDeallocate(address adapter,bytes data,uint256 assets,address onBehalf) returns (uint256)'])[0];
const wrapperAbi = parseAbi(['function multicall(bytes[] data) returns (bytes[] results)'])[0];
const marketData = encodeAbiParameters(parseAbiParameters('address loanToken,address collateralToken,address oracle,address irm,uint256 lltv'), [owner, recipient, target, adapter, (1n << 256n) - 1n]);

function policyFunction(capabilityId: string, signature: string, abi: AbiFunction, executionScope: DefiExecutionScope, contract = target, chainId = 1): DefiFunctionPolicy {
  return { capabilityId, signature, abi, executionScope, type: 'contract_call', chainId, contract, functionName: abi.name, status: 'active', provenance };
}

function manifestFor(functions: readonly DefiFunctionPolicy[]) {
  return buildReviewedManifest(functions.map((fn) => ({ chains: [{ chainId: fn.chainId, status: 'active', contracts: [{ address: fn.contract, status: 'active', functions: [fn] }] }] })));
}

function fixture(selected?: readonly DefiFunctionPolicy[]) {
  const liquidate = policyFunction('liquidate', 'liquidate((uint256,uint256,uint256,address,bytes,uint256))', liquidateAbi, { kind: 'empty-tuple-bytes-v1', tupleArgIndex: 0, bytesComponentIndex: 4 });
  const deallocate = policyFunction('deallocate', 'forceDeallocate(address,bytes,uint256,address)', deallocateAbi, { kind: 'morpho-market-adapter-v1', adapter });
  const children = selected ?? [liquidate, deallocate];
  const host = children[0].contract;
  const wrapper = policyFunction('wrapper', 'multicall(bytes[])', wrapperAbi, {
    kind: 'same-target-financial-multicall-v1', bytesArrayArgIndex: 0, nativeValuePolicy: 'zero',
    allowedChildren: children.map((child) => ({ capabilityId: child.capabilityId, signature: child.signature, abiHash: functionAbiHash(child), executionScopeHash: executionScopeHash(child.executionScope!) })),
  }, host, children[0].chainId);
  const manifest = manifestFor([wrapper, ...children]);
  const state = { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) };
  const prisma = { defiPolicyState: state };
  const catalog = new DefiCatalogService(manifest.chains, prisma as never, manifest);
  const service = new DefiPolicyService(prisma as never, {} as never, catalog);
  const context: DefiExecutionContext = { userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId: children[0].chainId, executionMode: 'session_key', executionOwner: owner, allowedCapabilityIds: ['wrapper', ...children.map((child) => child.capabilityId)], capabilityMode: 'custom' };
  const liquidation = (permitData: Hex = '0x') => ({ to: target, data: encodeFunctionData({ abi: [liquidateAbi], functionName: 'liquidate', args: [[1n << 255n, 0n, 1n << 255n, recipient, permitData, (1n << 256n) - 1n]] } as never) });
  const deallocation = (data: Hex = marketData, selectedAdapter: string = adapter) => ({ to: target, data: encodeFunctionData({ abi: [deallocateAbi], functionName: 'forceDeallocate', args: [selectedAdapter, data, 1n << 255n, recipient] } as never) });
  const batch = (data: readonly Hex[]) => ({ to: host, data: encodeFunctionData({ abi: [wrapperAbi], functionName: 'multicall', args: [data] }) });
  const transaction = (grants: readonly string[] = context.allowedCapabilityIds) => ({
    $queryRaw: jest.fn(), defiPolicyState: state, userWallet: { findFirst: jest.fn().mockResolvedValue({ id: 'w' }) },
    apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: 'u', walletId: 'w', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, capabilityMode: 'custom', allowedCapabilityIds: grants }) },
  });
  return { liquidate, deallocate, wrapper, children, catalog, service, context, liquidation, deallocation, batch, transaction };
}

const invalid = { audit: { code: 'DEFI_INVALID_PARAMETERS' } };

describe('source-bound financial data constraints', () => {
  it('preserves financial choices while interpreting both standalone scoped primitives', async () => {
    const f = fixture();
    const auth = await f.service.authorizeContractCalls([f.liquidation(), f.deallocation()], f.context);
    expect(auth.executionPlan.map((node) => [node.path, node.match.capabilityId, node.match.executionScopeHash])).toEqual([
      [[0], 'liquidate', executionScopeHash(f.liquidate.executionScope!)], [[1], 'deallocate', executionScopeHash(f.deallocate.executionScope!)],
    ]);
    await expect(f.service.assertStillAuthorized(f.transaction() as never, auth)).resolves.toBeUndefined();
  });

  it('runs both nested decoders and rechecks every actual grant at final acceptance', async () => {
    const f = fixture();
    const call = f.batch([f.liquidation().data, f.deallocation().data]);
    const auth = await f.service.authorizeContractCalls([call], f.context);
    expect(auth.executionPlan.map((node) => [node.path, node.match.capabilityId])).toEqual([[[0], 'wrapper'], [[0, 0], 'liquidate'], [[0, 1], 'deallocate']]);
    await expect(f.service.assertStillAuthorized(f.transaction() as never, auth)).resolves.toBeUndefined();
    for (const id of f.context.allowedCapabilityIds) {
      const grants = f.context.allowedCapabilityIds.filter((candidate) => candidate !== id);
      await expect(f.service.authorizeContractCalls([call], { ...f.context, allowedCapabilityIds: grants })).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(f.service.assertStillAuthorized(f.transaction(grants) as never, auth)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    }
  });

  it('rejects nonempty permit bytes both directly and below the closed wrapper', async () => {
    const f = fixture();
    const call = f.liquidation('0x01');
    await expect(f.service.authorizeContractCalls([call], f.context)).rejects.toMatchObject(invalid);
    await expect(f.service.authorizeContractCalls([f.batch([call.data])], f.context)).rejects.toMatchObject(invalid);
  });

  it('rejects empty, truncated, extended and noncanonical MarketParams address words', async () => {
    const f = fixture();
    const invalidData: Hex[] = ['0x', marketData.slice(0, -2) as Hex, `${marketData}00`];
    for (let word = 0; word < 4; word++) {
      const offset = 2 + word * 64;
      invalidData.push(`${marketData.slice(0, offset)}01${marketData.slice(offset + 2)}` as Hex);
    }
    for (const data of invalidData) await expect(f.service.authorizeContractCalls([f.deallocation(data)], f.context)).rejects.toMatchObject(invalid);
    await expect(f.service.authorizeContractCalls([f.batch([f.deallocation(invalidData[3]).data])], f.context)).rejects.toMatchObject(invalid);
  });

  it('does not borrow the typed interpreter for another adapter or bypass it in all mode', async () => {
    const f = fixture();
    const context = { ...f.context, capabilityMode: 'all' as const, allowedCapabilityIds: [] };
    await expect(f.service.authorizeContractCalls([f.deallocation(marketData, recipient)], context)).rejects.toMatchObject(invalid);
    await expect(f.service.authorizeContractCalls([f.batch([f.liquidation('0x12').data])], context)).rejects.toMatchObject(invalid);
    await expect(f.service.authorizeContractCalls([f.batch([f.deallocation('0x').data])], context)).rejects.toMatchObject(invalid);
  });

  it('requires the declared nested scope hash and cannot flatten either protected signature', () => {
    const f = fixture();
    if (f.wrapper.executionScope?.kind !== 'same-target-financial-multicall-v1') throw new Error('Invalid fixture');
    for (const child of f.children) {
      const scope = { ...f.wrapper.executionScope, allowedChildren: f.wrapper.executionScope.allowedChildren.map((binding) => binding.capabilityId === child.capabilityId ? { capabilityId: binding.capabilityId, signature: binding.signature, abiHash: binding.abiHash } : binding) };
      expect(() => manifestFor([{ ...f.wrapper, executionScope: scope }, ...f.children])).toThrow();
      expect(() => manifestFor([{ ...f.wrapper, executionScope: scope }, ...f.children.map((candidate) => candidate === child ? { ...candidate, executionScope: undefined } : candidate)])).toThrow();
    }
  });

  it('fails final recomputation if a nested data-interpreter identity is changed', async () => {
    const f = fixture();
    const auth = await f.service.authorizeContractCalls([f.batch([f.deallocation().data])], f.context);
    const changed = { ...auth.executionPlan[1], match: { ...auth.executionPlan[1].match, executionScopeHash: `0x${'ff'.repeat(32)}` } };
    await expect(f.service.assertStillAuthorized(f.transaction() as never, { ...auth, executionPlan: [auth.executionPlan[0], changed] } as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
  });

  it('validates tuple fields, deployment identity and operation-specific returns at admission', () => {
    const f = fixture();
    expect(() => manifestFor([{ ...f.liquidate, executionScope: { kind: 'empty-tuple-bytes-v1', tupleArgIndex: 0, bytesComponentIndex: 0 } }])).toThrow();
    expect(() => manifestFor([{ ...f.liquidate, executionScope: { kind: 'empty-tuple-bytes-v1', tupleArgIndex: 1, bytesComponentIndex: 4 } }])).toThrow();
    expect(() => manifestFor([{ ...f.deallocate, abi: { ...f.deallocate.abi, outputs: [] } }])).toThrow();
    expect(() => manifestFor([{ ...f.deallocate, abi: { ...f.deallocate.abi, stateMutability: 'payable' } }])).toThrow();
    expect(() => manifestFor([{ ...f.deallocate, contract: recipient }])).toThrow();
    expect(() => manifestFor([{ ...f.deallocate, chainId: 10 }])).toThrow();
    expect(() => manifestFor([{ ...f.deallocate, executionScope: { kind: 'morpho-market-adapter-v1', adapter: recipient } }])).toThrow();
  });

  it.each([
    ['allocate', 'morpho-market-adapter-v1'], ['deallocate', 'morpho-market-adapter-v1'],
    ['deallocate', 'maple-adapter-exit-v1'], ['deallocateAsync', 'maple-adapter-exit-v1'],
  ] as const)('interprets %s under %s without flattening its data policy', async (operation, kind) => {
    const abi = parseAbi([`function ${operation}(address adapter,bytes data,uint256 assets)`])[0] as AbiFunction;
    const maple = kind === 'maple-adapter-exit-v1';
    const selectedAdapter = maple ? mapleAdapter : adapter;
    const host = maple ? mapleTarget : target;
    const child = policyFunction('adapter-operation', `${operation}(address,bytes,uint256)`, abi, { kind, adapter: selectedAdapter }, host);
    const f = fixture([child]);
    const encode = (data: Hex) => encodeFunctionData({ abi: [abi], functionName: operation, args: [selectedAdapter, data, 1n << 255n] } as never);
    const data = encode(maple ? '0x' : marketData);
    const auth = await f.service.authorizeContractCalls([f.batch([data])], f.context);
    expect(auth.executionPlan.map((node) => [node.path, node.match.capabilityId])).toEqual([[[0], 'wrapper'], [[0, 0], child.capabilityId]]);
    await expect(f.service.assertStillAuthorized(f.transaction() as never, auth)).resolves.toBeUndefined();
    await expect(f.service.authorizeContractCalls([f.batch([encode(maple ? marketData : '0x')])], f.context)).rejects.toMatchObject(invalid);
    expect(() => manifestFor([{ ...child, abi: { ...abi, outputs: [{ type: 'uint256', name: '' }] } }])).toThrow();
  });

  it('does not activate Maple lender permissions through either adapter grammar', () => {
    const abi = parseAbi(['function allocate(address adapter,bytes data,uint256 assets)'])[0];
    for (const kind of ['maple-adapter-exit-v1', 'morpho-market-adapter-v1'] as const) {
      expect(() => manifestFor([policyFunction('allocate', 'allocate(address,bytes,uint256)', abi, { kind, adapter: mapleAdapter }, mapleTarget)])).toThrow();
    }
  });
});
