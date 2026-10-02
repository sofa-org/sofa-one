import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { decodeFunctionData, encodeFunctionData, isAddress, toFunctionSelector, keccak256, stringToHex } from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import { SecurityEventService } from '../security-events/security-event.service';
import { DefiAuthorization, DefiDbClient, DefiExecutionContext, DefiFunctionPolicy, DefiInteraction, DefiMatch, DefiPolicyDenial, defiPauseScopeKeysForCapability } from './defi.types';
import { DefiCatalogService } from './defi-catalog.service';
import { buildDefiBatchPlan } from './defi-batch.policy';
import type { DefiCallEffect, DefiEvidence } from './defi.types';

@Injectable()
export class DefiPolicyService {
  constructor(private readonly prisma: PrismaService, private readonly events: SecurityEventService, private readonly catalog: DefiCatalogService) {}

  async authorizeContractCalls(interactions: DefiInteraction[], context: DefiExecutionContext, requestCommitment?: `0x${string}`): Promise<DefiAuthorization> {
    if (!context || !Array.isArray(context.allowedCapabilityIds)) this.deny('DEFI_POLICY_UNAVAILABLE');
    if (!isAddress(context.executionOwner, { strict: false })) this.deny('DEFI_INVALID_PARAMETERS', context);
    if (!Array.isArray(interactions) || interactions.length === 0) this.deny('DEFI_INVALID_PARAMETERS', context);
    context = Object.freeze({ ...context, allowedCapabilityIds: Object.freeze([...context.allowedCapabilityIds]) }) as DefiExecutionContext;
    const interactionSnapshot = freezeClone(interactions);
    const matches: DefiMatch[] = [];
    const effects: DefiCallEffect[] = [];
    for (let index = 0; index < interactionSnapshot.length; index++) {
      const interaction = interactionSnapshot[index];
      const chain = this.catalog.activeChain(context.chainId);
      if (!chain) this.deny('DEFI_CAPABILITY_NOT_FOUND', context);
      if (!interaction || !isAddress(interaction.to, { strict: false })) this.deny('DEFI_CONTRACT_NOT_ALLOWED', context);
      const contract = chain.contracts.find((entry) => entry.status === 'active' && entry.address.toLowerCase() === interaction.to.toLowerCase());
      if (!contract) this.deny('DEFI_CONTRACT_NOT_ALLOWED', context, undefined, { contract: interaction.to });
      const selector = interaction.data.slice(0, 10).toLowerCase();
      const fn = contract.functions.find((entry) => entry.status === 'active' && toFunctionSelector(entry.signature).toLowerCase() === selector);
      if (!fn) this.deny('DEFI_FUNCTION_NOT_ALLOWED', context, undefined, { contract: contract.address, functionSelector: safeFunctionSelector(interaction.data) });
      if (!context.allowedCapabilityIds.includes(fn.capabilityId)) this.deny('DEFI_CAPABILITY_NOT_GRANTED', context, fn);

      const pauseState = await this.readPauseState(context, fn);
      if (isPaused(pauseState, fn)) this.deny('DEFI_CAPABILITY_PAUSED', context, fn);

      let args: readonly unknown[];
      try {
        const abi = [fn.abi] as never;
        const decoded = decodeFunctionData({ abi, data: interaction.data as `0x${string}` });
        const canonical = encodeFunctionData({ abi, functionName: fn.functionName, args: decoded.args } as never);
        if (canonical.toLowerCase() !== interaction.data.toLowerCase()) this.deny('DEFI_INVALID_PARAMETERS', context, fn);
        args = freezeClone(decoded.args as readonly unknown[]);
      } catch (error) {
        if (error instanceof DefiPolicyDenial) throw error;
        this.deny('DEFI_INVALID_PARAMETERS', context, fn);
      }
      try {
        if (BigInt(interaction.value ?? 0) !== 0n) this.deny('DEFI_INVALID_PARAMETERS', context, fn);
      } catch (error) { if (error instanceof DefiPolicyDenial) throw error; this.deny('DEFI_INVALID_PARAMETERS', context, fn); }
       try { if (fn.validate(args!, context) !== true) this.deny('DEFI_INVALID_PARAMETERS', context, fn); }
       catch (error) { if (error instanceof DefiPolicyDenial) throw error; this.deny('DEFI_INVALID_PARAMETERS', context, fn); }
       try { const effect = fn.describe(args!, context, index); if (effect && typeof (effect as unknown as { then?: unknown }).then === 'function') this.deny('DEFI_INVALID_PARAMETERS', context, fn); effects.push(effect); }
       catch (error) { if (error instanceof DefiPolicyDenial) throw error; this.deny('DEFI_INVALID_PARAMETERS', context, fn); }
       matches.push(toMatch(fn, contract.address));
    }
    let batchPlan;
    try { batchPlan = buildDefiBatchPlan(effects, context, this.catalog.assetCeilings(context.chainId)); } catch { this.deny('DEFI_INVALID_PARAMETERS', context); }
    const manifestHash = this.catalog.manifest().manifestHash;
    const computed = buildDefiRequestCommitment(interactionSnapshot, context, manifestHash);
    if (requestCommitment !== undefined && requestCommitment !== computed) this.deny('DEFI_INVALID_PARAMETERS', context);
    const frozenMatches=freezeClone(matches);
    return Object.freeze({ context: freezeClone(context), requiredPermission: 'canSendTransaction', matches: frozenMatches, interactions: interactionSnapshot, batchPlan, manifestHash, requestCommitment: computed, policyIdentityHash: buildDefiPolicyIdentityHash(frozenMatches) });
  }

  authorizeSigning(_input: unknown, context: DefiExecutionContext): never { this.deny('DEFI_FUNCTION_NOT_ALLOWED', context); }

  async assertStillAuthorized(tx: DefiDbClient, authorization: DefiAuthorization, evidence: DefiEvidence) {
    const context = authorization.context;
    try {
      await tx.$queryRaw`SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM api_keys WHERE id = ${context.apiKeyId}::uuid FOR UPDATE`;
      const [state, key] = await Promise.all([
        tx.defiPolicyState.findUnique({ where: { id: 'global' } }),
        tx.apiKey.findUnique({ where: { id: context.apiKeyId } }),
      ]);
      if (!state) this.deny('DEFI_POLICY_UNAVAILABLE', context);
      if (!key || key.userId !== context.userId || key.revoked || key.frozenAt || (key.expiresAt && key.expiresAt <= new Date()) || !key[authorization.requiredPermission] || !Array.isArray(key.allowedCapabilityIds)) this.deny('DEFI_POLICY_UNAVAILABLE', context);
      for (const match of authorization.matches) {
        if (!key.allowedCapabilityIds.includes(match.capabilityId)) this.deny('DEFI_CAPABILITY_NOT_GRANTED', context, match);
        const fn = this.catalog.functionForCapability(match.capabilityId);
        if (!fn) return this.deny('DEFI_POLICY_UNAVAILABLE', context, match);
        if (isPaused(state, fn)) this.deny('DEFI_CAPABILITY_PAUSED', context, match);
        const chain = this.catalog.chains().find((item) => item.chainId === match.chainId && item.status === 'active');
        const contract = chain?.contracts.find((item) => item.status === 'active' && item.address.toLowerCase() === match.contract.toLowerCase());
        if (fn.status !== 'active' || fn.type !== match.type || fn.chainId !== match.chainId || fn.contract.toLowerCase() !== match.contract.toLowerCase() || fn.signature !== match.functionSignature || fn.policy.ref !== match.policy.ref || fn.policy.version !== match.policy.version || !contract || !contract.functions.includes(fn)) this.deny('DEFI_POLICY_UNAVAILABLE', context, match);
      }
      if(buildDefiPolicyIdentityHash(authorization.matches)!==authorization.policyIdentityHash) this.deny('DEFI_POLICY_UNAVAILABLE',context);
      assertDefiEvidenceFresh(authorization, evidence, Date.now(), this.catalog.manifest().manifestHash);
    } catch (error) { if (error instanceof DefiPolicyDenial) throw error; this.deny('DEFI_POLICY_UNAVAILABLE', context); }
  }

  async recordAllowedInTx(tx: DefiDbClient, authorization: DefiAuthorization) {
    return this.events.record({ actorType: 'api_key', eventType: 'defi.capability_allowed', userId: authorization.context.userId, apiKeyId: authorization.context.apiKeyId, walletId: authorization.context.walletId, result: 'allowed', metadata: { capabilities: authorization.matches.map((match) => ({ capabilityId: match.capabilityId, policy: match.policy })) } as Prisma.InputJsonValue }, tx, { deferExport: true });
  }

  async recordDenied(denial: DefiPolicyDenial) {
    const audit = denial.audit;
    const context = audit.context;
    try {
      const metadata = Object.fromEntries(Object.entries({
        code: audit.code,
        capabilityId: audit.capabilityId,
        capabilityType: audit.type === 'contract_call' || audit.type === 'typed_data_sign' ? audit.type : undefined,
        chainId: Number.isSafeInteger(audit.chainId) && audit.chainId! > 0 ? audit.chainId : undefined,
        contract: audit.contract && isAddress(audit.contract, { strict: false }) ? audit.contract.toLowerCase() : undefined,
        functionSignature: audit.functionSignature && /^[A-Za-z_$][\w$]*\([A-Za-z0-9_$,[\]()]*\)$/.test(audit.functionSignature) ? audit.functionSignature : undefined,
        functionSelector: audit.functionSelector && /^0x[0-9a-f]{8}$/i.test(audit.functionSelector) ? audit.functionSelector.toLowerCase() : undefined,
        policy: audit.policy && typeof audit.policy.ref === 'string' && audit.policy.ref.length <= 120 && Number.isSafeInteger(audit.policy.version) ? audit.policy : undefined,
        executionMode: context?.executionMode === 'session_key' || context?.executionMode === 'eoa' ? context.executionMode : undefined,
        executionOwner: context?.executionOwner && isAddress(context.executionOwner, { strict: false }) ? context.executionOwner.toLowerCase() : undefined,
      }).filter(([, value]) => value !== undefined));
      await this.events.record({ actorType: 'api_key', eventType: 'defi.policy_denied', userId: context?.userId, apiKeyId: context?.apiKeyId, walletId: context?.walletId, result: 'denied', reason: audit.code, metadata: metadata as Prisma.InputJsonValue });
    } catch { /* never mask the denial */ }
  }

  private async readPauseState(context: DefiExecutionContext, fn: DefiFunctionPolicy) {
    try {
      const state = await this.prisma.defiPolicyState.findUnique({ where: { id: 'global' } });
      if (!state) this.deny('DEFI_POLICY_UNAVAILABLE', context, fn);
      return state;
    } catch (error) { if (error instanceof DefiPolicyDenial) throw error; this.deny('DEFI_POLICY_UNAVAILABLE', context, fn); }
  }

  private deny(code: string, context?: DefiExecutionContext, match?: DefiMatch, details?: { contract?: string; functionSelector?: string }): never {
    const status = code === 'DEFI_POLICY_UNAVAILABLE' ? 503 : 403;
    throw new DefiPolicyDenial(new HttpException({ code, message: 'DeFi policy denied' }, status), { context, code, capabilityId: match?.capabilityId, type: match?.type, chainId: match?.chainId ?? context?.chainId, contract: match?.contract ?? details?.contract, functionSignature: match?.functionSignature, functionSelector: details?.functionSelector, policy: match?.policy });
  }
}

export function buildDefiRequestCommitment(interactions: readonly DefiInteraction[], context: DefiExecutionContext, manifestHash: `0x${string}`): `0x${string}` {
  const canonical = JSON.stringify({ interactions: interactions.map(i=>({to:i.to.toLowerCase(),data:i.data.toLowerCase(),value:String(i.value ?? 0)})), context: {userId:context.userId,apiKeyId:context.apiKeyId,walletId:context.walletId,chainId: context.chainId, executionMode: context.executionMode, executionOwner: context.executionOwner.toLowerCase(), allowedCapabilityIds: [...context.allowedCapabilityIds].sort() }, manifestHash });
  return keccak256(stringToHex(canonical));
}
export function buildDefiPolicyIdentityHash(matches: readonly DefiMatch[]): `0x${string}` { return keccak256(stringToHex(JSON.stringify(matches.map(m=>({capabilityId:m.capabilityId,type:m.type,chainId:m.chainId,contract:m.contract.toLowerCase(),functionSignature:m.functionSignature,policy:{ref:m.policy.ref,version:m.policy.version}}))))); }
export function assertDefiEvidenceFresh(auth: DefiAuthorization, evidence: DefiEvidence, now = Date.now(), currentManifestHash=auth.manifestHash): void {
  const fail=(code:string):never=>{throw new DefiPolicyDenial(new HttpException({code,message:'DeFi policy denied'},code==='DEFI_POLICY_UNAVAILABLE'?503:403),{context:auth.context,code});};
  const expected=buildDefiRequestCommitment(auth.interactions,auth.context,auth.manifestHash);
  if (!evidence || buildDefiPolicyIdentityHash(auth.matches)!==auth.policyIdentityHash || typeof evidence.executionOwner!=='string' || expected!==auth.requestCommitment || currentManifestHash!==auth.manifestHash || evidence.requestCommitment !== auth.requestCommitment || evidence.manifestHash !== auth.manifestHash || evidence.chainId !== auth.context.chainId || evidence.executionOwner.toLowerCase() !== auth.context.executionOwner.toLowerCase() || !Number.isSafeInteger(evidence.observedAtMs) || !Number.isSafeInteger(evidence.expiresAtMs) || evidence.observedAtMs>now || now>=evidence.expiresAtMs || evidence.expiresAtMs>evidence.observedAtMs+30_000 || now-evidence.observedAtMs>30_000 || typeof evidence.blockNumber!=='bigint' || evidence.blockNumber<0n || !/^0x[0-9a-f]{64}$/i.test(evidence.blockHash) || !/^0x[0-9a-f]{64}$/i.test(evidence.checksDigest)) fail('DEFI_POLICY_UNAVAILABLE');
  for (const effect of auth.batchPlan.effects) if (effect.kind === 'action' && effect.swap && (effect.swap.deadline * 1000n <= BigInt(now) || effect.swap.deadline * 1000n > BigInt(now + 120_000))) fail('DEFI_INVALID_PARAMETERS');
}
function freezeClone<T>(value:T):T { if (Array.isArray(value)) return Object.freeze(value.map(freezeClone)) as T; if (value && typeof value==='object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([k,v])=>[k,freezeClone(v)]))) as T; return value; }

function isPaused(state: { pausedScopeKeys: string[] }, fn: DefiFunctionPolicy): boolean {
  const paused = new Set(state.pausedScopeKeys);
  return defiPauseScopeKeysForCapability(fn).some((scopeKey) => paused.has(scopeKey));
}

function toMatch(fn: DefiFunctionPolicy, contract: string): DefiMatch {
  return { capabilityId: fn.capabilityId, type: fn.type, chainId: fn.chainId, contract, functionSignature: fn.signature, policy: fn.policy };
}

function safeFunctionSelector(data: string): string | undefined {
  return /^0x[0-9a-f]{8}/i.test(data) ? data.slice(0, 10).toLowerCase() : undefined;
}
