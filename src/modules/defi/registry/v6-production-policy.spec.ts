jest.mock('../../security-events/security-event.module', () => ({ SecurityEventModule: class SecurityEventModule {} }));

import { encodeFunctionData, toFunctionSelector } from 'viem';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import { V6_SOURCE_IDENTITIES } from '../catalog-tooling/v6-identities';
import { PRODUCTION_DEFI_CATALOG, PRODUCTION_DEFI_MANIFEST } from './production-registry';

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
  if (param.type === 'bytes') return '0x'; // Opaque ABI data only; no nested-wallet-call interpretation.
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
  throw new Error(`Unsupported v6 policy-test ABI type ${param.type}`);
}

function callData(fn: Candidate): `0x${string}` {
  return encodeFunctionData({
    abi: [fn.abi],
    functionName: fn.functionName,
    args: (fn.abi.inputs as readonly AbiParam[]).map(extremeAbiValue) as never,
  });
}

describe('v6 production policy admission', () => {
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys: [] }) } };
  const policy = new DefiPolicyService(prisma as never, {} as never, new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST));
  const selectedIds = new Set<string>(V6_SOURCE_IDENTITIES.map((identity) => identity.capabilityId));
  const selected = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => selectedIds.has(fn.capabilityId));
  const context = (chainId: number, allowedCapabilityIds: string[]) => ({
    userId: 'v6-policy-test',
    apiKeyId: '00000000-0000-4000-8000-000000000006',
    walletId: 'wallet-v6-policy-test',
    chainId,
    executionMode: 'session_key' as const,
    executionOwner: OWNER,
    allowedCapabilityIds,
  });

  it('exercises all 134 selected active identities through exact grants, canonical ABI, and structural payable policy', async () => {
    expect(selected).toHaveLength(134);
    expect(new Set(selected.map((fn) => fn.capabilityId))).toEqual(selectedIds);
    expect(selected.every((fn) => fn.type === 'contract_call' && fn.status === 'active' && fn.provenance.status === 'verified')).toBe(true);

    for (const fn of selected) {
      const data = callData(fn);
      const value = fn.abi.stateMutability === 'payable' ? '17' : undefined;
      const exactGrant = [fn.capabilityId];
      const grantSnapshot = [...exactGrant];
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(fn.chainId, exactGrant)))
        .resolves.toMatchObject({ matches: [{ capabilityId: fn.capabilityId }] });
      expect(exactGrant).toEqual(grantSnapshot);

      const noGrants: string[] = [];
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(fn.chainId, noGrants)))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
      expect(noGrants).toEqual([]);

      const unrelatedGrant = selected.find((other) => other.capabilityId !== fn.capabilityId)?.capabilityId;
      if (unrelatedGrant) await expect(policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(fn.chainId, [unrelatedGrant])))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });

      await expect(policy.authorizeContractCalls([{ to: OTHER_TARGET, data, ...(value ? { value } : {}) }], context(fn.chainId, exactGrant)))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data, ...(value ? { value } : {}) }], context(fn.chainId === 1 ? 10 : 1, exactGrant)))
        .rejects.toMatchObject({ audit: { code: 'DEFI_CONTRACT_NOT_ALLOWED' } });

      const selector = toFunctionSelector(fn.signature).toLowerCase();
      expect(data.slice(0, 10).toLowerCase()).toBe(selector);
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data: `0xdeadbeef${data.slice(10)}`, ...(value ? { value } : {}) }], context(fn.chainId, exactGrant)))
        .rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data: `${data}00`, ...(value ? { value } : {}) }], context(fn.chainId, exactGrant)))
        .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      if (fn.abi.stateMutability !== 'payable') {
        await expect(policy.authorizeContractCalls([{ to: fn.contract, data, value: '1' }], context(fn.chainId, exactGrant)))
          .rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
      }
    }
  });
});
