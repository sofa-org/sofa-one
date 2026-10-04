import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DefiCapabilityBundle } from '../bundles/types';
import type { DefiFunctionPolicy } from '../defi.types';
import { auditCatalogRefresh, computeRefreshProfileFingerprint, loadReviewedV3ProfileBaseline } from './refresh-audit';
import { assembleCatalogFromSources } from './catalog-generator';

const V3_PROFILES = loadReviewedV3ProfileBaseline();

const ADDRESS = '0x1111111111111111111111111111111111111111';

function fn(overrides: Record<string, unknown> = {}) {
  const name = (overrides.functionName as string | undefined) ?? 'ping';
  return {
    capabilityId: 'fixture:ping', type: 'contract_call', chainId: 1, contract: ADDRESS,
    functionName: name, signature: `${name}()`, abi: { type: 'function', name, stateMutability: 'view', inputs: [], outputs: [] },
    status: 'active', provenance: { sourceRef: 'https://example.invalid/source', verifiedAt: '2026-01-01', status: 'verified' },
    label: 'Ping', description: 'Fixture', warnings: [], ...overrides,
  };
}

function document(functions: Record<string, unknown>[], status: 'active' | 'inactive' = 'active') {
  return { schemaVersion: 1, chains: [{ chainId: 1, status, contracts: [{ address: ADDRESS, status, functions }] }] };
}

function realV3(): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v3/catalog.json'), 'utf8')) as unknown;
}

function realV2(): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v2/catalog.json'), 'utf8')) as unknown;
}

describe('offline catalog refresh audit', () => {
  it('validates the actual frozen v3 catalog and all nine literal profiles as a no-op', () => {
    const catalog = realV3();
    const result = auditCatalogRefresh(catalog, catalog);
    expect(result.status).toBe('VALID_NO_CHANGE');
    expect(result.current).toMatchObject({ definitions: 349, active: 349, scoped: 13 });
    expect(result.profiles).toMatchObject({ validated: 9, review: [] });
  });

  it('confirms v2-to-v3 is append-only: 34 additions and no change to the preserved 315 IDs', () => {
    const result = auditCatalogRefresh(realV2(), realV3(), { currentProfiles: [], proposedProfiles: V3_PROFILES });
    expect(result.status).toBe('REVIEW_REQUIRED');
    expect(result.current.definitions).toBe(315);
    expect(result.proposed.definitions).toBe(349);
    expect(result.changes.addedIds).toHaveLength(34);
    expect(result.changes.removedIds).toEqual([]);
    expect(result.changes.sameIdAuthorityChanged).toEqual([]);
    expect(result.changes.metadataChanged).toEqual([]);
    expect(result.changes.executableIdentityReusedUnderNewId).toEqual([]);
    expect(result.profiles).toMatchObject({ validated: 9, review: expect.arrayContaining(['uniswap-v3-positions-1@1.0.0: new profile version requires explicit review; it never grants automatically']) });
  });

  it('blocks executable authority reuse under the same ID and classifies a new-ID alias for review', () => {
    const before = document([fn()]);
    const modified = fn({ functionName: 'pong', signature: 'pong()', abi: { type: 'function', name: 'pong', stateMutability: 'view', inputs: [], outputs: [] } });
    const sameId = auditCatalogRefresh(before, document([modified]), { currentProfiles: [], proposedProfiles: [] });
    expect(sameId.status).toBe('BLOCKED');
    expect(sameId.changes.sameIdAuthorityChanged).toEqual(['fixture:ping']);

    const alias = { ...fn(), capabilityId: 'new:explicit-admission' };
    const replacement = auditCatalogRefresh(before, document([alias]), { currentProfiles: [], proposedProfiles: [] });
    expect(replacement.status).toBe('REVIEW_REQUIRED');
    expect(replacement.changes).toMatchObject({ addedIds: ['new:explicit-admission'], removedIds: ['fixture:ping'], executableIdentityReusedUnderNewId: [{ oldId: 'fixture:ping', newId: 'new:explicit-admission' }] });
  });

  it('classifies copy, date, and source-reference changes as non-authority metadata', () => {
    const before = document([fn()]);
    const copy = fn({ label: 'New label', warnings: ['Updated explanatory copy'], provenance: { sourceRef: 'https://example.invalid/source', verifiedAt: '2026-02-01', status: 'verified' } });
    const copyResult = auditCatalogRefresh(before, document([copy]), { currentProfiles: [], proposedProfiles: [] });
    expect(copyResult.status).toBe('VALID_NO_CHANGE');
    expect(copyResult.changes.metadataChanged).toEqual(['fixture:ping']);

    const source = fn({ provenance: { sourceRef: 'https://example.invalid/new-source', verifiedAt: '2026-02-01', status: 'verified' } });
    const sourceResult = auditCatalogRefresh(before, document([source]), { currentProfiles: [], proposedProfiles: [] });
    expect(sourceResult.status).toBe('VALID_NO_CHANGE');
    expect(sourceResult.changes.sourceEvidenceChanged).toEqual(['fixture:ping']);
    expect(sourceResult.changes.metadataChanged).toEqual(['fixture:ping']);
  });

  it('classifies inactivation for review while blocking reuse of its same capability ID', () => {
    const before = document([fn()]);
    const after = document([fn({ status: 'inactive' })], 'inactive');
    const result = auditCatalogRefresh(before, after, { currentProfiles: [], proposedProfiles: [] });
    expect(result.status).toBe('BLOCKED');
    expect(result.changes.inactivatedIds).toEqual(['fixture:ping']);
    expect(result.changes.sameIdAuthorityChanged).toEqual(['fixture:ping']);
    expect(result.decisions.join(' ')).toContain('do not remove or alias them automatically');
  });

  it('requires a new profile version for authority membership changes and allows copy-only edits', () => {
    const catalog = realV3() as { chains: Array<{ contracts: Array<{ functions: Array<{ capabilityId: string; chainId: number; status: string }> }> }> };
    const flat = catalog.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
    const original = V3_PROFILES[0];
    const addedId = flat.find((candidate) => candidate.chainId === original.chainIds[0] && candidate.status === 'active' && !original.capabilityIds.includes(candidate.capabilityId))!.capabilityId;
    const changedMembers = [...original.capabilityIds, addedId].sort();
    const changed = { ...original, capabilityIds: changedMembers } as DefiCapabilityBundle;
    const changedWithFingerprint = { ...changed, fingerprint: computeRefreshProfileFingerprint(changed, flattenPolicies(catalog)) } as DefiCapabilityBundle;
    expect(() => auditCatalogRefresh(catalog, catalog, { proposedProfiles: [changedWithFingerprint, ...V3_PROFILES.slice(1)] })).toThrow(/new version/);

    const copy = { ...original, label: `${original.label} (reviewed)` };
    const copyResult = auditCatalogRefresh(catalog, catalog, { proposedProfiles: [copy, ...V3_PROFILES.slice(1)] });
    expect(copyResult.status).toBe('VALID_NO_CHANGE');

    const newVersion = { ...original, version: '1.0.1' };
    const versioned = { ...newVersion, fingerprint: computeRefreshProfileFingerprint(newVersion, flattenPolicies(catalog)) };
    const versionResult = auditCatalogRefresh(catalog, catalog, { proposedProfiles: [versioned, ...V3_PROFILES.slice(1)] });
    expect(versionResult.status).toBe('REVIEW_REQUIRED');
    expect(versionResult.profiles.review).toContain('uniswap-v3-positions-1@1.0.1: new profile version requires explicit review; it never grants automatically');
  });

  it('rejects forged fingerprints and structurally malformed proposal catalogs', () => {
    const catalog = realV3() as Record<string, unknown>;
    const forged = { ...V3_PROFILES[0], fingerprint: `sha256:${'0'.repeat(64)}` };
    expect(() => auditCatalogRefresh(catalog, catalog, { currentProfiles: [forged, ...V3_PROFILES.slice(1)] })).toThrow(/fingerprint/);
    expect(() => auditCatalogRefresh(document([fn()]), { schemaVersion: 1, chains: [] , ignored: true }, { currentProfiles: [], proposedProfiles: [] })).toThrow();
  });

  it('rejects an execution-scope mutation even when the wrapper ABI is unchanged', () => {
    const current = realV3() as { chains: Array<{ contracts: Array<{ functions: Array<Record<string, unknown>> }> }> };
    const proposed = JSON.parse(JSON.stringify(current)) as typeof current;
    const wrapper = proposed.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions))
      .find((candidate) => candidate.signature === 'multicall(bytes[])')!;
    const scope = wrapper.executionScope as { allowedChildren: Array<{ abiHash: string }> };
    scope.allowedChildren[0].abiHash = `0x${'0'.repeat(64)}`;
    expect(() => auditCatalogRefresh(current, proposed)).toThrow(/execution-scope child binding/);
  });

  it('rejects catalogs that would orphan a literal profile member', () => {
    const current = realV3() as { chains: Array<{ contracts: Array<{ functions: Array<Record<string, unknown>> }> }> };
    const proposed = JSON.parse(JSON.stringify(current)) as typeof current;
    const id = V3_PROFILES.find((profile) => profile.bundleId === 'morpho-blue-1')!.capabilityIds[0];
    for (const chain of proposed.chains) for (const contract of chain.contracts) contract.functions = contract.functions.filter((candidate) => candidate.capabilityId !== id);
    expect(() => auditCatalogRefresh(current, proposed)).toThrow(/unknown or not verified fixed-ABI authority/);
  });

  it('rejects unknown candidate profile members and mismatched chain membership', () => {
    const current = realV3() as { chains: Array<{ chainId: number; contracts: Array<{ address: string; functions: any[] }> }> };
    const sourcePath = 'data/defi-catalog/v4/sources/yearn.json';
    const source = JSON.parse(readFileSync(resolve(process.cwd(), sourcePath), 'utf8')) as unknown;
    const proposedFragment = assembleCatalogFromSources(current as never, [{ sourcePath, document: source }]);
    const proposed = { schemaVersion: 1, chains: proposedFragment.chains };
    const policies = flattenPolicies(proposed);
    const candidateId = policies.find((candidate) => candidate.protocol === 'yearn-tokenized-strategy')!.capabilityId;
    const profile = V3_PROFILES[0];
    const candidateProfile = { ...profile, capabilityIds: [...profile.capabilityIds, candidateId].sort() };
    const candidateWithFingerprint = { ...candidateProfile, fingerprint: computeRefreshProfileFingerprint(candidateProfile, policies) };
    expect(() => auditCatalogRefresh(current, proposed, { currentProfiles: V3_PROFILES, proposedProfiles: [candidateWithFingerprint, ...V3_PROFILES.slice(1)] })).toThrow(/unknown or not verified fixed-ABI authority/);
    const wrongChain = { ...profile, chainIds: [10] };
    expect(() => auditCatalogRefresh(realV3(), realV3(), { currentProfiles: [wrongChain, ...V3_PROFILES.slice(1)], proposedProfiles: V3_PROFILES })).toThrow(/chain inventory mismatch/);
  });

  it('audits the exact six Yearn overload candidates append-only without aliasing old IDs', () => {
    const current = realV3() as { chains: Array<{ chainId: number; status: string; contracts: Array<{ address: string; status: string; functions: any[] }> }> };
    const sourcePath = 'data/defi-catalog/v4/sources/yearn.json';
    const source = JSON.parse(readFileSync(resolve(process.cwd(), sourcePath), 'utf8')) as unknown;
    const proposedFragment = assembleCatalogFromSources(current as never, [{ sourcePath, document: source }]);
    const proposed = { schemaVersion: 1, chains: proposedFragment.chains };
    const result = auditCatalogRefresh(current, proposed, { currentProfiles: V3_PROFILES, proposedProfiles: V3_PROFILES });
    expect(result.current).toMatchObject({ definitions: 349, active: 349, scoped: 13 });
    expect(result.proposed).toMatchObject({ definitions: 355, active: 349, scoped: 13 });
    expect(result.status).toBe('REVIEW_REQUIRED');
    expect(result.changes.addedIds).toHaveLength(6);
    expect(result.changes.addedIds.filter((id) => /:(?:withdraw|redeem):/.test(id))).toHaveLength(0);
    expect(new Set(result.changes.addedIds).size).toBe(6);
    const yearnFns = proposedFragment.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((candidate) => candidate.protocol === 'yearn-tokenized-strategy');
    expect(yearnFns.filter((candidate) => candidate.signature.startsWith('withdraw('))).toHaveLength(2);
    expect(yearnFns.filter((candidate) => candidate.signature.startsWith('redeem('))).toHaveLength(2);
    expect(yearnFns.every((candidate) => candidate.status === 'inactive' && candidate.provenance.status === 'candidate')).toBe(true);
    expect(result.changes.removedIds).toEqual([]);
    expect(result.changes.sameIdAuthorityChanged).toEqual([]);
    expect(result.changes.executableIdentityReusedUnderNewId).toEqual([]);
  });
});

function flattenPolicies(catalog: { chains: readonly { contracts: readonly { functions: readonly Record<string, unknown>[] }[] }[] }) {
  return catalog.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)) as unknown as DefiFunctionPolicy[];
}
