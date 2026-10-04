import type { DefiFunctionPolicy } from '../defi.types';
import { capabilityBundleFingerprint, DefiBundleService } from './bundle.service';
import type { DefiCapabilityBundle } from './types';
import { PRODUCTION_DEFI_CAPABILITY_BUNDLES } from './production-bundles';
import { buildEnsoRegistry } from '../registry/enso';
import { ENSO_STATIC_WEIROLL_ROOT_IDENTITY } from '../execution/enso-identity';
import { SDAI_SAVINGS_CAPABILITIES } from '../registry/sdai-savings';

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
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES).toHaveLength(69);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(0, 12)).toHaveLength(12);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(12, 33)).toHaveLength(21);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(33, 62)).toHaveLength(29);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(62, 67)).toHaveLength(5);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(67, 69)).toHaveLength(2);
    const service = new DefiBundleService([], catalog([]));
    await expect(service.listMetadata()).resolves.toMatchObject({ schemaVersion: 1, maxGrants: 100, bundles: [] });
  });

  it('accepts the five exact phase3 profile selections against isolated source-builder identities', () => {
    const capabilities = [
      ...require('../registry/one-inch').ONE_INCH_CAPABILITIES,
      ...require('../registry/zero-x').ZERO_X_CAPABILITIES,
      ...require('../registry/velora').VELORA_CAPABILITIES,
      ...require('../registry/bebop').BEBOP_CAPABILITIES,
      ...require('../registry/open-ocean').OPEN_OCEAN_CAPABILITIES,
    ] as DefiFunctionPolicy[];
    const profiles = PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(62, 67);
    expect(capabilities).toHaveLength(28);
    expect(profiles.flatMap((profile) => profile.capabilityIds)).toHaveLength(28);
    expect(new Set(profiles.flatMap((profile) => profile.capabilityIds)).size).toBe(28);
    expect(profiles.map((profile) => profile.fingerprint)).toEqual(profiles.map((profile) => capabilityBundleFingerprint(profile, capabilities)));
    expect(() => new DefiBundleService(profiles, catalog(capabilities))).not.toThrow();
    expect(profiles.every((profile) => profile.capabilityIds.every((id) => !id.includes(':approve')))).toBe(true);
    for (const profile of profiles) {
      expect(profile.warnings.join(' ')).toMatch(/no platform amount, recipient, asset-pair or feed caps apply/i);
      expect(profile.warnings.join(' ')).toMatch(/approval.*independent/i);
      expect(profile.warnings.join(' ')).toMatch(/not .*paired|not paired|neither .*paired/i);
    }
    expect(profiles[0].capabilityIds).toHaveLength(12);
    expect(profiles[0].capabilityIds.length).toBeLessThanOrEqual(100);
    expect(profiles[0].warnings.join(' ')).toMatch(/ten decoded execution nodes per request/);
    expect(profiles[0].warnings.join(' ')).toMatch(/V3 canonical factory\/pool checks apply only.*external-payer callback branch/i);
    expect(profiles[0].warnings.join(' ')).toMatch(/Curve\/router-balance callbacks assume no stranded router funds/i);
    expect(profiles[1].warnings.join(' ')).toMatch(/RFQ txOrigin eligibility.*not a platform-owner restriction/i);
    expect(profiles[1].warnings.join(' ')).toMatch(/historical Native Orders facet.*not a current facet\/runtime identity/i);
    expect(profiles[2].warnings.join(' ')).toMatch(/WithTarget.*bounded selection, not a restriction imposed by the platform/i);
    const bebopWarnings = profiles[3].warnings.join(' ');
    expect(bebopWarnings).toMatch(/One fixed BOP AMM swapWithAllowance entrypoint only/i);
    expect(bebopWarnings).toMatch(/fallback and fixed core callback entrypoints, other Bebop RFQ\/routing products, and arbitrary caller-selected hook selectors are excluded from granted authority/i);
    expect(bebopWarnings).toMatch(/Pricing-selected maker\/fee hooks may still be invoked by the fixed router path/i);
    expect(bebopWarnings).toMatch(/remain protocol execution\/trust dependencies/i);
    expect(profiles[4].warnings.join(' ')).toMatch(/opaque makeCalls.*excluded/i);
    expect(profiles[4].warnings.join(' ')).toMatch(/returnAmount may differ from net recipient proceeds/i);
    expect(profiles[4].warnings.join(' ')).toMatch(/whenNotPaused guards.*platform pause remains an independent policy overlay/i);
  });

  it('validates and serves the single Enso root profile against its isolated candidate identity without child membership', async () => {
    const root = buildEnsoRegistry().chains[0].contracts[0].functions[0];
    const profile = PRODUCTION_DEFI_CAPABILITY_BUNDLES[67];
    expect(profile.bundleId).toBe('enso-static-weiroll-root-v1');
    expect(profile.capabilityIds).toEqual([ENSO_STATIC_WEIROLL_ROOT_IDENTITY.capabilityId]);
    expect(root.capabilityId).toBe(ENSO_STATIC_WEIROLL_ROOT_IDENTITY.capabilityId);
    expect(profile.fingerprint).toBe(capabilityBundleFingerprint(profile, [root]));
    const service = new DefiBundleService([profile], catalog([root]));
    await expect(service.listMetadata()).resolves.toMatchObject({
      schemaVersion: 1,
      maxGrants: 100,
      bundles: [{ bundleId: profile.bundleId, version: '1.0.0', capabilityIds: [root.capabilityId], available: true, unavailableCapabilityIds: [] }],
    });
    expect(profile.capabilityIds).toHaveLength(1);
    expect(profile.capabilityIds.some((id) => id.includes(':approve'))).toBe(false);
  });

  it('validates and serves the four-member sDAI profile against its isolated declared-ABI fixture', async () => {
    const profile = PRODUCTION_DEFI_CAPABILITY_BUNDLES[68];
    expect(profile.bundleId).toBe('sdai-savings-no-referral-v1');
    expect(profile.version).toBe('1.0.0');
    expect(profile.chainIds).toEqual([1]);
    expect(profile.capabilityIds).toEqual(SDAI_SAVINGS_CAPABILITIES.map((fn) => fn.capabilityId).sort());
    expect(profile.capabilityIds).toHaveLength(4);
    expect(profile.capabilityIds.some((id) => id.includes(':approve'))).toBe(false);
    expect(profile.fingerprint).toBe(capabilityBundleFingerprint(profile, SDAI_SAVINGS_CAPABILITIES));
    const service = new DefiBundleService([profile], catalog(SDAI_SAVINGS_CAPABILITIES));
    await expect(service.listMetadata()).resolves.toMatchObject({
      schemaVersion: 1,
      maxGrants: 100,
      bundles: [{ bundleId: profile.bundleId, version: profile.version, capabilityIds: profile.capabilityIds, available: true, unavailableCapabilityIds: [] }],
    });
  });
});
