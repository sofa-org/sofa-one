import type { DefiFunctionPolicy } from '../defi.types';
import { capabilityBundleFingerprint, DefiBundleService } from './bundle.service';
import type { DefiCapabilityBundle } from './types';
import { PRODUCTION_DEFI_CAPABILITY_BUNDLES } from './production-bundles';

const addressA = '0x1111111111111111111111111111111111111111';
const addressB = '0x2222222222222222222222222222222222222222';

function capability(overrides: Partial<DefiFunctionPolicy> = {}): DefiFunctionPolicy {
  const base: DefiFunctionPolicy = {
    capabilityId: 'cap:a', type: 'contract_call', chainId: 1, contract: addressA,
    functionName: 'callA', signature: 'callA(uint256)',
    abi: { type: 'function', name: 'callA', stateMutability: 'nonpayable', inputs: [{ name: 'value', type: 'uint256' }], outputs: [] },
    status: 'active', provenance: { status: 'verified', sourceRef: 'official source', verifiedAt: '2026-10-04' },
  };
  const result = { ...base, ...overrides };
  return result;
}

function bundle(capabilities: readonly DefiFunctionPolicy[]): DefiCapabilityBundle {
  const capabilityIds = capabilities.map((row) => row.capabilityId).sort();
  const chainIds = [...new Set(capabilities.map((row) => row.chainId))].sort((a, b) => a - b);
  const definition = { bundleId: 'dex.starter', version: '1.0.0', label: 'DEX starter', chainIds, capabilityIds };
  return { ...definition, fingerprint: capabilityBundleFingerprint(definition, capabilities), warnings: ['Caller-selected ABI arguments remain unrestricted by this profile.'], limitations: ['Not a complete product workflow or deployment inventory.'] };
}

function catalog(capabilities: readonly DefiFunctionPolicy[], statuses: Record<string, string> = {}) {
  return {
    manifest: () => ({ capabilities, manifestHash: '0x' + 'a'.repeat(64) }),
    listMetadata: async () => ({ capabilities: capabilities.map((fn) => ({ capabilityId: fn.capabilityId, status: statuses[fn.capabilityId] ?? fn.status })) }),
  } as any;
}

describe('DefiBundleService', () => {
  it('returns immutable exact membership and current pause-derived availability without changing its fingerprint', async () => {
    const caps = [
      capability(),
      capability({ capabilityId: 'cap:b', chainId: 8453, contract: addressB, functionName: 'callB', signature: 'callB(uint256)', abi: { type: 'function', name: 'callB', stateMutability: 'nonpayable', inputs: [{ name: 'value', type: 'uint256' }], outputs: [] } }),
      capability({ capabilityId: 'cap:c', status: 'inactive', functionName: 'callC', signature: 'callC(uint256)', abi: { type: 'function', name: 'callC', stateMutability: 'nonpayable', inputs: [{ name: 'value', type: 'uint256' }], outputs: [] } }),
    ];
    const definition = bundle(caps);
    const withChangedProvenance = caps.map((fn) => ({ ...fn, provenance: { ...fn.provenance, verifiedAt: '2026-11-01', sourceRef: 'different copy/source note' } }));
    expect(capabilityBundleFingerprint(definition, withChangedProvenance)).toBe(definition.fingerprint);
    const service = new DefiBundleService([definition], catalog(caps, { 'cap:b': 'paused', 'cap:c': 'inactive' }));
    const result = await service.listMetadata();
    expect(result.maxGrants).toBe(100);
    expect(result.bundles[0]).toMatchObject({ capabilityIds: ['cap:a', 'cap:b', 'cap:c'], fingerprint: definition.fingerprint, available: false, unavailableCapabilityIds: ['cap:b', 'cap:c'] });
  });

  it.each([
    ['target', (fn: DefiFunctionPolicy) => ({ ...fn, contract: addressB })],
    ['ABI', (fn: DefiFunctionPolicy) => ({ ...fn, abi: { ...fn.abi, outputs: [{ name: 'result', type: 'uint256' }] } })],
    ['execution scope', (fn: DefiFunctionPolicy) => ({ ...fn, executionScope: { kind: 'empty-callback-data-v1' as const, bytesArgIndex: 0 } })],
  ])('rejects a published fingerprint when %s identity changes', (_name, mutate) => {
    const original = capability();
    const published = bundle([original]);
    expect(() => new DefiBundleService([published], catalog([mutate(original)] as DefiFunctionPolicy[]))).toThrow(/fingerprint mismatch/);
  });

  it('computes fingerprints without mutating membership or execution-scope inputs', () => {
    const scoped = capability({ executionScope: { kind: 'empty-callback-data-v1', bytesArgIndex: 0 } });
    const definition = bundle([scoped]);
    const before = JSON.stringify({ definition, scope: scoped.executionScope });
    expect(capabilityBundleFingerprint(definition, [scoped])).toBe(definition.fingerprint);
    expect(JSON.stringify({ definition, scope: scoped.executionScope })).toBe(before);
  });

  it('rejects an unknown bundle member rather than bypassing chain and fingerprint validation', () => {
    const original = capability();
    const definition = bundle([original]);
    expect(() => new DefiBundleService([definition], catalog([]))).toThrow(/Unknown static DeFi capability bundle member/);
  });

  it('rejects an unknown member even when known-member identity and the supplied fingerprint were also changed', () => {
    const known = capability();
    const alteredKnown = capability({ contract: addressB });
    const original = bundle([known]);
    const tampered = { ...original, capabilityIds: ['cap:a', 'cap:z'] };
    expect(() => new DefiBundleService([tampered], catalog([alteredKnown]))).toThrow(/Unknown static DeFi capability bundle member/);
  });

  it('rejects unreviewed candidate functions and inconsistent chain declarations', () => {
    const active = capability();
    const candidate = capability({ status: 'inactive', provenance: { status: 'candidate', sourceRef: 'candidate source', verifiedAt: '2026-10-04' } });
    expect(() => new DefiBundleService([bundle([candidate])], catalog([candidate]))).toThrow(/not a reviewed fixed-ABI contract call/);
    expect(() => new DefiBundleService([{ ...bundle([active]), chainIds: [8453] }], catalog([active]))).toThrow(/chain inventory/);
  });

  it('fails closed on duplicate members, unsorted IDs, unknown profile fields, or a duplicate bundle version', () => {
    const cap = capability();
    const good = bundle([cap]);
    expect(() => new DefiBundleService([{ ...good, capabilityIds: ['cap:a', 'cap:a'] }], catalog([cap]))).toThrow(/Invalid static/);
    expect(() => new DefiBundleService([{ ...good, capabilityIds: ['cap:z', 'cap:a'] }], catalog([cap]))).toThrow(/Invalid static/);
    expect(() => new DefiBundleService([{ ...good, familySelector: '*' } as any], catalog([cap]))).toThrow(/Invalid static/);
    expect(() => new DefiBundleService([good, good], catalog([cap]))).toThrow(/Duplicate DeFi capability bundle version/);
  });

  it('accepts an explicitly empty injectable bundle list without inventing profiles', async () => {
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES).toHaveLength(33);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(0, 12)).toHaveLength(12);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(12)).toHaveLength(21);
    const service = new DefiBundleService([], catalog([]));
    await expect(service.listMetadata()).resolves.toMatchObject({ schemaVersion: 1, maxGrants: 100, bundles: [] });
  });
});
