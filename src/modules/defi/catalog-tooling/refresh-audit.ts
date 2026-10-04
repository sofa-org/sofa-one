import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateCatalogDocument } from './catalog-generator';
import { executionScopeHash } from '../execution/scope';
import type { DefiFunctionPolicy } from '../defi.types';
import type { DefiCapabilityBundle } from '../bundles/types';
import { buildReviewedManifest, functionAbiHash } from '../registry/defi-manifest';

const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const V3_PROFILE_FIXTURE = 'src/modules/defi/catalog-tooling/__fixtures__/v3-bundle-baseline.json';
const V3_PROFILE_SOURCE_HASH = '8655bc24a6ce3f9605716e718c7bb30750c6531a0d8091f2d8762b457eab05d9';

export function loadReviewedV3ProfileBaseline(): readonly DefiCapabilityBundle[] {
  const fixture = JSON.parse(readFileSync(resolve(process.cwd(), V3_PROFILE_FIXTURE), 'utf8')) as Record<string, unknown>;
  const provenance = fixture.provenance as Record<string, unknown> | undefined;
  if (Object.keys(fixture).sort(cmp).join(',') !== 'profiles,provenance,schemaVersion'
    || fixture.schemaVersion !== 1 || !provenance || Object.keys(provenance).sort(cmp).join(',') !== 'gitCommit,path,sourceBytesSha256'
    || provenance.gitCommit !== 'e453acde073554d31d4e1ceb46f429c2191e1dfa'
    || provenance.path !== 'src/modules/defi/bundles/production-bundles.ts'
    || provenance.sourceBytesSha256 !== V3_PROFILE_SOURCE_HASH || !Array.isArray(fixture.profiles)
    || fixture.profiles.length !== 9) throw new Error('Immutable v3 profile baseline fixture provenance is invalid');
  const profiles = fixture.profiles as DefiCapabilityBundle[];
  if (profiles.reduce((sum, profile) => sum + profile.capabilityIds.length, 0) !== 75
    || new Set(profiles.flatMap((profile) => profile.capabilityIds)).size !== 75
    || profiles.some((profile) => profile.version !== '1.0.0')) throw new Error('Immutable v3 profile baseline membership is incomplete');
  return profiles;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort(cmp).map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function capabilities(document: unknown): DefiFunctionPolicy[] {
  const fragment = validateCatalogDocument(document);
  return buildReviewedManifest([fragment]).capabilities as DefiFunctionPolicy[];
}

function identity(fn: DefiFunctionPolicy): Record<string, unknown> {
  return {
    type: fn.type,
    chainId: fn.chainId,
    contract: fn.contract.toLowerCase(),
    functionName: fn.functionName,
    signature: fn.signature,
    abiHash: functionAbiHash(fn),
    status: fn.status,
    ...(fn.executionScope ? { executionScopeHash: executionScopeHash(fn.executionScope) } : {}),
  };
}

function metadata(fn: DefiFunctionPolicy): Record<string, unknown> {
  const { capabilityId: _id, type: _type, chainId: _chain, contract: _contract, functionName: _name,
    signature: _signature, abi: _abi, abiHash: _hash, status: _status, executionScope: _scope, ...copy } = fn;
  return copy;
}

function sourceEvidenceChanged(a: DefiFunctionPolicy, b: DefiFunctionPolicy): boolean {
  return a.provenance.sourceRef !== b.provenance.sourceRef || a.provenance.status !== b.provenance.status;
}

export function computeRefreshProfileFingerprint(bundle: Pick<DefiCapabilityBundle, 'bundleId' | 'version' | 'capabilityIds'>, fns: readonly DefiFunctionPolicy[]): string {
  const byId = new Map(fns.map((fn) => [fn.capabilityId, fn]));
  const members = [...bundle.capabilityIds].sort(cmp).map((id) => {
    const fn = byId.get(id);
    if (!fn) throw new Error(`Unknown profile member ${id}`);
    return {
      capabilityId: id,
      type: fn.type,
      chainId: fn.chainId,
      contract: fn.contract.toLowerCase(),
      signature: fn.signature,
      abiHash: functionAbiHash(fn),
      ...(fn.executionScope ? { executionScopeHash: executionScopeHash(fn.executionScope) } : {}),
    };
  });
  return `sha256:${createHash('sha256').update(canonical({ bundleId: bundle.bundleId, version: bundle.version, members })).digest('hex')}`;
}

function validateProfiles(profiles: readonly DefiCapabilityBundle[], fns: readonly DefiFunctionPolicy[]): void {
  const versions = new Set<string>();
  for (const profile of profiles) {
    if (!profile || Object.keys(profile).sort(cmp).join(',') !== 'bundleId,capabilityIds,chainIds,fingerprint,label,limitations,version,warnings'
      || typeof profile.bundleId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,79}$/.test(profile.bundleId)
      || typeof profile.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(profile.version)
      || typeof profile.label !== 'string' || !profile.label.trim() || profile.label.length > 120 || profile.label.trim() !== profile.label
      || !Array.isArray(profile.chainIds) || !profile.chainIds.length || profile.chainIds.length > 7
      || !Array.isArray(profile.capabilityIds) || !profile.capabilityIds.length
      || !Array.isArray(profile.warnings) || profile.warnings.length > 16 || !Array.isArray(profile.limitations) || profile.limitations.length > 16
      || [...profile.warnings, ...profile.limitations].some((text) => typeof text !== 'string' || !text.trim() || text.trim() !== text || text.length > 500)
      || typeof profile.fingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(profile.fingerprint)
      || new Set(profile.capabilityIds).size !== profile.capabilityIds.length
      || profile.capabilityIds.length > 100
      || profile.chainIds.some((id, i) => !Number.isSafeInteger(id) || id <= 0 || (i > 0 && profile.chainIds[i - 1] >= id))
      || profile.capabilityIds.some((id, i) => typeof id !== 'string' || !id.trim() || id.length > 160 || (i > 0 && cmp(profile.capabilityIds[i - 1], id) >= 0))) {
      throw new Error('Malformed versioned profile or non-canonical membership');
    }
    const key = `${profile.bundleId}\u0000${profile.version}`;
    if (versions.has(key)) throw new Error(`Duplicate profile version ${profile.bundleId}@${profile.version}`);
    versions.add(key);
    const members = profile.capabilityIds.map((id) => {
      const fn = fns.find((candidate) => candidate.capabilityId === id);
      if (!fn || fn.provenance.status !== 'verified' || fn.type !== 'contract_call') throw new Error(`Profile member is unknown or not verified fixed-ABI authority: ${id}`);
      return fn;
    });
    const chains = [...new Set(members.map((fn) => fn.chainId))].sort((a, b) => a - b);
    if (canonical(chains) !== canonical(profile.chainIds)) throw new Error(`Profile chain inventory mismatch: ${profile.bundleId}@${profile.version}`);
    if (computeRefreshProfileFingerprint(profile, fns) !== profile.fingerprint) throw new Error(`Profile fingerprint mismatch: ${profile.bundleId}@${profile.version}`);
  }
}

export type RefreshAuditResult = Readonly<{
  status: 'VALID_NO_CHANGE' | 'REVIEW_REQUIRED' | 'BLOCKED';
  current: Readonly<{ definitions: number; active: number; scoped: number; manifestHash: string }>;
  proposed: Readonly<{ definitions: number; active: number; scoped: number; manifestHash: string }>;
  changes: Readonly<{
    addedIds: readonly string[];
    removedIds: readonly string[];
    inactivatedIds: readonly string[];
    sameIdAuthorityChanged: readonly string[];
    sourceEvidenceChanged: readonly string[];
    metadataChanged: readonly string[];
    executableIdentityReusedUnderNewId: readonly Readonly<{ oldId: string; newId: string }>[];
  }>;
  profiles: Readonly<{ validated: number; review: readonly string[] }>;
  decisions: readonly string[];
}>;

/** Pure offline comparison. It classifies changes; it never writes catalogs or grants. */
export function auditCatalogRefresh(
  currentDocument: unknown,
  proposedDocument: unknown,
  options: Readonly<{ currentProfiles?: readonly DefiCapabilityBundle[]; proposedProfiles?: readonly DefiCapabilityBundle[] }> = {},
): RefreshAuditResult {
  const current = capabilities(currentDocument);
  const proposed = capabilities(proposedDocument);
  const oldById = new Map(current.map((fn) => [fn.capabilityId, fn]));
  const newById = new Map(proposed.map((fn) => [fn.capabilityId, fn]));
  const addedIds = [...newById.keys()].filter((id) => !oldById.has(id)).sort(cmp);
  const removedIds = [...oldById.keys()].filter((id) => !newById.has(id)).sort(cmp);
  const sameIdAuthorityChanged: string[] = [];
  const inactivatedIds: string[] = [];
  const sourceChanged: string[] = [];
  const metadataChanged: string[] = [];
  for (const [id, oldFn] of oldById) {
    const next = newById.get(id);
    if (!next) continue;
    if (oldFn.status === 'active' && next.status === 'inactive') inactivatedIds.push(id);
    if (canonical(identity(oldFn)) !== canonical(identity(next))) sameIdAuthorityChanged.push(id);
    else {
      if (sourceEvidenceChanged(oldFn, next)) sourceChanged.push(id);
      if (canonical(metadata(oldFn)) !== canonical(metadata(next)) || oldFn.provenance.verifiedAt !== next.provenance.verifiedAt) metadataChanged.push(id);
    }
  }
  const oldIdentities = new Map(current.map((fn) => [canonical(identity(fn)), fn.capabilityId]));
  const executableIdentityReusedUnderNewId = addedIds.flatMap((newId) => {
    const oldId = oldIdentities.get(canonical(identity(newById.get(newId)!)));
    return oldId ? [{ oldId, newId }] : [];
  }).sort((a, b) => cmp(a.oldId, b.oldId) || cmp(a.newId, b.newId));
  const decisions: string[] = [];
  const profileReview: string[] = [];
  const baselineProfiles = loadReviewedV3ProfileBaseline();
  const currentProfileOverlap = baselineProfiles.some((profile) => profile.capabilityIds.some((id) => oldById.has(id)));
  const currentProfiles = options.currentProfiles ?? (currentProfileOverlap ? baselineProfiles : []);
  validateProfiles(currentProfiles, current);
  const proposedProfileOverlap = baselineProfiles.some((profile) => profile.capabilityIds.some((id) => newById.has(id)));
  const proposedProfiles = options.proposedProfiles ?? (proposedProfileOverlap ? baselineProfiles : []);
  validateProfiles(proposedProfiles, proposed);
  const previousByVersion = new Map(currentProfiles.map((p) => [`${p.bundleId}\u0000${p.version}`, p]));
  for (const next of proposedProfiles) {
    const old = previousByVersion.get(`${next.bundleId}\u0000${next.version}`);
    if (old && (canonical([...old.capabilityIds].sort(cmp)) !== canonical([...next.capabilityIds].sort(cmp))
      || computeRefreshProfileFingerprint(old, current) !== computeRefreshProfileFingerprint(next, proposed))) {
      throw new Error(`Published profile version changed authority membership; publish a new version: ${next.bundleId}@${next.version}`);
    }
    if (!old) profileReview.push(`${next.bundleId}@${next.version}: new profile version requires explicit review; it never grants automatically`);
  }
  const proposedVersions = new Set(proposedProfiles.map((p) => `${p.bundleId}\u0000${p.version}`));
  for (const old of currentProfiles) if (!proposedVersions.has(`${old.bundleId}\u0000${old.version}`)) profileReview.push(`${old.bundleId}@${old.version}: removal requires explicit review; existing grants are not migrated`);

  if (sameIdAuthorityChanged.length) decisions.push('BLOCK: existing capability IDs changed executable authority; assign new IDs and obtain explicit source admission/review.');
  if (removedIds.length) decisions.push('REVIEW_REQUIRED: removed IDs may remain in saved key grants; do not alias, rewrite, or revoke them automatically.');
  if (inactivatedIds.length) decisions.push('REVIEW_REQUIRED: inactivated IDs may remain in saved key grants; do not remove or alias them automatically.');
  if (addedIds.length) decisions.push('REVIEW_REQUIRED: additions require explicit source/admission and baseline review; new IDs inherit no saved grants.');
  if (executableIdentityReusedUnderNewId.length) decisions.push('REVIEW_REQUIRED: executable identity appears under replacement IDs; preserve old grants as unknown and do not alias them.');
  if (profileReview.length) decisions.push('REVIEW_REQUIRED: profile membership/version changes require explicit republication and user preview.');
  if (metadataChanged.length) decisions.push('INFO: metadata/provenance-copy-only changes do not alter executable authority.');
  const blocked = sameIdAuthorityChanged.length > 0;
  const review = addedIds.length > 0 || removedIds.length > 0 || inactivatedIds.length > 0 || executableIdentityReusedUnderNewId.length > 0 || profileReview.length > 0;
  return {
    status: blocked ? 'BLOCKED' : review ? 'REVIEW_REQUIRED' : 'VALID_NO_CHANGE',
    current: summary(current), proposed: summary(proposed),
    changes: { addedIds, removedIds, inactivatedIds: inactivatedIds.sort(cmp), sameIdAuthorityChanged: sameIdAuthorityChanged.sort(cmp), sourceEvidenceChanged: sourceChanged.sort(cmp), metadataChanged: metadataChanged.sort(cmp), executableIdentityReusedUnderNewId },
    profiles: { validated: proposedProfiles.length, review: profileReview.sort(cmp) },
    decisions,
  };
}

function summary(fns: readonly DefiFunctionPolicy[]) {
  const manifest = buildReviewedManifest([{ chains: groupCapabilities(fns) }]);
  return { definitions: fns.length, active: fns.filter((fn) => fn.status === 'active').length, scoped: fns.filter((fn) => fn.executionScope).length, manifestHash: manifest.manifestHash };
}

function groupCapabilities(fns: readonly DefiFunctionPolicy[]) {
  const chains = new Map<number, Map<string, DefiFunctionPolicy[]>>();
  for (const fn of fns) {
    const contracts = chains.get(fn.chainId) ?? new Map<string, DefiFunctionPolicy[]>();
    const key = fn.contract.toLowerCase();
    contracts.set(key, [...(contracts.get(key) ?? []), fn]);
    chains.set(fn.chainId, contracts);
  }
  return [...chains.entries()].sort(([a], [b]) => a - b).map(([chainId, contracts]) => ({ chainId, status: 'active' as const, contracts: [...contracts.entries()].map(([address, functions]) => ({ address, status: 'active' as const, functions })) }));
}
