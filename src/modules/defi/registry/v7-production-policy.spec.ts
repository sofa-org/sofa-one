import { encodeFunctionData } from 'viem';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST } from './production-registry';
import { buildReviewedManifest } from './defi-manifest';
import { loadCurrentProductionExpectations } from './__fixtures__/current-production-expectations';
import { V7_SOURCE_IDENTITIES } from '../catalog-tooling/v7-identities';
import { ENSO_STATIC_WEIROLL_ROOT_IDENTITY } from '../execution/enso-identity';

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
    userId: 'v7-policy-test', apiKeyId, walletId: 'wallet', chainId: fn.chainId,
    executionMode: 'session_key' as const, executionOwner: owner, allowedCapabilityIds: grants,
  });
  const transaction = (grants: readonly string[]) => ({
    $queryRaw: jest.fn().mockResolvedValue([]),
    defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) },
    apiKey: { findUnique: jest.fn().mockResolvedValue({ userId: 'v7-policy-test', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: [...grants] }) },
  });
  return { policy, context, transaction };
}

describe('v7 and v8 historical bindings in current v9 production policy', () => {
  const additions = V7_SOURCE_IDENTITIES.map((identity) => PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.capabilityId === identity.capabilityId)!).sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));

  it('keeps all 28 v7 bindings in current policy and projects exact v8/v7 historical baselines', async () => {
    expect(additions).toHaveLength(28);
    expect(additions.every((fn) => fn?.status === 'active' && fn.provenance.status === 'verified' && !fn.executionScope)).toBe(true);
    const currentCapabilities = PRODUCTION_DEFI_MANIFEST.capabilities;
    const expected = loadCurrentProductionExpectations(process.cwd());
    const historicalV8Projection = buildReviewedManifest([JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v8/catalog.json'), 'utf8'))]).capabilities;
    expect(currentCapabilities).toHaveLength(expected.definitions);
    expect(historicalV8Projection).toHaveLength(669);
    expect(currentCapabilities.filter((fn) => fn.type === 'contract_call' && fn.functionName !== 'approve')).toHaveLength(expected.actions);
    expect(currentCapabilities.filter((fn) => fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).toHaveLength(expected.approvals);
    expect(currentCapabilities.filter((fn) => fn.executionScope)).toHaveLength(expected.capabilities.filter((fn) => fn.executionScope).length);
    for (const old of historicalV8Projection) expect(currentCapabilities.find((fn) => fn.capabilityId === old.capabilityId)).toEqual(old);
    const v7Baseline = buildReviewedManifest([JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v7/catalog.json'), 'utf8'))]).capabilities;
    expect(currentCapabilities.filter((fn) => fn.capabilityId === ENSO_STATIC_WEIROLL_ROOT_IDENTITY.capabilityId)).toHaveLength(1);
    expect(v7Baseline).toHaveLength(668);
    expect(v7Baseline.filter((fn) => fn.type === 'contract_call' && fn.functionName !== 'approve')).toHaveLength(645);
    expect(v7Baseline.filter((fn) => fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).toHaveLength(23);
    expect(v7Baseline.filter((fn) => fn.executionScope)).toHaveLength(15);
    expect(historicalV8Projection.filter((fn) => fn.type === 'contract_call' && fn.functionName !== 'approve')).toHaveLength(646);
    expect(historicalV8Projection.filter((fn) => fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).toHaveLength(23);
    const { policy, context, transaction } = fixture();
    for (const fn of additions) {
      for (const edge of ['max', 'zero'] as const) {
        const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: (fn.abi.inputs as readonly Param[]).map((parameter) => arg(parameter, edge)) as never });
        const value = fn.abi.stateMutability === 'payable' && edge === 'max' ? ((1n << 256n) - 1n).toString() : '0';
        const interaction = { to: fn.contract, data, value };
        const authorization = await policy.authorizeContractCalls([interaction], context(fn));
        expect(authorization.matches).toEqual([expect.objectContaining({ capabilityId: fn.capabilityId, functionSignature: fn.signature })]);
        const tx = transaction([fn.capabilityId]);
        await expect(policy.assertStillAuthorized(tx as never, authorization)).resolves.toBeUndefined();
        const lockQueries = tx.$queryRaw.mock.calls.map(([query]) => query.join(''));
        expect(lockQueries).toHaveLength(2);
        expect(lockQueries[0]).toContain("SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE");
        expect(lockQueries[1]).toContain('SELECT id FROM api_keys WHERE id = ');
        expect(lockQueries[1]).toContain('FOR UPDATE');
      }
    }
  });

  it('denies missing or unrelated grants, wrong chain/target/selector, malformed calldata, excess bytes, and invalid native value', async () => {
    const { policy, context } = fixture();
    for (const fn of additions) {
      const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: (fn.abi.inputs as readonly Param[]).map((parameter) => arg(parameter, 'zero')) as never });
      const interaction = { to: fn.contract, data };
      const unrelatedId = additions.find((candidate) => candidate.capabilityId !== fn.capabilityId)!.capabilityId;
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

  it('rechecks grants, key state, pauses, call data, target, value, and commitment at final authorization', async () => {
    const { policy, context, transaction } = fixture();
    for (const fn of additions) {
      const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: (fn.abi.inputs as readonly Param[]).map((parameter) => arg(parameter, 'zero')) as never });
      const interaction = { to: fn.contract, data, value: '0' };
      const authorization = await policy.authorizeContractCalls([interaction], context(fn));
      await expect(policy.assertStillAuthorized(transaction([]) as never, authorization)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      const revoked = transaction([fn.capabilityId]); revoked.apiKey.findUnique.mockResolvedValue({ userId: 'v7-policy-test', revoked: true, frozenAt: null, expiresAt: null, canSendTransaction: true, allowedCapabilityIds: [fn.capabilityId] });
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
});
