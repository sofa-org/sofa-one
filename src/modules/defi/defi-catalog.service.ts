import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service';
import { DefiCatalog, DefiChainPolicy, DefiFunctionPolicy, defiPauseScopeKeysForCapability } from './defi.types';
import { DEFI_MANIFEST, buildReviewedManifest, cloneDefiValue, deepFreeze, reviewedManifestHashValid } from './registry/defi-manifest';
import type { ReviewedManifest } from './registry/defi-manifest.types';
import { executionScopeHash } from './execution/scope';
import { POLYMARKET_CLOB_AUTH_CAPABILITY_ID } from './signing/polymarket-clob-auth';
import { POLYMARKET_CLOB_ORDER_CAPABILITY_ID } from './signing/polymarket-clob-order';

export const DEFI_CATALOG = Symbol('DEFI_CATALOG');

@Injectable()
export class DefiCatalogService {
  private readonly catalog: DefiCatalog;
  private readonly reviewedManifest: ReviewedManifest;

  constructor(@Inject(DEFI_CATALOG) source: DefiCatalog, private readonly prisma: PrismaService, @Inject(DEFI_MANIFEST) manifest: ReviewedManifest) {
    if (!reviewedManifestHashValid(manifest)) throw new Error('Invalid reviewed DeFi manifest hash');
    const copiedSource = deepFreeze(cloneDefiValue(source));
    if (copiedSource.some((chain) => chain.contracts.some((contract) => contract.functions.some((fn) => [POLYMARKET_CLOB_AUTH_CAPABILITY_ID, POLYMARKET_CLOB_ORDER_CAPABILITY_ID].includes(fn.capabilityId))))) throw new Error('DeFi signing capability collides with contract catalog identity');
    const sourceManifest = buildReviewedManifest([{ chains: copiedSource }]);
    const nestedManifest = buildReviewedManifest([{ chains: manifest.chains }]);
    if (sourceManifest.manifestHash !== manifest.manifestHash || nestedManifest.manifestHash !== manifest.manifestHash) throw new Error('DeFi catalog/manifest identity mismatch');
    this.catalog = copiedSource;
    this.reviewedManifest = deepFreeze(cloneDefiValue(manifest));
  }

  async listMetadata(): Promise<{ capabilities: Array<Record<string, unknown>> }> {
    let state;
    try { state = await this.prisma.defiPolicyState.findUnique({ where: { id: 'global' } }); }
    catch { throw unavailable(); }
    if (!state) throw unavailable();
    const paused = new Set(state.pausedScopeKeys);
    const capabilities: Array<Record<string, unknown>> = this.catalog.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => {
      const active = chain.status === 'active' && contract.status === 'active' && fn.status === 'active' && fn.type === 'contract_call';
      const scopeKeys = defiPauseScopeKeysForCapability(fn);
      return {
        capabilityId: fn.capabilityId,
        type: fn.type,
        chainId: chain.chainId,
        contract: contract.address,
        functionSignature: fn.type === 'contract_call' ? fn.signature : undefined,
        label: fn.label ?? fn.operation ?? fn.protocol ?? fn.capabilityId,
        description: fn.description ?? fn.inactiveReason ?? fn.capabilityId,
        protocol: fn.protocol,
        operation: fn.operation,
        inactiveReason: fn.inactiveReason,
        provenance: fn.provenance,
        warnings: fn.warnings,
        status: active ? (scopeKeys.some((key) => paused.has(key)) ? 'paused' : 'active') : 'inactive',
        policy: fn.policy,
        ...(fn.executionScope ? { executionScope: { kind: fn.executionScope.kind, hash: executionScopeHash(fn.executionScope), ...(fn.executionScope.kind === 'same-target-multicall-v1' ? { allowedChildren: fn.executionScope.allowedChildren.map((child) => ({ ...child })) } : {}) } } : {}),
      };
    })));
    capabilities.push({ capabilityId: POLYMARKET_CLOB_AUTH_CAPABILITY_ID, type: 'typed_data_sign', chainId: 137, label: 'Polymarket CLOB authentication', description: 'Strict ClobAuth EIP-712 attestation', protocol: 'Polymarket', operation: 'clob_auth', status: paused.has('global') || paused.has('chain:137') || paused.has(`capability:${POLYMARKET_CLOB_AUTH_CAPABILITY_ID}`) ? 'paused' : 'active' });
    capabilities.push({ capabilityId: POLYMARKET_CLOB_ORDER_CAPABILITY_ID, type: 'typed_data_sign', chainId: 137, label: 'Polymarket CLOB order signing', description: 'Explicitly grantable DepositWallet POLY1271 order signing; broad economic authority. Pausing does not revoke signatures already accepted.', protocol: 'Polymarket', operation: 'clob_order', warnings: ['Broad economic authority; grant explicitly. Not automatically enabled by all mode.', 'Pause does not revoke signatures already accepted.'], status: paused.has('global') || paused.has('chain:137') || paused.has(`capability:${POLYMARKET_CLOB_ORDER_CAPABILITY_ID}`) ? 'paused' : 'active' });
    return { capabilities };
  }

  signingCapability(id: string) { return (id === POLYMARKET_CLOB_AUTH_CAPABILITY_ID || id === POLYMARKET_CLOB_ORDER_CAPABILITY_ID) && !this.functionForCapability(id) ? Object.freeze({ capabilityId: id, type: 'typed_data_sign' as const, chainId: 137 as const }) : undefined; }

  chains(): readonly DefiChainPolicy[] { return this.catalog; }
  manifest(): ReviewedManifest { return this.reviewedManifest; }
  activeChain(chainId: number): DefiChainPolicy | undefined {
    return this.catalog.find((chain) => chain.chainId === chainId && chain.status === 'active' && chain.contracts.some((contract) => contract.status === 'active' && contract.functions.some((fn) => fn.status === 'active' && fn.type === 'contract_call')));
  }
  functionForCapability(id: string): DefiFunctionPolicy | undefined {
    for (const chain of this.catalog) for (const contract of chain.contracts) for (const fn of contract.functions) if (fn.capabilityId === id) return fn;
    return undefined;
  }
}
function unavailable(): ServiceUnavailableException { return new ServiceUnavailableException({ code: 'DEFI_POLICY_UNAVAILABLE', message: 'DeFi policy is unavailable' }); }
