import { encodeFunctionData } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST } from '../production-registry';

const owner = '0x0000000000000000000000000000000000000001';
const apiKeyId = '00000000-0000-4000-8000-000000000001';
type Param = { name?: string; type: string; components?: readonly Param[] };

function arg(parameter: Param, financialEdge: 'max' | 'zero' = 'max'): unknown {
  const array = parameter.type.match(/^(.*)\[(\d*)\]$/);
  if (array) return Array.from({ length: array[2] ? Number(array[2]) : 1 }, () => arg({ ...parameter, type: array[1] }, financialEdge));
  if (parameter.type === 'tuple') return Object.fromEntries((parameter.components ?? []).map((component, index) => [component.name ?? String(index), arg(component, financialEdge)]));
  if (parameter.type === 'address') return owner;
  if (parameter.type === 'bool') return true;
  if (parameter.type === 'string') return 'candidate';
  if (parameter.type === 'bytes') return '0x';
  if (/^bytes\d+$/.test(parameter.type)) return `0x${'00'.repeat(Number(parameter.type.slice(5)))}`;
  if (/^u?int\d*$/.test(parameter.type)) return parameter.type.startsWith('uint') && financialEdge === 'max' ? (1n << BigInt(Number(parameter.type.slice(4) || 256))) - 1n : 0n;
  throw new Error(`Unsupported test ABI parameter ${parameter.type}`);
}

function fixture() {
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const catalog = new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST);
  const policy = new DefiPolicyService(prisma as never, {} as never, catalog);
  const context = (fn: (typeof PRODUCTION_DEFI_MANIFEST.capabilities)[number], grants = [fn.capabilityId]) => ({
    userId: 'policy-integration-test', apiKeyId, walletId: 'wallet', chainId: fn.chainId,
    executionMode: 'session_key' as const, executionOwner: owner, allowedCapabilityIds: grants,
  });
  const transaction = (grants: readonly string[]) => ({
    $queryRaw: jest.fn().mockResolvedValue([]),
    defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) },
    userWallet: { findFirst: jest.fn().mockImplementation(async ({ where }) => ({ id: where.id, userId: where.userId })) },
    apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: 'policy-integration-test', walletId: 'wallet', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: [...grants] }) },
  });
  return { policy, context, transaction };
}

describe('canonical call authorization', () => {
  const ordinaryProtocols = new Set(['bebop', 'one-inch', 'open-ocean', 'velora', 'zero-x']);
  const ordinaryFunctions = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => ordinaryProtocols.has(fn.protocol ?? '') && !fn.executionScope).sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));

  it('authorizes ordinary catalog calls through exact grants, ABI and final rechecks', async () => {
    const { policy, context, transaction } = fixture();
    for (const fn of ordinaryFunctions) {
      for (const edge of ['max', 'zero'] as const) {
        const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: (fn.abi.inputs as readonly Param[]).map((parameter) => arg(parameter, edge)) as never });
        const value = fn.abi.stateMutability === 'payable' && edge === 'max' ? ((1n << 256n) - 1n).toString() : '0';
        const interaction = { to: fn.contract, data, value };
        const authorization = await policy.authorizeContractCalls([interaction], context(fn));
        expect(authorization.matches).toEqual([expect.objectContaining({ capabilityId: fn.capabilityId, functionSignature: fn.signature })]);
        const tx = transaction([fn.capabilityId]);
        await policy.assertStillAuthorized(tx as never, authorization);
      }
    }
  });

  it('denies missing or unrelated grants, wrong chain/target/selector, malformed calldata, excess bytes, and invalid native value', async () => {
    const { policy, context } = fixture();
    for (const fn of ordinaryFunctions) {
      const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: (fn.abi.inputs as readonly Param[]).map((parameter) => arg(parameter, 'zero')) as never });
      const interaction = { to: fn.contract, data };
      const unrelatedId = ordinaryFunctions.find((candidate) => candidate.capabilityId !== fn.capabilityId)!.capabilityId;
      await expect(policy.authorizeContractCalls([interaction], context(fn, []))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([interaction], context(fn, [unrelatedId]))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      await expect(policy.authorizeContractCalls([interaction], { ...context(fn), chainId: 137 })).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...interaction, to: owner }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...interaction, data: '0xdeadbeef' }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ ...interaction, data: `${data}00` }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      await expect(policy.authorizeContractCalls([{ ...interaction, data: data.slice(0, -2) }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      if (fn.abi.stateMutability === 'payable') {
        await expect(policy.authorizeContractCalls([{ ...interaction, value: '-1' }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      } else {
        await expect(policy.authorizeContractCalls([{ ...interaction, value: '1' }], context(fn))).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      }
    }
  });

  it('rechecks grants, key state, pauses, canonical calldata, target, value, plan, and commitment at final authorization', async () => {
    const { policy, context, transaction } = fixture();
    for (const fn of ordinaryFunctions) {
      const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: (fn.abi.inputs as readonly Param[]).map((parameter) => arg(parameter, 'zero')) as never });
      const interaction = { to: fn.contract, data, value: '0' };
      const authorization = await policy.authorizeContractCalls([interaction], context(fn));
      await expect(policy.assertStillAuthorized(transaction([]) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      const revoked = transaction([fn.capabilityId]); revoked.apiKey.findUnique.mockResolvedValue({ userId: 'policy-integration-test', walletId: 'wallet', revoked: true, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: [fn.capabilityId] });
      await expect(policy.assertStillAuthorized(revoked as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
      const paused = transaction([fn.capabilityId]); paused.defiPolicyState.findUnique.mockResolvedValue({ id: 'global', pausedScopeKeys: [`capability:${fn.capabilityId}`] });
      await expect(policy.assertStillAuthorized(paused as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
      for (const altered of [
        { ...authorization, interactions: [{ ...authorization.interactions[0], to: owner }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], data: `${data}00` }] },
        { ...authorization, interactions: [{ ...authorization.interactions[0], value: '1' }] },
        { ...authorization, executionPlan: authorization.executionPlan.map((node, index) => index === 0 ? { ...node, path: [1] } : node) },
        { ...authorization, requestCommitment: `0x${'00'.repeat(32)}` },
      ]) await expect(policy.assertStillAuthorized(transaction([fn.capabilityId]) as never, altered as never)).rejects.toMatchObject({ audit: { code: 'DEFI_POLICY_UNAVAILABLE' } });
    }
  });

  it.each(['deposit', 'mint', 'repay'])('keeps ordinary Revert %s usable and separates its empty-permit overload grant', async (name) => {
    const rootFunctions = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.chainId === 42161 && fn.contract.toLowerCase() === '0x74e6afef5705beb126c6d3bf46f8fad8f3e07825');
    const ordinary = rootFunctions.find((fn) => fn.functionName === name && !fn.executionScope)!;
    const scoped = rootFunctions.find((fn) => fn.functionName === name && fn.executionScope?.kind === 'revert-empty-lending-permit-v1')!;
    const args = name === 'repay' ? [1n, 1n, true] : [1n, owner];
    const { policy, context, transaction } = fixture();
    for (const fn of [ordinary, scoped]) {
      const values = fn === ordinary ? args : [...args, '0x'];
      const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: values as never });
      const authorization = await policy.authorizeContractCalls([{ to: fn.contract, data }], context(fn));
      expect(authorization.executionPlan.map((node) => [node.match.capabilityId, node.match.functionSignature, node.data])).toEqual([[fn.capabilityId, fn.signature, data]]);
      await policy.assertStillAuthorized(transaction([fn.capabilityId]) as never, authorization);
    }
    const scopedData = encodeFunctionData({ abi: [scoped.abi], functionName: scoped.functionName, args: [...args, '0x'] as never });
    await expect(policy.authorizeContractCalls([{ to: scoped.contract, data: scopedData }], context(ordinary))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
  });
});
