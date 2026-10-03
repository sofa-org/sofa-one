import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DefiCatalogService } from '../defi-catalog.service';
import type { DefiFunctionPolicy } from '../defi.types';
import { executionScopeHash } from '../execution/scope';
import { functionAbiHash } from '../registry/defi-manifest';
import { DEFI_CAPABILITY_BUNDLES } from './production-bundles';
import { MAX_CAPABILITY_GRANTS, type DefiCapabilityBundle, type DefiCapabilityBundleMetadata, type DefiCapabilityBundlesResponse } from './types';

const cmp = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const BUNDLE_ID = /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,79}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const HASH = /^sha256:[a-f0-9]{64}$/;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort(cmp).map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Fingerprints bind opaque member IDs to exact executable identity, excluding copy/provenance/status overlays. */
export function capabilityBundleFingerprint(bundle: Pick<DefiCapabilityBundle, 'bundleId' | 'version' | 'capabilityIds'>, capabilities: readonly DefiFunctionPolicy[]): string {
  const byId = new Map(capabilities.map((capability) => [capability.capabilityId, capability]));
  const members = [...bundle.capabilityIds].sort(cmp).map((capabilityId) => {
    const capability = byId.get(capabilityId);
    if (!capability) throw new Error(`Bundle member is not present in the reviewed catalog: ${capabilityId}`);
    return {
      capabilityId,
      type: capability.type,
      chainId: capability.chainId,
      contract: capability.contract.toLowerCase(),
      signature: capability.signature,
      abiHash: functionAbiHash(capability),
      ...(capability.executionScope ? { executionScopeHash: executionScopeHash(capability.executionScope) } : {}),
    };
  });
  return `sha256:${createHash('sha256').update(canonical({ bundleId: bundle.bundleId, version: bundle.version, members })).digest('hex')}`;
}

function validateBundleShape(bundle: DefiCapabilityBundle): void {
  if (!bundle || typeof bundle !== 'object' || Object.keys(bundle).sort(cmp).join(',') !== 'bundleId,capabilityIds,chainIds,fingerprint,label,limitations,version,warnings'
    || typeof bundle.bundleId !== 'string' || !BUNDLE_ID.test(bundle.bundleId) || typeof bundle.version !== 'string' || !VERSION.test(bundle.version)
    || typeof bundle.label !== 'string' || !bundle.label.trim() || bundle.label.length > 120 || bundle.label.trim() !== bundle.label
    || !Array.isArray(bundle.chainIds) || bundle.chainIds.length === 0 || bundle.chainIds.length > 7
    || bundle.chainIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
    || new Set(bundle.chainIds).size !== bundle.chainIds.length || bundle.chainIds.some((id, index) => index > 0 && bundle.chainIds[index - 1] >= id)
    || !Array.isArray(bundle.capabilityIds) || bundle.capabilityIds.length === 0 || bundle.capabilityIds.length > MAX_CAPABILITY_GRANTS
    || bundle.capabilityIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 160 || id.trim() !== id)
    || new Set(bundle.capabilityIds).size !== bundle.capabilityIds.length || bundle.capabilityIds.some((id, index) => index > 0 && cmp(bundle.capabilityIds[index - 1], id) >= 0)
    || !HASH.test(bundle.fingerprint) || !validCopyList(bundle.warnings) || !validCopyList(bundle.limitations)) {
    throw new Error('Invalid static DeFi capability bundle');
  }
}

function validCopyList(values: readonly string[]): boolean {
  return Array.isArray(values) && values.length <= 16 && values.every((value) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 500);
}

@Injectable()
export class DefiBundleService {
  private readonly bundles: readonly DefiCapabilityBundle[];

  constructor(
    @Inject(DEFI_CAPABILITY_BUNDLES) bundleSource: unknown,
    private readonly catalog: DefiCatalogService,
  ) {
    if (!Array.isArray(bundleSource) || bundleSource.length > 100) throw new Error('Invalid static DeFi capability bundle set');
    const bundles = bundleSource as readonly DefiCapabilityBundle[];
    const manifest = catalog.manifest();
    const byId = new Map(manifest.capabilities.map((capability) => [capability.capabilityId, capability]));
    const versions = new Set<string>();
    const frozen: DefiCapabilityBundle[] = [];
    for (const candidate of bundles) {
      validateBundleShape(candidate);
      const versionKey = `${candidate.bundleId}\u0000${candidate.version}`;
      if (versions.has(versionKey)) throw new Error('Duplicate DeFi capability bundle version');
      versions.add(versionKey);
      const members = candidate.capabilityIds.map((id) => {
        const capability = byId.get(id);
        if (!capability) throw new Error(`Unknown static DeFi capability bundle member: ${id}`);
        if (capability.type !== 'contract_call' || capability.provenance.status !== 'verified'
          || typeof capability.signature !== 'string' || !capability.signature.trim()
          || !capability.abi || capability.abi.type !== 'function' || capability.abi.name !== capability.functionName) {
          throw new Error(`Bundle member is not a reviewed fixed-ABI contract call: ${id}`);
        }
        return capability;
      });
      const chains = [...new Set(members.map((capability) => capability.chainId))].sort((a, b) => a - b);
      if (canonical(chains) !== canonical(candidate.chainIds)) throw new Error('Bundle chain inventory does not match exact member identities');
      if (capabilityBundleFingerprint(candidate, manifest.capabilities) !== candidate.fingerprint) throw new Error('DeFi capability bundle fingerprint mismatch');
      frozen.push(Object.freeze({ ...candidate, chainIds: Object.freeze([...candidate.chainIds]), capabilityIds: Object.freeze([...candidate.capabilityIds]), warnings: Object.freeze([...candidate.warnings]), limitations: Object.freeze([...candidate.limitations]) }));
    }
    this.bundles = Object.freeze(frozen);
  }

  async listMetadata(): Promise<DefiCapabilityBundlesResponse> {
    const live = await this.catalog.listMetadata();
    const status = new Map<string, string>();
    for (const capability of live.capabilities) {
      if (typeof capability.capabilityId === 'string' && typeof capability.status === 'string') status.set(capability.capabilityId, capability.status);
    }
    const bundles: DefiCapabilityBundleMetadata[] = this.bundles.map((bundle) => {
      const unavailable = new Set<string>();
      for (const id of bundle.capabilityIds) if (status.get(id) !== 'active') unavailable.add(id);
      return {
        ...bundle,
        available: unavailable.size === 0,
        unavailableCapabilityIds: [...unavailable].sort(cmp),
      };
    });
    return {
      schemaVersion: 1,
      maxGrants: MAX_CAPABILITY_GRANTS,
      currentCatalogManifestHash: this.catalog.manifest().manifestHash,
      bundles,
    };
  }
}
