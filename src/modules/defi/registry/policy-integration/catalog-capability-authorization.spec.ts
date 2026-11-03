jest.mock('../../../security-events/security-event.module', () => ({ SecurityEventModule: class SecurityEventModule {} }));

import { encodeFunctionData } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST } from '../production-registry';
import { MAX_DEFI_EXECUTION_NODES } from '../../execution/planner';

const USER = '0x4444444444444444444444444444444444444444';
const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER_TARGET = '0x9999999999999999999999999999999999999999';

type AbiParam = { type: string; name?: string; components?: readonly AbiParam[] };
type Candidate = (typeof PRODUCTION_DEFI_MANIFEST.capabilities)[number];

function extremeAbiValue(param: AbiParam): unknown {
  const array = param.type.match(/^(.*)\[(\d*)\]$/);
  if (array) return Array.from({ length: array[2] ? Number(array[2]) : 1 }, () => extremeAbiValue({ ...param, type: array[1] }));
  if (param.type === 'tuple') return Object.fromEntries((param.components ?? []).map((part, index) => [part.name || String(index), extremeAbiValue(part)]));
  if (param.type === 'address') return USER;
  if (param.type === 'bool') return true;
  if (param.type === 'bytes') return '0x';
  if (param.type === 'string') return 'caller-controlled';
  if (param.type.startsWith('bytes')) return `0x${'11'.repeat(Number(param.type.slice(5)))}`;
  if (param.type.startsWith('uint')) {
    const bits = Number(param.type.slice(4)) || 256;
    return (1n << BigInt(bits)) - 1n;
  }
  if (param.type.startsWith('int')) {
    const bits = Number(param.type.slice(3)) || 256;
    return -(1n << BigInt(bits - 1));
  }
  throw new Error(`Unsupported policy-test ABI type ${param.type}`);
}

function callData(fn: Candidate, args = (fn.abi.inputs as readonly AbiParam[]).map(extremeAbiValue)): `0x${string}` {
  return encodeFunctionData({
    abi: [fn.abi],
    functionName: fn.functionName,
    args: args as never,
  });
}

function leafData(fn: Candidate): `0x${string}` {
  // Extreme ABI values are only meaningful when no independent semantic decoder
  // applies. Callback-scoped leaves deliberately exercise the empty-data route.
  if (fn.executionScope && fn.executionScope.kind !== 'empty-callback-data-v1') {
    throw new Error(`Missing scope-aware fixture for ${fn.capabilityId}`);
  }
  return callData(fn);
}

function authorizationCase(fn: Candidate, childOffset = 0) {
  const scope = fn.executionScope;
  if (scope?.kind === 'same-target-financial-multicall-v1') {
    const children = scope.allowedChildren.slice(childOffset, childOffset + MAX_DEFI_EXECUTION_NODES - 1).map((binding) => {
      const child = PRODUCTION_DEFI_MANIFEST.capabilities.find((candidate) => candidate.capabilityId === binding.capabilityId);
      if (!child) throw new Error(`Missing reviewed child ${binding.capabilityId}`);
      return child;
    });
    const planned = [fn, ...children];
    const value = scope.nativeValuePolicy !== 'zero' && planned.every((entry) => entry.abi.stateMutability === 'payable') ? '17' : '0';
    return { data: callData(fn, [children.map(leafData)]), value, planned };
  }
  return { data: leafData(fn), value: fn.abi.stateMutability === 'payable' ? '17' : '0', planned: [fn] };
}

describe('catalog capability authorization', () => {
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST));
  const sourceQualifiedProtocols = new Set(['ajna', 'angle', 'bancor-v3', 'eigenlayer', 'ekubo', 'enzyme', 'ethena', 'exactly', 'frax', 'gearbox-pool', 'harvest', 'hashflow', 'idle', 'integral', 'izumi', 'liquity-v2', 'lista', 'lombard', 'origin', 'puffer', 'sky', 'solv', 'stakedao', 'stakestone', 'swell', 'symbiotic', 'usual']);
  const selected = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => sourceQualifiedProtocols.has(fn.protocol ?? ''));
  const context = (chainId: number, allowedCapabilityIds: string[]) => ({
    userId: 'policy-integration-test',
    apiKeyId: '00000000-0000-4000-8000-000000000006',
    walletId: 'wallet-policy-integration-test',
    chainId,
    executionMode: 'session_key' as const,
    executionOwner: OWNER,
    allowedCapabilityIds,
  });

  // A wrapper's reviewed inventory can exceed one execution's node budget.
  // Exercise every child across valid bounded batches, reserving one node for the root.
  const cases = selected.flatMap((fn) => {
    const count = fn.executionScope?.kind === 'same-target-financial-multicall-v1'
      ? Math.ceil(fn.executionScope.allowedChildren.length / (MAX_DEFI_EXECUTION_NODES - 1)) : 1;
    return Array.from({ length: count }, (_, batch) => [
      `${fn.capabilityId} batch ${batch + 1}`, fn, batch * (MAX_DEFI_EXECUTION_NODES - 1),
    ] as const);
  });
  describe.each(cases)('%s', (_id, fn, childOffset) => {
    it('authorizes canonical scope-valid calldata with independently granted execution nodes', async () => {
      const { data, value, planned } = authorizationCase(fn, childOffset);
      const grants = planned.map((entry) => entry.capabilityId);
      const interaction = { to: fn.contract, data, value };
      const authorization = await policy.authorizeContractCalls([interaction], context(fn.chainId, grants));
      expect(authorization.matches).toMatchObject([{ capabilityId: fn.capabilityId }]);
      expect(authorization.executionPlan.map((node) => node.match.capabilityId)).toEqual(grants);

      await expect(policy.authorizeContractCalls([interaction], context(fn.chainId, [])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      for (const id of grants) {
        await expect(policy.authorizeContractCalls([interaction], context(fn.chainId, grants.filter((grant) => grant !== id))))
          .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED', capabilityId: id } });
      }
      const unrelatedGrant = selected.find((other) => !grants.includes(other.capabilityId))!;
      await expect(policy.authorizeContractCalls([interaction], context(fn.chainId, [unrelatedGrant.capabilityId])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    });

    it('isolates the exact target, chain, selector, canonical calldata and native value', async () => {
      const { data, value, planned } = authorizationCase(fn, childOffset);
      const grants = planned.map((entry) => entry.capabilityId);
      const execution = context(fn.chainId, grants);
      await expect(policy.authorizeContractCalls([{ to: OTHER_TARGET, data, value }], execution))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data, value }], { ...execution, chainId: fn.chainId === 1 ? 10 : 1 }))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data: `0xdeadbeef${data.slice(10)}`, value }], execution))
        .rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data: `${data}00`, value }], execution))
        .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      if (planned.some((entry) => entry.abi.stateMutability !== 'payable') || fn.executionScope?.kind === 'same-target-financial-multicall-v1' && fn.executionScope.nativeValuePolicy === 'zero') {
        await expect(policy.authorizeContractCalls([{ to: fn.contract, data, value: '1' }], execution))
          .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      }
    });
  });

  it.each(selected.filter((fn) => fn.executionScope?.kind === 'empty-callback-data-v1').map((fn) => [fn.capabilityId, fn] as const))(
    '%s rejects callback authority directly and inside every admitting closed batch',
    async (_id, fn) => {
      const scope = fn.executionScope;
      if (scope?.kind !== 'empty-callback-data-v1') throw new Error('Expected callback-scoped fixture');
      const args = (fn.abi.inputs as readonly AbiParam[]).map(extremeAbiValue);
      args[scope.bytesArgIndex] = '0x01';
      const data = callData(fn, args);
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data }], context(fn.chainId, [fn.capabilityId])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      for (const wrapper of selected) {
        if (wrapper.executionScope?.kind !== 'same-target-financial-multicall-v1'
          || !wrapper.executionScope.allowedChildren.some((child) => child.capabilityId === fn.capabilityId)) continue;
        await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: callData(wrapper, [[data]]) }], context(wrapper.chainId, [wrapper.capabilityId, fn.capabilityId])))
          .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      }
    },
  );

  it.each(selected.filter((fn) => fn.executionScope?.kind === 'same-target-financial-multicall-v1').map((fn) => [fn.capabilityId, fn] as const))(
    '%s rejects unreviewed selectors and recursive wrapper calls even with exact grants',
    async (_id, fn) => {
      const { data, planned } = authorizationCase(fn);
      const execution = context(fn.chainId, planned.map((entry) => entry.capabilityId));
      for (const childData of ['0xdeadbeef', data]) {
        await expect(policy.authorizeContractCalls([{ to: fn.contract, data: callData(fn, [[childData]]) }], execution))
          .rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      }
    },
  );
});
