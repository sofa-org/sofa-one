import { HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { decodeFunctionData, encodeFunctionData, isAddress, keccak256, stringToHex, toFunctionSelector } from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import { SecurityEventService } from '../security-events/security-event.service';
import { DefiAuthorization, DefiDbClient, DefiExecutionContext, DefiExecutionPlanNode, DefiFunctionPolicy, DefiInteraction, DefiMatch, DefiPolicyDenial, DefiSigningAuthorization, defiPauseScopeKeysForCapability } from './defi.types';
import { DefiCatalogService } from './defi-catalog.service';
import { functionAbiHash, reviewedManifestHashValid } from './registry/defi-manifest';
import { executionScopeHash, NPM_MULTICALL_CHILD_SIGNATURES } from './execution/scope';
import { MAX_DEFI_EXECUTION_NODES, preflightBytesArray, sameExecutionPlan } from './execution/planner';
import { AMBIENT_CHAIN_ID, AMBIENT_SIGNATURE, AMBIENT_TARGET, preflightAmbientRoot, validateAmbientColdpathPayload } from './execution/ambient';
import { decodeEnsoStaticWeirollRoot } from './execution/enso';
import { ENSO_STATIC_WEIROLL_CHILD_IDENTITIES, ENSO_STATIC_WEIROLL_ROOT_IDENTITY } from './execution/enso-identity';
import { decodePusdWrapCall, isPolymarketPusdWrapIdentity, validatePolymarketPusdWrapBinding } from './execution/pusd-identity';
import { POLYMARKET_CLOB_AUTH_CAPABILITY_ID, signingPayloadDigest, validatePolymarketClobAuth } from './signing/polymarket-clob-auth';

const MAX_UINT256 = (1n << 256n) - 1n;

@Injectable()
export class DefiPolicyService {
  constructor(private readonly prisma: PrismaService, private readonly events: SecurityEventService, private readonly catalog: DefiCatalogService) {}

  async authorizeContractCalls(interactions: readonly DefiInteraction[], context: DefiExecutionContext, expectedCommitment?: `0x${string}`): Promise<DefiAuthorization> {
    if (!context || !Array.isArray(context.allowedCapabilityIds)) this.deny('DEFI_POLICY_UNAVAILABLE');
    if (!Number.isSafeInteger(context.chainId) || context.chainId <= 0 || !isAddress(context.executionOwner, { strict: false })) this.deny('DEFI_INVALID_PARAMETERS', context);
    if (!Array.isArray(interactions) || interactions.length === 0) this.deny('DEFI_INVALID_PARAMETERS', context);
    const snapshotContext = freezeClone({ ...context, executionOwner: context.executionOwner.toLowerCase(), allowedCapabilityIds: [...context.allowedCapabilityIds].sort() });
    const snapshotInteractions = interactions.map((interaction) => freezeClone(normalizeInteraction(interaction, snapshotContext)));
    // This adapter is intentionally a singleton top-level lane, never an implicit
    // child inside a broader execution scope. Reject mixtures in either order.
    let hasPusdWrap = false;
    for (const interaction of snapshotInteractions) {
      try { if (decodePusdWrapCall(snapshotContext.chainId, interaction)) hasPusdWrap = true; }
      catch { this.deny('DEFI_INVALID_PARAMETERS', snapshotContext); }
    }
    if (hasPusdWrap && snapshotInteractions.length !== 1) this.deny('DEFI_INVALID_PARAMETERS', snapshotContext);
    if (snapshotInteractions.length > MAX_DEFI_EXECUTION_NODES || snapshotInteractions.reduce((sum, call) => sum + Math.max(0, (call.data.length - 2) / 2), 0) > 65_536) this.deny('DEFI_INVALID_PARAMETERS', snapshotContext);
    const matches: DefiMatch[] = [];
    const executionPlan: DefiExecutionPlanNode[] = [];
    for (const interaction of snapshotInteractions) {
      const fn = this.resolveInteraction(interaction, snapshotContext);
      this.assertGrantedAndUnpaused(fn, snapshotContext, await this.readPauseState(snapshotContext, fn));
      matches.push(toMatch(fn));
      const expanded = this.expandExecution(interaction, fn, snapshotContext, [matches.length - 1], executionPlan.length);
      for (const node of expanded) {
        if (!snapshotContext.allowedCapabilityIds.includes(node.match.capabilityId)) this.deny('DEFI_CAPABILITY_NOT_GRANTED', snapshotContext, this.catalog.functionForCapability(node.match.capabilityId));
        const childFn = this.catalog.functionForCapability(node.match.capabilityId)!;
        const state = await this.readPauseState(snapshotContext, childFn);
        if (isPaused(state, childFn)) this.deny('DEFI_CAPABILITY_PAUSED', snapshotContext, childFn);
        executionPlan.push(node);
      }
    }
    const manifest = this.catalog.manifest();
    if (!reviewedManifestHashValid(manifest)) this.deny('DEFI_POLICY_UNAVAILABLE', snapshotContext);
    const commitment = buildDefiRequestCommitment(snapshotInteractions, snapshotContext, manifest.manifestHash);
    if (expectedCommitment !== undefined && expectedCommitment !== commitment) this.deny('DEFI_INVALID_PARAMETERS', snapshotContext);
    return deepFreeze({
      context: snapshotContext,
      requiredPermission: 'canSendTransaction' as const,
      matches,
      interactions: snapshotInteractions,
      executionPlan,
      manifestHash: manifest.manifestHash,
      requestCommitment: commitment,
    });
  }

  async authorizeSigning(input: unknown, context: DefiExecutionContext & { agentOpenfortAccountId: string; walletAddress: string; agentWalletAddress: string }): Promise<DefiSigningAuthorization> {
    try {
      if (context.chainId !== 137 || context.executionMode !== 'eoa' || !context.allowedCapabilityIds.includes(POLYMARKET_CLOB_AUTH_CAPABILITY_ID)) this.deny('DEFI_CAPABILITY_NOT_GRANTED', context);
      const payload = validatePolymarketClobAuth(input, context.agentWalletAddress);
      let state;
      try { state = await this.prisma.defiPolicyState.findUnique({ where: { id: 'global' } }); }
      catch { this.deny('DEFI_POLICY_UNAVAILABLE', context); }
      if (!state) this.deny('DEFI_POLICY_UNAVAILABLE', context);
      if (state.pausedScopeKeys.some((key) => key === 'global' || key === 'chain:137' || key === `capability:${POLYMARKET_CLOB_AUTH_CAPABILITY_ID}`)) this.deny('DEFI_CAPABILITY_PAUSED', context);
      const policyHash = keccak256(stringToHex('polymarket-clob-auth-policy:v1'));
      const typedDataDigest = signingPayloadDigest(payload);
      const snapshotContext = freezeClone({ ...context, executionOwner: context.agentWalletAddress.toLowerCase(), allowedCapabilityIds: [...context.allowedCapabilityIds].sort() }) as DefiExecutionContext;
      const bindings = { userId: context.userId, apiKeyId: context.apiKeyId, walletId: context.walletId, chainId: 137, executionMode: 'eoa', owner: context.agentWalletAddress.toLowerCase(), walletAddress: context.walletAddress.toLowerCase(), agentOpenfortAccountId: context.agentOpenfortAccountId };
      return deepFreeze({ context: snapshotContext, requiredPermission: 'canSign' as const, capabilityId: POLYMARKET_CLOB_AUTH_CAPABILITY_ID, chainId: 137 as const, executionMode: 'eoa' as const, policyHash, typedDataDigest, payload, bindingCommitment: keccak256(stringToHex(JSON.stringify(bindings))), walletAddress: context.walletAddress.toLowerCase(), agentWalletAddress: context.agentWalletAddress.toLowerCase(), agentOpenfortAccountId: context.agentOpenfortAccountId });
    } catch (error) {
      if (error instanceof DefiPolicyDenial) throw error;
      this.deny('DEFI_INVALID_PARAMETERS', context);
    }
  }

  async assertSigningStillAuthorized(tx: DefiDbClient, auth: DefiSigningAuthorization, actual: { userId: string; apiKeyId: string; chainId: number; executionMode: string; type: string; digest: string; walletId: string; walletAddress: string; agentWalletAddress: string; agentOpenfortAccountId: string }): Promise<void> {
    const context = auth?.context;
    try {
      if (!context || !Object.isFrozen(auth) || !Object.isFrozen(auth.payload) || !Object.isFrozen(context) || !Object.isFrozen(context.allowedCapabilityIds) || auth.requiredPermission !== 'canSign' || auth.capabilityId !== POLYMARKET_CLOB_AUTH_CAPABILITY_ID || auth.chainId !== 137 || auth.executionMode !== 'eoa' || context.chainId !== 137 || context.executionMode !== 'eoa' || context.executionOwner.toLowerCase() !== auth.agentWalletAddress.toLowerCase() || !context.allowedCapabilityIds.includes(auth.capabilityId)) this.deny('DEFI_POLICY_UNAVAILABLE', context);
      if (actual.type !== 'typed_data' || actual.userId !== context.userId || actual.apiKeyId !== context.apiKeyId || actual.chainId !== auth.chainId || actual.executionMode !== auth.executionMode) this.deny('DEFI_INVALID_PARAMETERS', context);
      const typed = validatePolymarketClobAuth(auth.payload, auth.agentWalletAddress);
      const expectedDigest = signingPayloadDigest(typed);
      const binds = { userId: context.userId, apiKeyId: context.apiKeyId, walletId: context.walletId, chainId: 137, executionMode: 'eoa', owner: auth.agentWalletAddress.toLowerCase(), walletAddress: auth.walletAddress.toLowerCase(), agentOpenfortAccountId: auth.agentOpenfortAccountId };
      if (expectedDigest !== auth.typedDataDigest || auth.bindingCommitment !== keccak256(stringToHex(JSON.stringify(binds)))) this.deny('DEFI_INVALID_PARAMETERS', context);
      await tx.$queryRaw`SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM api_keys WHERE id = ${context.apiKeyId}::uuid FOR UPDATE`;
      const [state, key, wallet, user] = await Promise.all([
        tx.defiPolicyState.findUnique({ where: { id: 'global' } }),
        tx.apiKey.findUnique({ where: { id: context.apiKeyId } }),
        tx.userWallet.findFirst({ where: { id: context.walletId, userId: context.userId }, select: { id: true, userId: true, status: true, frozenAt: true, walletAddress: true, agentWalletAddress: true, agentOpenfortAccountId: true } }),
        tx.user.findUnique({ where: { id: context.userId }, select: { id: true, frozenAt: true } }),
      ]);
      if (actual.digest !== auth.typedDataDigest || actual.walletId !== context.walletId || actual.walletAddress.toLowerCase() !== auth.walletAddress || actual.agentWalletAddress.toLowerCase() !== auth.agentWalletAddress || actual.agentOpenfortAccountId !== auth.agentOpenfortAccountId) this.deny('DEFI_INVALID_PARAMETERS', context);
      if (!state || !key || key.userId !== context.userId || key.revoked || key.frozenAt || (key.expiresAt && key.expiresAt <= new Date()) || !key.canSign || !key.canUseEoaExecution || !Array.isArray(key.allowedCapabilityIds) || !key.allowedCapabilityIds.includes(auth.capabilityId) || !wallet || wallet.status !== 'active' || wallet.frozenAt || !user || user.frozenAt || wallet.walletAddress?.toLowerCase() !== auth.walletAddress || wallet.agentWalletAddress?.toLowerCase() !== auth.agentWalletAddress || wallet.agentOpenfortAccountId !== auth.agentOpenfortAccountId) this.deny('DEFI_POLICY_UNAVAILABLE', context);
      if (state.pausedScopeKeys.some((key) => key === 'global' || key === 'chain:137' || key === `capability:${auth.capabilityId}`)) this.deny('DEFI_CAPABILITY_PAUSED', context);
      const descriptor = this.catalog.signingCapability(auth.capabilityId);
      if (!descriptor || descriptor.type !== 'typed_data_sign' || descriptor.chainId !== auth.chainId || auth.policyHash !== keccak256(stringToHex('polymarket-clob-auth-policy:v1'))) this.deny('DEFI_POLICY_UNAVAILABLE', context);
      validatePolymarketClobAuth(auth.payload, wallet.agentWalletAddress!, Date.now());
    } catch (error) {
      if (error instanceof DefiPolicyDenial) throw error;
      this.deny('DEFI_POLICY_UNAVAILABLE', context);
    }
  }

  async recordSigningAllowedInTx(tx: DefiDbClient, auth: DefiSigningAuthorization) {
    return this.events.record({ actorType: 'api_key', eventType: 'defi.signing_capability_allowed', userId: auth.context.userId, apiKeyId: auth.context.apiKeyId, walletId: auth.context.walletId, result: 'allowed', metadata: { capabilityId: auth.capabilityId, chainId: auth.chainId, executionMode: auth.executionMode } as Prisma.InputJsonValue }, tx, { deferExport: true });
  }
  async exportSigningAllowed(event: unknown) { await this.events.exportCommitted(event); }

  /** Final READ COMMITTED acceptance check. Caller owns transaction isolation and rollback behavior. */
  async assertStillAuthorized(tx: DefiDbClient, authorization: DefiAuthorization): Promise<void> {
    const context = authorization?.context;
    try {
      if (!context) this.deny('DEFI_POLICY_UNAVAILABLE');
      await tx.$queryRaw`SELECT id FROM defi_policy_state WHERE id = 'global' FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM api_keys WHERE id = ${context.apiKeyId}::uuid FOR UPDATE`;
      const [state, key] = await Promise.all([
        tx.defiPolicyState.findUnique({ where: { id: 'global' } }),
        tx.apiKey.findUnique({ where: { id: context.apiKeyId } }),
      ]);
      if (!state || !key || key.userId !== context.userId || key.revoked || key.frozenAt || (key.expiresAt && key.expiresAt <= new Date()) || !key.canSendTransaction || !Array.isArray(key.allowedCapabilityIds)) this.deny('DEFI_POLICY_UNAVAILABLE', context);
      const manifest = this.catalog.manifest();
       if (authorization.requiredPermission !== 'canSendTransaction' || !reviewedManifestHashValid(manifest) || manifest.manifestHash !== authorization.manifestHash || !Array.isArray(authorization.interactions) || !Array.isArray(authorization.matches) || !Array.isArray(authorization.executionPlan) || authorization.interactions.length === 0 || authorization.interactions.length !== authorization.matches.length || authorization.interactions.length > MAX_DEFI_EXECUTION_NODES) this.deny('DEFI_POLICY_UNAVAILABLE', context);
      if (buildDefiRequestCommitment(authorization.interactions, context, authorization.manifestHash) !== authorization.requestCommitment) this.deny('DEFI_POLICY_UNAVAILABLE', context);
       const liveGrants = new Set<string>(key.allowedCapabilityIds);
       const recomputedPlan: DefiExecutionPlanNode[] = [];
       for (let index = 0; index < authorization.interactions.length; index++) {
         const fn = this.resolveInteraction(authorization.interactions[index], context);
        const match = authorization.matches[index];
         if (!match || !sameMatch(match, toMatch(fn)) || !context.allowedCapabilityIds.includes(fn.capabilityId)) this.deny('DEFI_POLICY_UNAVAILABLE', context, fn);
         if (!liveGrants.has(fn.capabilityId)) this.deny('DEFI_CAPABILITY_NOT_GRANTED', context, fn);
         if (isPaused(state, fn)) this.deny('DEFI_CAPABILITY_PAUSED', context, fn);
          const expanded = this.expandExecution(authorization.interactions[index], fn, context, [index], recomputedPlan.length);
         for (const node of expanded) {
           const child = this.catalog.functionForCapability(node.match.capabilityId);
           if (!child || !liveGrants.has(child.capabilityId)) this.deny('DEFI_CAPABILITY_NOT_GRANTED', context, child);
           if (isPaused(state, child)) this.deny('DEFI_CAPABILITY_PAUSED', context, child);
           recomputedPlan.push(node);
        }
        let hasPusdWrap = false;
        for (const interaction of authorization.interactions) {
          try { if (decodePusdWrapCall(context.chainId, interaction)) hasPusdWrap = true; }
          catch { this.deny('DEFI_POLICY_UNAVAILABLE', context); }
        }
        if (hasPusdWrap && authorization.interactions.length !== 1) this.deny('DEFI_POLICY_UNAVAILABLE', context);
       }
       if (!sameExecutionPlan(authorization.executionPlan, recomputedPlan, sameMatch)) this.deny('DEFI_POLICY_UNAVAILABLE', context);
    } catch (error) {
      if (error instanceof DefiPolicyDenial) throw error;
      this.deny('DEFI_POLICY_UNAVAILABLE', context);
    }
  }

  async recordAllowedInTx(tx: DefiDbClient, authorization: DefiAuthorization) {
    const ensoRoots = authorization.executionPlan.flatMap((node) => {
      if (node.match.capabilityId !== ENSO_STATIC_WEIROLL_ROOT_IDENTITY.capabilityId) return [];
      const decoded = decodeEnsoStaticWeirollRoot(node.data, BigInt(node.match.nativeValue ?? '0'));
      return [{ path: node.path, commandCount: decoded.commandCount, stateCount: decoded.stateCount, childValueSum: decoded.childValueSum.toString() }];
    });
    return this.events.record({
      actorType: 'api_key', eventType: 'defi.capability_allowed', userId: authorization.context.userId, apiKeyId: authorization.context.apiKeyId, walletId: authorization.context.walletId, result: 'allowed',
      metadata: { capabilities: authorization.executionPlan.map((node) => ({ capabilityId: node.match.capabilityId, abiHash: node.match.abiHash, policy: node.match.policy, path: node.path, ...(node.match.executionScopeHash ? { executionScopeHash: node.match.executionScopeHash } : {}) })), ...(ensoRoots.length ? { ensoRoots } : {}) } as Prisma.InputJsonValue,
    }, tx, { deferExport: true });
  }

  async recordDenied(denial: DefiPolicyDenial): Promise<void> {
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
        abiHash: audit.abiHash && /^0x[0-9a-f]{64}$/i.test(audit.abiHash) ? audit.abiHash.toLowerCase() : undefined,
        policy: audit.policy && typeof audit.policy.ref === 'string' && audit.policy.ref.length <= 120 && Number.isSafeInteger(audit.policy.version) ? audit.policy : undefined,
        executionMode: context?.executionMode === 'session_key' || context?.executionMode === 'eoa' ? context.executionMode : undefined,
        executionOwner: context?.executionOwner && isAddress(context.executionOwner, { strict: false }) ? context.executionOwner.toLowerCase() : undefined,
      }).filter(([, value]) => value !== undefined));
      await this.events.record({ actorType: 'api_key', eventType: 'defi.policy_denied', userId: context?.userId, apiKeyId: context?.apiKeyId, walletId: context?.walletId, result: 'denied', reason: audit.code, metadata: metadata as Prisma.InputJsonValue });
    } catch { /* audit failure must never mask a policy denial */ }
  }

  private resolveInteraction(interaction: DefiInteraction, context: DefiExecutionContext): DefiFunctionPolicy {
    const chain = this.catalog.activeChain(context.chainId);
    if (!chain) this.deny('DEFI_CAPABILITY_NOT_FOUND', context);
    if (!interaction || !isAddress(interaction.to, { strict: false })) this.deny('DEFI_CONTRACT_NOT_ALLOWED', context);
    const contract = chain.contracts.find((entry) => entry.status === 'active' && entry.address.toLowerCase() === interaction.to.toLowerCase());
    if (!contract) this.deny('DEFI_CONTRACT_NOT_ALLOWED', context, undefined, { contract: interaction.to });
    if (typeof interaction.data !== 'string' || !/^0x[0-9a-fA-F]{8}/.test(interaction.data)) this.deny('DEFI_FUNCTION_NOT_ALLOWED', context, undefined, { contract: contract.address });
    const selector = interaction.data.slice(0, 10).toLowerCase();
    const fn = contract.functions.find((entry) => entry.status === 'active' && entry.type === 'contract_call' && toFunctionSelector(entry.signature).toLowerCase() === selector);
    if (!fn) this.deny('DEFI_FUNCTION_NOT_ALLOWED', context, undefined, { contract: contract.address, functionSelector: safeFunctionSelector(interaction.data) });
    const pusdIdentityMarker = isPolymarketPusdWrapIdentity(fn);
    if (pusdIdentityMarker || fn.executionScope?.kind === 'polymarket-pusd-wrap-v1') {
      if (pusdIdentityMarker && fn.executionScope?.kind !== 'polymarket-pusd-wrap-v1') {
        this.deny('DEFI_POLICY_UNAVAILABLE', context, fn);
      }
      try { validatePolymarketPusdWrapBinding(fn); }
      catch { this.deny('DEFI_POLICY_UNAVAILABLE', context, fn); }
      try { decodePusdWrapCall(context.chainId, interaction); }
      catch { this.deny('DEFI_INVALID_PARAMETERS', context, fn); }
    }
    if (!context.allowedCapabilityIds.includes(fn.capabilityId)) this.deny('DEFI_CAPABILITY_NOT_GRANTED', context, fn);
    return fn;
  }

  private assertCanonicalCall(interaction: DefiInteraction, fn: DefiFunctionPolicy, context: DefiExecutionContext): void {
    this.assertNativeValue(interaction, fn, context);
    this.decodeCanonicalArgs(interaction, fn, context);
  }

  private assertNativeValue(interaction: DefiInteraction, fn: DefiFunctionPolicy, context: DefiExecutionContext): void {
    const value = parseNativeValue(interaction.value, context, fn);
    if (fn.abi.stateMutability !== 'payable' && value !== 0n) this.deny('DEFI_INVALID_PARAMETERS', context, fn);
  }

  private assertGrantedAndUnpaused(fn: DefiFunctionPolicy, context: DefiExecutionContext, state: { pausedScopeKeys: string[] }): void {
    if (!context.allowedCapabilityIds.includes(fn.capabilityId)) this.deny('DEFI_CAPABILITY_NOT_GRANTED', context, fn);
    if (isPaused(state, fn)) this.deny('DEFI_CAPABILITY_PAUSED', context, fn);
  }

  /** Interprets only reviewed closed scopes; Ambient protocol callbacks never become recursive wallet children. */
  private expandExecution(root: DefiInteraction, rootFn: DefiFunctionPolicy, context: DefiExecutionContext, path: number[], alreadyPlanned: number): DefiExecutionPlanNode[] {
    const rootNode = deepFreeze({ path: [...path], data: root.data.toLowerCase() as `0x${string}`, match: toMatch(rootFn, root.value as string) });
    const scope = rootFn.executionScope;
    const ambientIdentity = rootFn.chainId === AMBIENT_CHAIN_ID && rootFn.contract.toLowerCase() === AMBIENT_TARGET.toLowerCase();
    const ensoIdentityMarker = rootFn.capabilityId === ENSO_STATIC_WEIROLL_ROOT_IDENTITY.capabilityId
      || rootFn.chainId === ENSO_STATIC_WEIROLL_ROOT_IDENTITY.chainId && rootFn.contract.toLowerCase() === ENSO_STATIC_WEIROLL_ROOT_IDENTITY.contract
      || rootFn.signature === ENSO_STATIC_WEIROLL_ROOT_IDENTITY.signature;
    if (ensoIdentityMarker) {
      if (rootFn.capabilityId !== ENSO_STATIC_WEIROLL_ROOT_IDENTITY.capabilityId
        || rootFn.chainId !== ENSO_STATIC_WEIROLL_ROOT_IDENTITY.chainId
        || rootFn.contract.toLowerCase() !== ENSO_STATIC_WEIROLL_ROOT_IDENTITY.contract
        || root.to.toLowerCase() !== ENSO_STATIC_WEIROLL_ROOT_IDENTITY.contract
        || rootFn.functionName !== ENSO_STATIC_WEIROLL_ROOT_IDENTITY.functionName
        || rootFn.signature !== ENSO_STATIC_WEIROLL_ROOT_IDENTITY.signature
        || functionAbiHash(rootFn) !== ENSO_STATIC_WEIROLL_ROOT_IDENTITY.abiHash
        || rootFn.abi.stateMutability !== ENSO_STATIC_WEIROLL_ROOT_IDENTITY.stateMutability
        || toFunctionSelector(rootFn.signature).toLowerCase() !== ENSO_STATIC_WEIROLL_ROOT_IDENTITY.selector
        || scope?.kind !== 'enso-static-weiroll-v1') this.deny('DEFI_POLICY_UNAVAILABLE', context, rootFn);
      try {
        executionScopeHash(scope);
      } catch { this.deny('DEFI_POLICY_UNAVAILABLE', context, rootFn); }
      const allowedChildren = scope.allowedChildren;
      if (allowedChildren.length !== ENSO_STATIC_WEIROLL_CHILD_IDENTITIES.length
        || ENSO_STATIC_WEIROLL_CHILD_IDENTITIES.some((literal) => !allowedChildren.some((child) => child.chainId === literal.chainId
          && child.contract.toLowerCase() === literal.contract && child.capabilityId === literal.capabilityId
          && child.signature === literal.signature && child.abiHash.toLowerCase() === literal.abiHash))) this.deny('DEFI_POLICY_UNAVAILABLE', context, rootFn);
      this.assertCanonicalCall(root, rootFn, context);
      let decoded: ReturnType<typeof decodeEnsoStaticWeirollRoot>;
      try { decoded = decodeEnsoStaticWeirollRoot(root.data as `0x${string}`, BigInt(root.value ?? '0')); }
      catch { this.deny('DEFI_INVALID_PARAMETERS', context, rootFn); }
      if (alreadyPlanned + 1 + decoded.children.length > MAX_DEFI_EXECUTION_NODES) this.deny('DEFI_INVALID_PARAMETERS', context, rootFn);
      const nodes: DefiExecutionPlanNode[] = [rootNode];
      for (let childIndex = 0; childIndex < decoded.children.length; childIndex++) {
        const childCall = decoded.children[childIndex];
        const literal = ENSO_STATIC_WEIROLL_CHILD_IDENTITIES.find((child) => child.contract === childCall.target.toLowerCase());
        const chain = this.catalog.activeChain(context.chainId);
        const contract = chain?.contracts.find((entry) => entry.status === 'active' && entry.address.toLowerCase() === childCall.target.toLowerCase());
        const childFn = contract?.functions.find((candidate) => candidate.status === 'active' && candidate.type === 'contract_call' && candidate.capabilityId === literal?.capabilityId);
        if (!literal || !childFn || childFn.executionScope || childFn.chainId !== literal.chainId || childFn.contract.toLowerCase() !== literal.contract
          || childFn.signature !== literal.signature || functionAbiHash(childFn) !== literal.abiHash
          || !allowedChildren.some((child) => child.chainId === childFn.chainId && child.contract.toLowerCase() === childFn.contract.toLowerCase()
            && child.capabilityId === childFn.capabilityId && child.signature === childFn.signature && child.abiHash.toLowerCase() === functionAbiHash(childFn))) this.deny('DEFI_FUNCTION_NOT_ALLOWED', context, rootFn);
        const childInteraction: DefiInteraction = { to: childCall.target, data: childCall.data, value: childCall.value.toString() };
        this.assertCanonicalCall(childInteraction, childFn, context);
        nodes.push(deepFreeze({ path: [...path, childIndex], data: childCall.data.toLowerCase() as `0x${string}`, match: toMatch(childFn, childCall.value.toString()) }));
      }
      return nodes;
    }
    if (ambientIdentity && (rootFn.signature !== AMBIENT_SIGNATURE || scope?.kind !== 'ambient-coldpath-v1')) this.deny('DEFI_POLICY_UNAVAILABLE', context, rootFn);
    if (!scope) {
      if (alreadyPlanned + 1 > MAX_DEFI_EXECUTION_NODES) this.deny('DEFI_INVALID_PARAMETERS', context, rootFn);
      this.assertCanonicalCall(root, rootFn, context);
      return [rootNode];
    }
    if (scope.kind === 'polymarket-pusd-wrap-v1') {
      try {
        validatePolymarketPusdWrapBinding(rootFn);
        if (path.length !== 1 || path[0] !== 0 || root.to.toLowerCase() !== rootFn.contract.toLowerCase()
          || !decodePusdWrapCall(context.chainId, root)) this.deny('DEFI_POLICY_UNAVAILABLE', context, rootFn);
      } catch { this.deny('DEFI_POLICY_UNAVAILABLE', context, rootFn); }
      this.assertCanonicalCall(root, rootFn, context);
      if (alreadyPlanned + 1 > MAX_DEFI_EXECUTION_NODES) this.deny('DEFI_INVALID_PARAMETERS', context, rootFn);
      return [rootNode];
    }
    if (scope.kind === 'empty-callback-data-v1') {
      this.assertNativeValue(root, rootFn, context);
      const args = this.decodeCanonicalArgs(root, rootFn, context);
      const index = scope.bytesArgIndex;
      if (rootFn.abi.inputs[index]?.type !== 'bytes' || args[index] !== '0x') this.deny('DEFI_INVALID_PARAMETERS', context, rootFn);
      if (alreadyPlanned + 1 > MAX_DEFI_EXECUTION_NODES) this.deny('DEFI_INVALID_PARAMETERS', context, rootFn);
      return [rootNode];
    }
    if (scope.kind === 'ambient-coldpath-v1') {
      if (!ambientIdentity || rootFn.signature !== AMBIENT_SIGNATURE || rootFn.abi.stateMutability !== 'payable' || rootFn.abi.inputs.length !== 2 || rootFn.abi.inputs[0].type !== 'uint16' || rootFn.abi.inputs[1].type !== 'bytes' || rootFn.abi.outputs.length !== 1 || rootFn.abi.outputs[0].type !== 'bytes' || scope.callpathArgIndex !== 0 || scope.bytesArgIndex !== 1) this.deny('DEFI_POLICY_UNAVAILABLE', context, rootFn);
      this.assertNativeValue(root, rootFn, context);
      let preflight: ReturnType<typeof preflightAmbientRoot>;
      try { preflight = preflightAmbientRoot(root.data); } catch { this.deny('DEFI_INVALID_PARAMETERS', context, rootFn); }
      const args = this.decodeCanonicalArgs(root, rootFn, context);
      if (BigInt(args[scope.callpathArgIndex] as number | bigint) !== BigInt(preflight.callpath) || args[scope.bytesArgIndex] !== preflight.payload) this.deny('DEFI_INVALID_PARAMETERS', context, rootFn);
      try { validateAmbientColdpathPayload(preflight.callpath, preflight.payload); } catch { this.deny('DEFI_INVALID_PARAMETERS', context, rootFn); }
      if (alreadyPlanned + 1 > MAX_DEFI_EXECUTION_NODES) this.deny('DEFI_INVALID_PARAMETERS', context, rootFn);
      return [rootNode];
    }
    if (scope.kind !== 'same-target-multicall-v1' || rootFn.signature !== 'multicall(bytes[])' || rootFn.abi.inputs.length !== 1 || rootFn.abi.inputs[0].type !== 'bytes[]' || rootFn.abi.outputs?.length !== 1 || rootFn.abi.outputs[0].type !== 'bytes[]' || rootFn.abi.stateMutability !== 'payable') this.deny('DEFI_POLICY_UNAVAILABLE', context, rootFn);
    let count: number;
    try { count = preflightBytesArray(root.data, scope.bytesArrayArgIndex); }
    catch { this.deny('DEFI_INVALID_PARAMETERS', context, rootFn); }
    if (count === 0 || alreadyPlanned + count + 1 > MAX_DEFI_EXECUTION_NODES) this.deny('DEFI_INVALID_PARAMETERS', context, rootFn);
    this.assertNativeValue(root, rootFn, context);
    const args = this.decodeCanonicalArgs(root, rootFn, context);
    const calls = args[scope.bytesArrayArgIndex];
    if (!Array.isArray(calls) || calls.length !== count) this.deny('DEFI_INVALID_PARAMETERS', context, rootFn);
    const contract = this.catalog.activeChain(context.chainId)?.contracts.find((entry) => entry.address.toLowerCase() === root.to.toLowerCase());
    if (!contract) this.deny('DEFI_CONTRACT_NOT_ALLOWED', context, rootFn);
    const nodes: DefiExecutionPlanNode[] = [rootNode];
    for (let childIndex = 0; childIndex < calls.length; childIndex++) {
      const data = calls[childIndex];
      if (typeof data !== 'string' || !/^0x[0-9a-f]{8}/i.test(data)) this.deny('DEFI_FUNCTION_NOT_ALLOWED', context, rootFn);
      const selector = data.slice(0, 10).toLowerCase();
      const childFn = contract.functions.find((candidate) => candidate.status === 'active' && candidate.type === 'contract_call' && toFunctionSelector(candidate.signature).toLowerCase() === selector);
      if (!childFn || !NPM_MULTICALL_CHILD_SIGNATURES.includes(childFn.signature) || childFn.executionScope || !scope.allowedChildren.some((child) => child.capabilityId === childFn.capabilityId && child.signature === childFn.signature && child.abiHash.toLowerCase() === functionAbiHash(childFn))) this.deny('DEFI_FUNCTION_NOT_ALLOWED', context, rootFn);
      const interaction: DefiInteraction = { to: root.to, data, value: root.value };
      this.assertCanonicalCall(interaction, childFn, context);
      nodes.push(deepFreeze({ path: [...path, childIndex], data: data.toLowerCase() as `0x${string}`, match: toMatch(childFn, root.value as string) }));
    }
    return nodes;
  }

  private decodeCanonicalArgs(interaction: DefiInteraction, fn: DefiFunctionPolicy, context: DefiExecutionContext): readonly unknown[] {
    try {
      const decoded = decodeFunctionData({ abi: [fn.abi], data: interaction.data as `0x${string}` });
      const canonical = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: decoded.args } as never);
      if (decoded.functionName !== fn.functionName || canonical.toLowerCase() !== interaction.data.toLowerCase()) this.deny('DEFI_INVALID_PARAMETERS', context, fn);
      return decoded.args as readonly unknown[];
    } catch (error) { if (error instanceof DefiPolicyDenial) throw error; this.deny('DEFI_INVALID_PARAMETERS', context, fn); }
  }

  private async readPauseState(context: DefiExecutionContext, fn: DefiFunctionPolicy) {
    try {
      const state = await this.prisma.defiPolicyState.findUnique({ where: { id: 'global' } });
      if (!state) this.deny('DEFI_POLICY_UNAVAILABLE', context, fn);
      return state;
    } catch (error) { if (error instanceof DefiPolicyDenial) throw error; this.deny('DEFI_POLICY_UNAVAILABLE', context, fn); }
  }

  private deny(code: string, context?: DefiExecutionContext, fn?: DefiFunctionPolicy, details?: { contract?: string; functionSelector?: string }): never {
    const status = code === 'DEFI_POLICY_UNAVAILABLE' ? 503 : 403;
    const match = fn ? toMatch(fn) : undefined;
    throw new DefiPolicyDenial(new HttpException({ code, message: 'DeFi policy denied' }, status), {
      context, code, capabilityId: match?.capabilityId, type: match?.type, chainId: match?.chainId ?? context?.chainId,
      contract: match?.contract ?? details?.contract, functionSignature: match?.functionSignature, functionSelector: details?.functionSelector,
      abiHash: match?.abiHash, policy: match?.policy,
    });
  }
}

export function buildDefiRequestCommitment(interactions: readonly DefiInteraction[], context: DefiExecutionContext, manifestHash: `0x${string}`): `0x${string}` {
  const calls = interactions.map((interaction) => ({ to: interaction.to.toLowerCase(), data: interaction.data.toLowerCase(), value: nativeValueText(interaction.value) }));
  const identity = {
    userId: context.userId, apiKeyId: context.apiKeyId, apiKeyPrefix: context.apiKeyPrefix ?? null, walletId: context.walletId,
    chainId: context.chainId, executionMode: context.executionMode, executionOwner: context.executionOwner.toLowerCase(),
    allowedCapabilityIds: [...context.allowedCapabilityIds].sort(),
  };
  return keccak256(stringToHex(JSON.stringify({ interactions: calls, context: identity, manifestHash })));
}

function parseNativeValue(value: DefiInteraction['value'], context: DefiExecutionContext, fn?: DefiFunctionPolicy): bigint {
  let parsed: bigint;
  try {
    if (value === undefined) parsed = 0n;
    else if (typeof value === 'bigint') parsed = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
    else if (typeof value === 'string' && /^\d+$/.test(value)) parsed = BigInt(value);
    else return denyNativeValue(context, fn);
  } catch { return denyNativeValue(context, fn); }
  if (parsed < 0n || parsed > MAX_UINT256) return denyNativeValue(context, fn);
  return parsed;
}

function denyNativeValue(context: DefiExecutionContext, fn?: DefiFunctionPolicy): never {
  if (!fn) return denyShape(context);
  throw new DefiPolicyDenial(new HttpException({ code: 'DEFI_INVALID_PARAMETERS', message: 'DeFi policy denied' }, 403), { context, code: 'DEFI_INVALID_PARAMETERS', capabilityId: fn.capabilityId, type: fn.type, chainId: fn.chainId, contract: fn.contract, functionSignature: fn.signature, abiHash: functionAbiHash(fn), policy: fn.policy });
}

function nativeValueText(value: DefiInteraction['value']): string {
  if (value === undefined) return '0';
  try { return BigInt(value).toString(); } catch { return String(value); }
}

function normalizeInteraction(interaction: DefiInteraction, context: DefiExecutionContext): DefiInteraction {
  if (!interaction || typeof interaction !== 'object' || typeof interaction.to !== 'string' || typeof interaction.data !== 'string') return denyShape(context);
  const value = parseNativeValue(interaction.value, context);
  return { to: interaction.to, data: interaction.data, value: value.toString() };
}

function denyShape(context: DefiExecutionContext): never {
  throw new DefiPolicyDenial(new HttpException({ code: 'DEFI_INVALID_PARAMETERS', message: 'DeFi policy denied' }, 403), { context, code: 'DEFI_INVALID_PARAMETERS', chainId: context.chainId });
}

function sameMatch(actual: DefiMatch, expected: DefiMatch): boolean {
  return actual.capabilityId === expected.capabilityId && actual.type === expected.type && actual.chainId === expected.chainId && actual.contract.toLowerCase() === expected.contract.toLowerCase() && actual.functionSignature === expected.functionSignature && actual.abiHash === expected.abiHash && actual.executionScopeHash === expected.executionScopeHash && actual.nativeValue === expected.nativeValue && JSON.stringify(actual.policy ?? null) === JSON.stringify(expected.policy ?? null);
}

function toMatch(fn: DefiFunctionPolicy, nativeValue?: string): DefiMatch {
  return deepFreeze({ capabilityId: fn.capabilityId, type: fn.type, chainId: fn.chainId, contract: fn.contract, functionSignature: fn.signature, abiHash: functionAbiHash(fn), ...(fn.executionScope ? { executionScopeHash: executionScopeHash(fn.executionScope) } : {}), ...(nativeValue !== undefined ? { nativeValue } : {}), ...(fn.policy ? { policy: cloneValue(fn.policy) } : {}) });
}

function freezeClone<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeClone)) as T;
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeClone(item)]))) as T;
  return value;
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)])) as T;
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as object).forEach(deepFreeze);
  }
  return value;
}

function isPaused(state: { pausedScopeKeys: string[] }, fn: DefiFunctionPolicy): boolean {
  const paused = new Set(state.pausedScopeKeys);
  return defiPauseScopeKeysForCapability(fn).some((scopeKey) => paused.has(scopeKey));
}

function safeFunctionSelector(data: string): string | undefined {
  return /^0x[0-9a-f]{8}/i.test(data) ? data.slice(0, 10).toLowerCase() : undefined;
}
