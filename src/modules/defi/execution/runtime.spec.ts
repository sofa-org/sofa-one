import { encodeFunctionData, parseAbi } from 'viem';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import { buildReviewedManifest, functionAbiHash } from '../registry/defi-manifest';
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST } from '../registry/production-registry';
import { buildDefiRequestCommitment } from '../defi-policy.service';
import type { DefiChainPolicy, DefiExecutionContext, DefiFunctionPolicy } from '../defi.types';
import type { PrismaService } from '../../../core/database/prisma.service';
import type { SecurityEventService } from '../../security-events/security-event.service';

const target = '0x1111111111111111111111111111111111111111';
const owner = '0x2222222222222222222222222222222222222222';
const childDefs = [
  ['mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))', 'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable'],
  ['increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))', 'function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable'],
  ['decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))', 'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable'],
  ['collect((uint256,address,uint128,uint128))', 'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) payable'],
  ['burn(uint256)', 'function burn(uint256 tokenId) payable'],
  ['refundETH()', 'function refundETH() payable'],
  ['unwrapWETH9(uint256,address)', 'function unwrapWETH9(uint256 amountMinimum,address recipient) payable'],
  ['sweepToken(address,uint256,address)', 'function sweepToken(address token,uint256 amountMinimum,address recipient) payable'],
] as const;
const parsedChildren = childDefs.map(([, text]) => parseAbi([text])[0]);
const wrapperAbi = parseAbi(['function multicall(bytes[] data) payable returns (bytes[] results)'])[0];
const ids = childDefs.map((_, i) => `npm:child:${i}`);
const childFunctions: DefiFunctionPolicy[] = parsedChildren.map((abi, i) => ({ capabilityId: ids[i], type: 'contract_call', chainId: 1, contract: target, functionName: abi.name, signature: childDefs[i][0], abi, status: 'active', provenance: { sourceRef: 'test fixture', verifiedAt: '2026-01-01', status: 'verified' } }));
const wrapper: DefiFunctionPolicy = {
  capabilityId: 'npm:wrapper', type: 'contract_call', chainId: 1, contract: target, functionName: 'multicall', signature: 'multicall(bytes[])', abi: wrapperAbi, status: 'active',
  provenance: { sourceRef: 'test fixture', verifiedAt: '2026-01-01', status: 'verified' },
  executionScope: { kind: 'same-target-multicall-v1', bytesArrayArgIndex: 0, allowedChildren: childFunctions.map((fn) => ({ capabilityId: fn.capabilityId, signature: fn.signature, abiHash: functionAbiHash(fn) })) },
};
const catalog: DefiChainPolicy[] = [{ chainId: 1, status: 'active', contracts: [{ address: target, status: 'active', functions: [wrapper, ...childFunctions] }] }];
const manifest = buildReviewedManifest([{ chains: catalog }]);
const context: DefiExecutionContext = { userId: 'u', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'w', chainId: 1, executionMode: 'session_key', executionOwner: owner, allowedCapabilityIds: [wrapper.capabilityId, ...ids] };
const refund = encodeFunctionData({ abi: [parsedChildren[5]], functionName: 'refundETH' });
const make = () => {
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const service = new DefiPolicyService(prisma as unknown as PrismaService, {} as SecurityEventService, new DefiCatalogService(catalog, prisma as unknown as PrismaService, manifest));
  return { service, prisma };
};
const root = (children: `0x${string}`[], value = '0') => ({ to: target, data: encodeFunctionData({ abi: [wrapperAbi], functionName: 'multicall', args: [children] }), value });
const mockTx = (grants: readonly string[]) => ({ $queryRaw: jest.fn(), defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) }, apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: 'u', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: grants }) } });

describe('scoped execution runtime', () => {
  it('plans one canonical root and its child, preserving ordered frozen paths and safe audit data', async () => {
    const { service } = make();
    const auth = await service.authorizeContractCalls([root([refund], '60')], context);
    expect(auth.matches).toHaveLength(1);
    expect(auth.executionPlan.map((node) => node.path)).toEqual([[0], [0, 0]]);
    expect(auth.executionPlan[1].data).toBe(refund);
    expect(Object.isFrozen(auth.executionPlan[1].path)).toBe(true);
    expect(JSON.stringify(auth.executionPlan)).not.toContain('financial');
    await expect(service.assertStillAuthorized(mockTx(context.allowedCapabilityIds) as never, auth)).resolves.toBeUndefined();
    await expect(service.assertStillAuthorized(mockTx([wrapper.capabilityId, ...ids.filter((id) => id !== ids[5])]) as never, auth)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
  });

  it('enforces the ten-node aggregate bound across wrapper and scalar roots', async () => {
    const { service } = make();
    const direct = { to: target, data: refund };
    const ten = await service.authorizeContractCalls([root([refund]), ...Array.from({ length: 8 }, () => direct)], context);
    expect(ten.executionPlan).toHaveLength(10);
    await expect(service.authorizeContractCalls([root([refund, refund]), ...Array.from({ length: 8 }, () => direct)], context)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it('rejects a missing wrapper grant, a missing child grant, and non-allowlisted child selectors', async () => {
    const { service } = make();
    await expect(service.authorizeContractCalls([root([refund])], { ...context, allowedCapabilityIds: ids })).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(service.authorizeContractCalls([root([refund])], { ...context, allowedCapabilityIds: [wrapper.capabilityId, ...ids.filter((id) => id !== ids[5])] })).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(service.authorizeContractCalls([root(['0x12345678'])], context)).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    await expect(service.authorizeContractCalls([root([])], context)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    await expect(service.authorizeContractCalls([{ ...root([refund]), data: `${root([refund]).data}00` }], context)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    const nested = root([refund]);
    await expect(service.authorizeContractCalls([root([nested.data as `0x${string}`])], context)).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
    for (const forbidden of ['0x095ea7b3', '0xa22cb465']) await expect(service.authorizeContractCalls([root([forbidden as `0x${string}`])], context)).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
  });

  it('rejects tampered child path, data, order, or binding during final recomputation', async () => {
    const { service } = make();
    const auth = await service.authorizeContractCalls([root([refund])], context);
    const tx = mockTx(context.allowedCapabilityIds);
    const altered = (patch: Record<string, unknown>) => ({ ...auth, executionPlan: auth.executionPlan.map((node, index) => index ? { ...node, ...patch } : node) });
    await expect(service.assertStillAuthorized(tx as never, altered({ path: [0, 1] }) as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    await expect(service.assertStillAuthorized(tx as never, altered({ data: '0x12345678' }) as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    await expect(service.assertStillAuthorized(tx as never, { ...auth, executionPlan: [...auth.executionPlan].reverse() } as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    const paused = mockTx(context.allowedCapabilityIds);
    paused.defiPolicyState.findUnique.mockResolvedValue({ id: 'global', pausedScopeKeys: ['capability:npm:child:5'] });
    await expect(service.assertStillAuthorized(paused as never, auth)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
    const revoked = mockTx(context.allowedCapabilityIds);
    revoked.apiKey.findUnique.mockResolvedValue({ userId: 'u', revoked: true, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: context.allowedCapabilityIds });
    await expect(service.assertStillAuthorized(revoked as never, auth)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    await expect(service.assertStillAuthorized(tx as never, { ...auth, requestCommitment: `0x${'0'.repeat(64)}` } as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    await expect(service.assertStillAuthorized(tx as never, { ...auth, context: { ...auth.context, executionOwner: '0x3333333333333333333333333333333333333333' } } as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    await expect(service.assertStillAuthorized(tx as never, { ...auth, manifestHash: `0x${'0'.repeat(64)}` } as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    const badChildMatch = { ...auth, executionPlan: auth.executionPlan.map((node, index) => index ? { ...node, match: { ...node.match, capabilityId: wrapper.capabilityId } } : node) };
    await expect(service.assertStillAuthorized(tx as never, badChildMatch as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    for (const changedKey of [
      { frozenAt: new Date() }, { expiresAt: new Date(Date.now() - 1000) }, { canSendTransaction: false },
      { userId: 'someone-else' },
    ]) {
      const invalid = mockTx(context.allowedCapabilityIds);
      invalid.apiKey.findUnique.mockResolvedValue({ userId: 'u', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: context.allowedCapabilityIds, ...changedKey });
      await expect(service.assertStillAuthorized(invalid as never, auth)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    }
  });

  it('records only safe root/child identifiers in deferred acceptance audit metadata', async () => {
    const eventService = { record: jest.fn().mockResolvedValue({ eventType: 'defi.capability_allowed' }) };
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    const service = new DefiPolicyService(prisma as never, eventService as never, new DefiCatalogService(catalog, prisma as never, manifest));
    const auth = await service.authorizeContractCalls([root([refund], '60')], context);
    await service.recordAllowedInTx({} as never, auth);
    const event = eventService.record.mock.calls[0]![0];
    const json = JSON.stringify(event.metadata);
    expect(json).toContain(ids[5]);
    expect(json).toContain('[0,0]');
    expect(json).not.toContain(refund);
    expect(json).not.toContain(((1n << 255n).toString()));
    expect(eventService.record).toHaveBeenCalledWith(expect.anything(), {}, { deferExport: true });
  });

  it('accepts only truly empty Morpho callback bytes without constraining unrelated financial arguments', async () => {
    const defs = [
      ['supply', 'function supply(address loanToken,address collateralToken,uint256 amount,address onBehalf,bytes data)', 'supply(address,address,uint256,address,bytes)', 4],
      ['supplyCollateral', 'function supplyCollateral(address collateralToken,uint256 amount,address onBehalf,bytes data)', 'supplyCollateral(address,uint256,address,bytes)', 3],
      ['repay', 'function repay(address loanToken,uint256 amount,uint256 shares,address onBehalf,bytes data)', 'repay(address,uint256,uint256,address,bytes)', 4],
    ] as const;
    const functions: DefiFunctionPolicy[] = defs.map(([name, declaration, signature, bytesArgIndex]) => {
      const abi = parseAbi([declaration])[0];
      return { capabilityId: `morpho:${name}`, type: 'contract_call', chainId: 1, contract: target, functionName: name, signature, abi, status: 'active', provenance: { sourceRef: 'test source', verifiedAt: '2026-01-01', status: 'verified' }, executionScope: { kind: 'empty-callback-data-v1', bytesArgIndex } } as DefiFunctionPolicy;
    });
    const localCatalog: DefiChainPolicy[] = [{ chainId: 1, status: 'active', contracts: [{ address: target, status: 'active', functions }] }];
    const localManifest = buildReviewedManifest([{ chains: localCatalog }]);
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    const service = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(localCatalog, prisma as never, localManifest));
    const ctx = { ...context, allowedCapabilityIds: functions.map((fn) => fn.capabilityId) };
    const argumentsByFunction: unknown[][] = [
      ['0x3333333333333333333333333333333333333333', '0x4444444444444444444444444444444444444444', 2n ** 255n, owner, '0x'],
      ['0x4444444444444444444444444444444444444444', 2n ** 255n, owner, '0x'],
      ['0x3333333333333333333333333333333333333333', 2n ** 255n, 2n ** 255n, owner, '0x'],
    ];
    for (let index = 0; index < functions.length; index++) {
      const fn = functions[index];
      const empty = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: argumentsByFunction[index] } as never);
      await expect(service.authorizeContractCalls([{ to: target, data: empty }], ctx)).resolves.toMatchObject({ executionPlan: [{ path: [0] }] });
      const badArgs = [...argumentsByFunction[index]];
      badArgs[badArgs.length - 1] = '0x00';
      const nonempty = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: badArgs } as never);
      await expect(service.authorizeContractCalls([{ to: target, data: nonempty }], ctx)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
    }
  });

  it('enforces nonpayable native value on all six production Morpho callback-free methods at initial and final authorization', async () => {
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
    const service = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST));
    const marketParams = { loanToken: owner, collateralToken: target, oracle: owner, irm: target, lltv: 2n ** 255n };
    const maximumCallerSelectedAmount = 2n ** 255n;

    for (const chainId of [1, 8453]) {
      const chain = PRODUCTION_DEFI_CATALOG.find((entry) => entry.chainId === chainId)!;
      const contract = chain.contracts.find((entry) => entry.address.toLowerCase() === '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb')!;
      const functions = contract.functions.filter((fn) => fn.executionScope?.kind === 'empty-callback-data-v1');
      expect(functions.map((fn) => fn.functionName).sort()).toEqual(['repay', 'supply', 'supplyCollateral']);
      const ctx: DefiExecutionContext = { ...context, chainId, allowedCapabilityIds: functions.map((fn) => fn.capabilityId) };
      for (const fn of functions) {
        const args = fn.functionName === 'supplyCollateral'
          ? [marketParams, maximumCallerSelectedAmount, owner, '0x']
          : fn.functionName === 'supply'
            ? [marketParams, maximumCallerSelectedAmount, maximumCallerSelectedAmount, owner, '0x']
            : [marketParams, maximumCallerSelectedAmount, maximumCallerSelectedAmount, owner, '0x'];
        const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args } as never);
        const call = { to: contract.address, data };

        await expect(service.authorizeContractCalls([call], ctx)).resolves.toMatchObject({ executionPlan: [{ path: [0] }] });
        await expect(service.authorizeContractCalls([{ ...call, value: '0' }], ctx)).resolves.toMatchObject({ executionPlan: [{ path: [0] }] });
        await expect(service.authorizeContractCalls([{ ...call, value: '1' }], ctx)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
        const nonempty = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: [...args.slice(0, -1), '0x00'] } as never);
        await expect(service.authorizeContractCalls([{ to: contract.address, data: nonempty }], ctx)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });

        if (fn.functionName === 'supply') {
          const authorization = await service.authorizeContractCalls([call], ctx);
          const forgedInteractions = [{ ...authorization.interactions[0], value: '1' }];
          const forged = {
            ...authorization,
            interactions: forgedInteractions,
            requestCommitment: buildDefiRequestCommitment(forgedInteractions, authorization.context, authorization.manifestHash),
          };
          const tx = mockTx(ctx.allowedCapabilityIds);
          await expect(service.assertStillAuthorized(tx as never, forged as never)).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
        }
      }
    }
  });
});
