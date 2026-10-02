import { HttpException, Inject, Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  http,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type PublicClient,
} from 'viem';
import { getSupportedChain } from '../../../common/chains/supported-chains';
import { DEFI_MANIFEST, REVIEWED_ZEPPELINOS_IMPLEMENTATION_SLOT } from '../registry/defi-manifest';
import type {
  ReviewedAsset,
  ReviewedDeployment,
  ReviewedManifest,
  ReviewedMarket,
  ReviewedPool,
  ReviewedPriceFeed,
} from '../registry/defi-manifest.types';
import type { DefiAuthorization, DefiEvidence } from '../defi.types';
import { DefiPolicyDenial } from '../defi.types';
import { assertDefiEvidenceFresh, buildDefiPolicyIdentityHash, buildDefiRequestCommitment } from '../defi-policy.service';

const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
export const MAX_CHAIN_HEAD_AGE_MS = 30_000;
export const MAX_CHAIN_HEAD_FUTURE_SKEW_MS = 15_000;
const ERC20_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
const FEED_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'description', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'aggregator', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [], outputs: [{ name: 'roundId', type: 'uint80' }, { name: 'answer', type: 'int256' }, { name: 'startedAt', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' }, { name: 'answeredInRound', type: 'uint80' }] },
] as const;
const SEQUENCER_ABI = [FEED_ABI[3]] as const;
const FACTORY_ABI = [{ type: 'function', name: 'getPool', stateMutability: 'view', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'fee', type: 'uint24' }], outputs: [{ type: 'address' }] }] as const;
const POOL_ABI = [
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
  { type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'liquidity', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
] as const;
const AAVE_POOL_ABI = [
  { type: 'function', name: 'getReserveData', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [
    { name: 'configuration', type: 'tuple', components: [{ name: 'data', type: 'uint256' }] },
    { name: 'liquidityIndex', type: 'uint128' }, { name: 'currentLiquidityRate', type: 'uint128' }, { name: 'variableBorrowIndex', type: 'uint128' }, { name: 'currentVariableBorrowRate', type: 'uint128' }, { name: 'currentStableBorrowRate', type: 'uint128' }, { name: 'lastUpdateTimestamp', type: 'uint40' }, { name: 'id', type: 'uint16' }, { name: 'aTokenAddress', type: 'address' }, { name: 'stableDebtTokenAddress', type: 'address' }, { name: 'variableDebtTokenAddress', type: 'address' }, { name: 'interestRateStrategyAddress', type: 'address' }, { name: 'accruedToTreasury', type: 'uint128' }, { name: 'unbacked', type: 'uint128' }, { name: 'isolationModeTotalDebt', type: 'uint128' },
  ] },
  { type: 'function', name: 'getUserAccountData', stateMutability: 'view', inputs: [{ name: 'user', type: 'address' }], outputs: [{ name: 'totalCollateralBase', type: 'uint256' }, { name: 'totalDebtBase', type: 'uint256' }, { name: 'availableBorrowsBase', type: 'uint256' }, { name: 'currentLiquidationThreshold', type: 'uint256' }, { name: 'ltv', type: 'uint256' }, { name: 'healthFactor', type: 'uint256' }] },
] as const;

/** Read-only chain evidence; never performs sends, simulations, or provider calls. */
@Injectable()
export class DefiEvidenceService {
  private readonly clients = new Map<number, PublicClient>();
  private readonly authorizationContext = new AsyncLocalStorage<DefiAuthorization['context']>();

  constructor(
    private readonly config: ConfigService,
    @Inject(DEFI_MANIFEST) private readonly manifest: ReviewedManifest,
  ) {}

  async verify(authorization: DefiAuthorization): Promise<DefiEvidence> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.authorizationContext.run(authorization.context, () => this.verifyOnce(authorization)),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new DefiPolicyDenial(new HttpException({ code: 'DEFI_POLICY_UNAVAILABLE', message: 'DeFi policy denied' }, 503), { context: authorization.context, code: 'DEFI_POLICY_UNAVAILABLE' })), 30_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async verifyOnce(authorization: DefiAuthorization): Promise<DefiEvidence> {
    const observedAtMs = Date.now();
    try {
      const { context } = authorization;
      const manifest = this.manifest;
      if (!isDeepFrozen(manifest) || manifest.manifestHash !== authorization.manifestHash || !/^0x[0-9a-f]{64}$/i.test(manifest.manifestHash)) this.unavailable();
      if (buildDefiRequestCommitment(authorization.interactions, context, manifest.manifestHash) !== authorization.requestCommitment || authorization.interactions.length !== authorization.matches.length || authorization.interactions.length !== authorization.batchPlan.effects.length) this.unavailable();
      if (buildDefiPolicyIdentityHash(authorization.matches) !== authorization.policyIdentityHash) this.unavailable();
      if (!isAddress(context.executionOwner, { strict: false }) || !authorization.context.allowedCapabilityIds || authorization.matches.some((match) => !authorization.context.allowedCapabilityIds.includes(match.capabilityId))) this.unavailable();
      for (let index = 0; index < authorization.matches.length; index++) {
        const match = authorization.matches[index];
        const fn = this.functionFor(manifest, match.capabilityId);
        const interaction = authorization.interactions[index];
        const chainEntry = manifest.chains.find((chain) => chain.chainId === context.chainId && chain.status === 'active');
        const contractEntry = chainEntry?.contracts.find((contract) => contract.status === 'active' && contract.address.toLowerCase() === match.contract.toLowerCase());
        const catalogFn = contractEntry?.functions.find((candidate) => candidate.capabilityId === fn?.capabilityId);
        if (!fn || fn.status !== 'active' || fn.chainId !== context.chainId || fn.contract.toLowerCase() !== match.contract.toLowerCase() || fn.signature !== match.functionSignature || fn.policy.ref !== match.policy.ref || fn.policy.version !== match.policy.version || interaction.to.toLowerCase() !== fn.contract.toLowerCase() || !catalogFn || catalogFn.status !== 'active' || catalogFn.chainId !== fn.chainId || catalogFn.contract.toLowerCase() !== fn.contract.toLowerCase() || catalogFn.signature !== fn.signature || catalogFn.policy.ref !== fn.policy.ref || catalogFn.policy.version !== fn.policy.version || catalogFn.validate !== fn.validate || catalogFn.describe !== fn.describe || canonicalEvidence(catalogFn.abi) !== canonicalEvidence(fn.abi)) this.unavailable();
        const effect = authorization.batchPlan.effects[index];
        if (!effect || effect.index !== index) this.unavailable();
        const decoded = decodeFunctionData({ abi: [fn.abi], data: interaction.data as `0x${string}` });
        if (decoded.functionName !== fn.functionName || encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: decoded.args as never }).toLowerCase() !== interaction.data.toLowerCase() || !fn.validate(decoded.args, context)) this.unavailable();
        const described = fn.describe(decoded.args, context, index);
        if (canonicalEvidence(described) !== canonicalEvidence(effect)) this.unavailable();
        if (effect.kind === 'approval') {
          const approval = fn.approval;
          const approvedSpend = [...(approval?.spenderRefs ?? []), ...(approval?.spenderRef ? [approval.spenderRef] : [])];
          const token = manifest.assets.find((asset) => asset.ref === approval?.tokenRef);
          const spender = manifest.deployments.find((deployment) => approvedSpend.includes(deployment.ref) && deployment.address.toLowerCase() === effect.spender.toLowerCase());
          if (fn.functionName !== 'approve' || fn.signature !== 'approve(address,uint256)' || !token || token.address.toLowerCase() !== effect.token.toLowerCase() || !spender) this.unavailable();
        } else if (effect.operation === 'swap') {
          if (fn.functionName !== 'exactInputSingle' || !['uniswap-v3', 'pancakeswap-v3'].includes(fn.protocol ?? '') || fn.operation !== 'exact-input-single' || !effect.swap || !(fn.manifestRefs?.pools ?? []).includes(effect.swap.poolRef)) this.unavailable();
        } else {
          const market = manifest.markets.find((item) => item.deploymentRef === effect.deploymentRef && item.chainId === context.chainId);
          const signatures: Record<string, string> = { supply: 'supply(address,uint256,address,uint16)', withdraw: 'withdraw(address,uint256,address)', repay: 'repay(address,uint256,uint256,address)' };
          if (!market || !/^aave:/i.test(effect.deploymentRef) || !['supply', 'withdraw', 'repay'].includes(effect.operation) || fn.protocol !== 'Aave V3' || fn.functionName !== effect.operation || fn.signature !== signatures[effect.operation]) this.unavailable();
        }
      }
      const client = this.client(context.chainId);
      const actualChain = await client.getChainId();
      if (actualChain !== context.chainId) this.unavailable();
      const block = await client.getBlock({ blockTag: 'latest' });
      if (!block.hash || block.number === null || block.timestamp === null) this.unavailable();
      const blockTimeMs = Number(block.timestamp) * 1000;
      if (!Number.isSafeInteger(blockTimeMs) || observedAtMs - blockTimeMs > MAX_CHAIN_HEAD_AGE_MS || blockTimeMs - observedAtMs > MAX_CHAIN_HEAD_FUTURE_SKEW_MS) this.unavailable();
      const blockNumber = block.number;
      const blockHash = block.hash;
      const ensureWithinEvidenceWindow = () => { if (Date.now() - observedAtMs >= MAX_CHAIN_HEAD_AGE_MS) this.unavailable(); };
      const checks: string[] = [`chain:${actualChain}`, `block:${blockNumber}:${blockHash}`];
      const assets = this.resolveRefs(manifest.assets, authorization.matches.flatMap((m) => this.functionFor(manifest, m.capabilityId)?.manifestRefs?.assets ?? []), context.chainId, 'asset');
      const deployments = this.resolveRefs(manifest.deployments, authorization.matches.flatMap((m) => this.functionFor(manifest, m.capabilityId)?.manifestRefs?.deployments ?? []), context.chainId, 'deployment');
      const feeds = this.resolveRefs(manifest.priceFeeds, authorization.matches.flatMap((m) => this.functionFor(manifest, m.capabilityId)?.manifestRefs?.priceFeeds ?? []), context.chainId, 'feed');
      const pools = this.resolveRefs(manifest.pools, authorization.matches.flatMap((m) => this.functionFor(manifest, m.capabilityId)?.manifestRefs?.pools ?? []), context.chainId, 'pool');
      const marketRefs = authorization.matches.flatMap((m) => this.functionFor(manifest, m.capabilityId)?.manifestRefs?.deployments ?? []);
      const markets = (manifest.markets ?? []).filter((m) => marketRefs.includes(m.deploymentRef) && m.chainId === context.chainId);
      for (const d of deployments) { ensureWithinEvidenceWindow(); await this.checkDeployment(client, d, blockNumber, checks); }
      for (const a of assets) { ensureWithinEvidenceWindow(); await this.checkAsset(client, a, context.executionOwner as Address, blockNumber, checks); }
      const prices = new Map<string, { answer: bigint; decimals: number }>();
      for (const feed of feeds) { ensureWithinEvidenceWindow(); prices.set(feed.ref, await this.checkFeed(client, feed, manifest, blockNumber, block.timestamp, checks)); }
      for (const pool of pools) { ensureWithinEvidenceWindow(); await this.checkPool(client, pool, manifest, blockNumber, checks); }
      const nonSwapEffects = authorization.batchPlan.effects.filter((effect) => effect.kind === 'action' && effect.operation !== 'swap');
      if (nonSwapEffects.some((effect) => effect.kind === 'action' && !markets.some((market) => market.deploymentRef === effect.deploymentRef))) this.unavailable();
      for (const market of markets) { ensureWithinEvidenceWindow(); await this.checkAave(client, market, manifest, authorization, blockNumber, checks); }
      ensureWithinEvidenceWindow();
      await this.checkFundingAndApprovals(client, authorization, assets, blockNumber, checks);
      for (const effect of authorization.batchPlan.effects) {
        if (effect.kind === 'action' && effect.operation === 'swap') {
          if (!effect.swap) this.unavailable();
          this.checkSwap(effect, manifest, prices, observedAtMs, block.timestamp, checks);
        }
      }
      const confirmedBlock = await client.getBlock({ blockNumber });
      if (confirmedBlock.hash !== blockHash) this.unavailable();
       if (Date.now() - observedAtMs >= MAX_CHAIN_HEAD_AGE_MS) this.unavailable();
      const evidence: DefiEvidence = Object.freeze({
        requestCommitment: authorization.requestCommitment,
        manifestHash: manifest.manifestHash,
        chainId: context.chainId,
        executionOwner: context.executionOwner.toLowerCase(),
        blockNumber,
        blockHash,
        observedAtMs,
         expiresAtMs: observedAtMs + MAX_CHAIN_HEAD_AGE_MS,
        checksDigest: keccak256(stringToHex(checks.sort().join('\n'))),
      });
      assertDefiEvidenceFresh(authorization, evidence, Date.now(), manifest.manifestHash);
      return evidence;
    } catch (error) {
      if (error instanceof DefiPolicyDenial) {
        if (error.audit.context || !this.authorizationContext.getStore()) throw error;
        throw new DefiPolicyDenial(error.httpException, { ...error.audit, context: this.authorizationContext.getStore() });
      }
      this.unavailable();
    }
  }

  assertFresh(authorization: DefiAuthorization, evidence: DefiEvidence): void {
    try { assertDefiEvidenceFresh(authorization, evidence, Date.now(), this.manifest.manifestHash); }
    catch (error) { if (error instanceof DefiPolicyDenial) throw error; this.unavailable(); }
  }

  private client(chainId: number): PublicClient {
    const existing = this.clients.get(chainId);
    if (existing) return existing;
    const rpcUrl = this.config.get<string>(`simulation.rpcUrls.${chainId}`);
    if (!rpcUrl || !/^https:\/\//i.test(rpcUrl)) this.unavailable();
    const client = createPublicClient({ chain: getSupportedChain(chainId).chain, transport: http(rpcUrl, { timeout: 5_000, retryCount: 0 }) });
    this.clients.set(chainId, client);
    return client;
  }

  private resolveRefs<T extends { ref: string; chainId: number }>(all: readonly T[], refs: readonly string[], chainId: number, kind: string): T[] {
    const out: T[] = [];
    for (const ref of [...new Set(refs)]) {
      const row = all.find((candidate) => candidate.ref === ref);
      if (!row || row.chainId !== chainId) this.unavailable();
      out.push(row);
    }
    if (refs.length === 0 && kind === 'deployment') this.unavailable();
    return out;
  }

  private functionFor(manifest: ReviewedManifest, id: string) {
    return manifest.capabilities.find((fn) => fn.capabilityId === id);
  }

  private async code(client: PublicClient, address: Address, block: bigint, expected?: `0x${string}`): Promise<`0x${string}`> {
    const code = await client.getCode({ address, blockNumber: block });
    if (!code || code === '0x' || (expected && keccak256(code) !== expected)) this.unavailable();
    return code;
  }

  private async checkDeployment(client: PublicClient, deployment: ReviewedDeployment, block: bigint, checks: string[]): Promise<void> {
    if (deployment.status === 'candidate' || !deployment.runtimeCodeHash || !deployment.verificationRef) this.unavailable();
    await this.code(client, deployment.address as Address, block, deployment.runtimeCodeHash);
    checks.push(`deployment:${deployment.ref}:${deployment.runtimeCodeHash}`);
    if (deployment.proxy) {
      if (!deployment.proxy.implementationCodeHash) this.unavailable();
      const slotName = deployment.proxy.kind === 'eip1967'
        ? IMPLEMENTATION_SLOT
        : deployment.proxy.kind === 'zeppelinos'
          ? REVIEWED_ZEPPELINOS_IMPLEMENTATION_SLOT
          : undefined;
      if (!slotName) this.unavailable();
      const slot = await client.getStorageAt({ address: deployment.address as Address, slot: slotName, blockNumber: block });
      const implementation = slot ? `0x${slot.slice(-40)}`.toLowerCase() : '';
      if (implementation !== deployment.proxy.implementation.toLowerCase()) this.unavailable();
      await this.code(client, deployment.proxy.implementation as Address, block, deployment.proxy.implementationCodeHash);
      const alternateImplementation = await client.getStorageAt({ address: deployment.address as Address, slot: deployment.proxy.kind === 'eip1967' ? REVIEWED_ZEPPELINOS_IMPLEMENTATION_SLOT : IMPLEMENTATION_SLOT, blockNumber: block });
      if (alternateImplementation && BigInt(alternateImplementation) !== 0n) this.unavailable();
      const beacon = await client.getStorageAt({ address: deployment.address as Address, slot: BEACON_SLOT, blockNumber: block });
      if (beacon && BigInt(beacon) !== 0n) this.unavailable();
      checks.push(`implementation:${deployment.ref}:${implementation}:${deployment.proxy.implementationCodeHash}`);
    } else {
      const implementation = await client.getStorageAt({ address: deployment.address as Address, slot: IMPLEMENTATION_SLOT, blockNumber: block });
      const beacon = await client.getStorageAt({ address: deployment.address as Address, slot: BEACON_SLOT, blockNumber: block });
      const zeppelinImplementation = await client.getStorageAt({ address: deployment.address as Address, slot: REVIEWED_ZEPPELINOS_IMPLEMENTATION_SLOT, blockNumber: block });
      if ((implementation && BigInt(implementation) !== 0n) || (beacon && BigInt(beacon) !== 0n) || (zeppelinImplementation && BigInt(zeppelinImplementation) !== 0n)) this.unavailable();
    }
    for (const identity of deployment.identityChecks) {
      const actual = await this.readIdentity(client, deployment, identity, block);
      if (actual.toLowerCase() !== identity.expected.toLowerCase()) this.unavailable();
      checks.push(`identity:${deployment.ref}:${identity.getter}:${actual.toLowerCase()}`);
    }
  }

  private async readIdentity(client: PublicClient, deployment: ReviewedDeployment, identity: ReviewedDeployment['identityChecks'][number], block: bigint): Promise<string> {
    const address = deployment.address as Address;
    const getter = identity.getter;
    const identityArgs = (identity as typeof identity & { args?: readonly (string | number)[] }).args;
    if (getter !== 'getPool(address,address,uint24)' && identityArgs !== undefined) this.unavailable();
    if (getter === 'factory()' || getter === 'WETH9()' || getter === 'asset()' || getter === 'underlying()' || getter === 'aToken()') {
      const name = getter.slice(0, -2);
      return String(await client.readContract({ address, abi: [{ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }], functionName: name, blockNumber: block } as never));
    }
    if (getter === 'getPoolAddressesProvider()' || getter === 'getAddressesProvider()') {
      const name = getter.slice(0, -2);
      return String(await client.readContract({ address, abi: [{ type: 'function', name, stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }], functionName: name, blockNumber: block } as never));
    }
    if (getter === 'token0()' || getter === 'token1()') return String(await client.readContract({ address, abi: POOL_ABI, functionName: getter.slice(0, -2) as 'token0' | 'token1', blockNumber: block }));
    if (getter === 'fee()') return String(await client.readContract({ address, abi: POOL_ABI, functionName: 'fee', blockNumber: block }));
    if (getter === 'getPool(address,address,uint24)') {
      const args = identityArgs;
      if (!args || args.length !== 3 || typeof args[0] !== 'string' || typeof args[1] !== 'string' || !isAddress(args[0], { strict: false }) || !isAddress(args[1], { strict: false }) || typeof args[2] !== 'number' || !Number.isInteger(args[2]) || args[2] < 0 || args[2] > 0xffffff || !isAddress(identity.expected, { strict: false })) this.unavailable();
      const pool = await client.readContract({ address, abi: FACTORY_ABI, functionName: 'getPool', args: [args[0] as Address, args[1] as Address, args[2]], blockNumber: block });
      return String(pool);
    }
    if (getter === 'decimals()') {
      return String(await client.readContract({ address, abi: ERC20_ABI, functionName: 'decimals', blockNumber: block }));
    }
    if (getter === 'symbol()') return String(await client.readContract({ address, abi: ERC20_ABI, functionName: 'symbol', blockNumber: block }));
    if (getter === 'aggregator()') return String(await client.readContract({ address, abi: FEED_ABI, functionName: 'aggregator', blockNumber: block }));
    this.unavailable();
  }

  private async checkAsset(client: PublicClient, asset: ReviewedAsset, owner: Address, block: bigint, checks: string[]): Promise<void> {
    const deployment = this.manifest.deployments.find((item) => item.ref === asset.deploymentRef);
    if (!deployment || deployment.chainId !== asset.chainId) this.unavailable();
    await this.checkDeployment(client, deployment, block, checks);
    const code = await this.code(client, asset.address as Address, block, deployment.runtimeCodeHash);
    const decimals = await client.readContract({ address: asset.address as Address, abi: ERC20_ABI, functionName: 'decimals', blockNumber: block });
    if (decimals !== asset.decimals) this.unavailable();
    checks.push(`asset:${asset.ref}:${keccak256(code)}:${decimals}`);
    const bal = await client.readContract({ address: asset.address as Address, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner], blockNumber: block });
    checks.push(`balance:${asset.ref}:${owner.toLowerCase()}:${bal}`);
  }

  private async checkFeed(client: PublicClient, feed: ReviewedPriceFeed, manifest: ReviewedManifest, block: bigint, blockTimestamp: bigint, checks: string[]): Promise<{ answer: bigint; decimals: number }> {
    const asset = manifest.assets.find((item) => item.ref === feed.asset);
    if (!asset) this.unavailable();
    const feedDeployment = manifest.deployments.find((item) => item.ref === feed.deploymentRef);
    if (!feedDeployment || feedDeployment.address.toLowerCase() !== feed.feed.toLowerCase()) this.unavailable();
    const code = await this.code(client, feed.feed as Address, block, feedDeployment.runtimeCodeHash);
    const [decimals, description, round, aggregator] = await Promise.all([
      client.readContract({ address: feed.feed as Address, abi: FEED_ABI, functionName: 'decimals', blockNumber: block }),
      client.readContract({ address: feed.feed as Address, abi: FEED_ABI, functionName: 'description', blockNumber: block }),
      client.readContract({ address: feed.feed as Address, abi: FEED_ABI, functionName: 'latestRoundData', blockNumber: block }),
      client.readContract({ address: feed.feed as Address, abi: FEED_ABI, functionName: 'aggregator', blockNumber: block }),
    ]);
    const [roundId, answer, startedAt, updatedAt] = round;
    const answeredInRound = round[4];
    const normalized = String(description).replace(/\s+/g, '').toLowerCase();
    const expected = `${asset.symbol === 'WETH' ? 'ETH' : asset.symbol}/USD`.toLowerCase();
    if (decimals !== feed.decimals || normalized !== expected || answer <= 0n || startedAt === 0n || updatedAt === 0n || startedAt > blockTimestamp || updatedAt > blockTimestamp || blockTimestamp - updatedAt > BigInt(feed.maxAgeSeconds) || roundId === 0n || answeredInRound < roundId) this.unavailable();
    const agg = aggregator as Address;
    const aggDeployment = manifest.deployments.find((item) => item.address.toLowerCase() === agg.toLowerCase() && item.chainId === feed.chainId && item.status !== 'candidate' && item.runtimeCodeHash && item.verificationRef);
    if (!aggDeployment || !feedDeployment.identityChecks.some((identity) => identity.getter === 'aggregator()' && identity.expected.toLowerCase() === agg.toLowerCase())) this.unavailable();
    const aggCode = await this.code(client, agg, block, aggDeployment.runtimeCodeHash);
    checks.push(`feed:${feed.ref}:${keccak256(code)}:${decimals}:${answer}:${updatedAt}:${agg.toLowerCase()}:${keccak256(aggCode)}`);
    if (feed.sequencerCheckRef) await this.checkSequencer(client, feed.sequencerCheckRef, manifest, block, blockTimestamp, checks);
    return { answer, decimals };
  }

  private async checkSequencer(client: PublicClient, ref: string, manifest: ReviewedManifest, block: bigint, blockTimestamp: bigint, checks: string[]): Promise<void> {
    const feed = manifest.priceFeeds.find((item) => item.ref === ref);
    if (!feed) this.unavailable();
    const deployment = manifest.deployments.find((item) => item.ref === feed.deploymentRef && item.address.toLowerCase() === feed.feed.toLowerCase());
    if (!deployment || !deployment.runtimeCodeHash || !deployment.verificationRef) this.unavailable();
    await this.checkDeployment(client, deployment, block, checks);
    const [roundId, answer, startedAt, updatedAt] = await client.readContract({ address: feed.feed as Address, abi: SEQUENCER_ABI, functionName: 'latestRoundData', blockNumber: block });
    if (roundId === 0n || answer !== 0n || startedAt === 0n || updatedAt === 0n || startedAt > blockTimestamp || updatedAt > blockTimestamp || blockTimestamp - startedAt <= 3600n) this.unavailable();
    checks.push(`sequencer:${ref}:${roundId}:${answer}:${startedAt}`);
  }

  private async checkPool(client: PublicClient, pool: ReviewedPool, manifest: ReviewedManifest, block: bigint, checks: string[]): Promise<void> {
    const deployment = manifest.deployments.find((d) => d.ref === pool.deploymentRef);
    const factory = pool.factoryRef && manifest.deployments.find((d) => d.ref === pool.factoryRef);
    const input = pool.tokenInRef && manifest.assets.find((a) => a.ref === pool.tokenInRef);
    const output = pool.tokenOutRef && manifest.assets.find((a) => a.ref === pool.tokenOutRef);
    if (!deployment || !factory || !input || !output || !Number.isInteger(pool.fee)) this.unavailable();
    await this.code(client, deployment.address as Address, block, pool.runtimeCodeHash ?? deployment.runtimeCodeHash);
    await this.code(client, factory.address as Address, block, factory.runtimeCodeHash);
    const found = await client.readContract({ address: factory.address as Address, abi: FACTORY_ABI, functionName: 'getPool', args: [input.address as Address, output.address as Address, pool.fee!], blockNumber: block });
    if (found.toLowerCase() !== deployment.address.toLowerCase()) this.unavailable();
    const [t0,t1,fee,poolFactory,liquidity] = await Promise.all([
      client.readContract({ address: deployment.address as Address, abi: POOL_ABI, functionName: 'token0', blockNumber: block }),
      client.readContract({ address: deployment.address as Address, abi: POOL_ABI, functionName: 'token1', blockNumber: block }),
      client.readContract({ address: deployment.address as Address, abi: POOL_ABI, functionName: 'fee', blockNumber: block }),
      client.readContract({ address: deployment.address as Address, abi: POOL_ABI, functionName: 'factory', blockNumber: block }),
      client.readContract({ address: deployment.address as Address, abi: POOL_ABI, functionName: 'liquidity', blockNumber: block }),
    ]);
    const [expected0, expected1] = [input.address.toLowerCase(), output.address.toLowerCase()].sort();
    if (t0.toLowerCase() !== expected0 || t1.toLowerCase() !== expected1 || fee !== pool.fee || poolFactory.toLowerCase() !== factory.address.toLowerCase() || liquidity === 0n) this.unavailable();
    checks.push(`pool:${pool.ref}:${deployment.address.toLowerCase()}:${liquidity}`);
  }

  private async checkAave(client: PublicClient, market: ReviewedMarket, manifest: ReviewedManifest, authorization: DefiAuthorization, block: bigint, checks: string[]): Promise<void> {
    const pool = manifest.deployments.find((d) => d.ref === market.deploymentRef);
    if (!pool || !/^aave:/i.test(pool.ref) || market.marketRef?.toLowerCase() !== pool.address.toLowerCase()) this.unavailable();
    const action = authorization.batchPlan.effects.find((effect) => effect.kind === 'action' && effect.deploymentRef === market.deploymentRef);
    if (!action || action.kind !== 'action') return;
    const asset = manifest.assets.find((item) => item.address.toLowerCase() === action.token.toLowerCase());
    if (!asset || !market.assetRefs.includes(asset.ref)) this.unavailable();
    const reserve = await client.readContract({ address: pool.address as Address, abi: AAVE_POOL_ABI, functionName: 'getReserveData', args: [asset.address as Address], blockNumber: block });
    const config = reserve[0].data;
    const active = ((config >> 56n) & 1n) === 1n;
    const frozen = ((config >> 57n) & 1n) === 1n;
    const paused = ((config >> 60n) & 1n) === 1n;
    if (!active || frozen || paused) this.unavailable();
    const aTokenDeployment = manifest.deployments.find((item) => item.address.toLowerCase() === reserve[8].toLowerCase() && item.chainId === market.chainId && item.status !== 'candidate' && item.runtimeCodeHash && item.verificationRef);
    if (!aTokenDeployment) this.unavailable();
    await this.code(client, reserve[8] as Address, block, aTokenDeployment.runtimeCodeHash);
    if (action.operation === 'withdraw') {
      const [accountData, liquidity] = await Promise.all([
        client.readContract({ address: pool.address as Address, abi: AAVE_POOL_ABI, functionName: 'getUserAccountData', args: [authorization.context.executionOwner as Address], blockNumber: block }),
        client.readContract({ address: asset.address as Address, abi: ERC20_ABI, functionName: 'balanceOf', args: [reserve[8] as Address], blockNumber: block }),
      ]);
      const position = await client.readContract({ address: reserve[8] as Address, abi: ERC20_ABI, functionName: 'balanceOf', args: [authorization.context.executionOwner as Address], blockNumber: block });
      if (accountData[1] !== 0n || liquidity < action.amount || position < action.amount) this.unavailable();
      checks.push(`aave-withdraw:${market.ref}:${accountData[1]}:${liquidity}:${position}`);
    }
    if (action.operation === 'repay') {
      const variableDebtDeployment = manifest.deployments.find((item) => item.address.toLowerCase() === reserve[10].toLowerCase() && item.chainId === market.chainId && item.status !== 'candidate' && item.runtimeCodeHash && item.verificationRef);
      if (!variableDebtDeployment) this.unavailable();
      await this.code(client, reserve[10] as Address, block, variableDebtDeployment.runtimeCodeHash);
      const debt = await client.readContract({ address: reserve[10] as Address, abi: ERC20_ABI, functionName: 'balanceOf', args: [authorization.context.executionOwner as Address], blockNumber: block });
      if (debt <= 0n || action.amount > debt) this.unavailable();
      checks.push(`aave-repay:${market.ref}:${debt}`);
    }
    if (action.operation === 'supply') {
      const cap = (config >> 116n) & ((1n << 36n) - 1n);
      if (cap === 0n) this.unavailable();
      const [aTokenSupply, ownerBalance] = await Promise.all([
        client.readContract({ address: reserve[8] as Address, abi: [{ type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }], functionName: 'totalSupply', blockNumber: block }),
        client.readContract({ address: asset.address as Address, abi: ERC20_ABI, functionName: 'balanceOf', args: [authorization.context.executionOwner as Address], blockNumber: block }),
      ]);
      const capRaw = cap * 10n ** BigInt(asset.decimals);
      if (ownerBalance < action.amount || aTokenSupply + action.amount > capRaw) this.unavailable();
      checks.push(`aave-supply:${market.ref}:${ownerBalance}:${aTokenSupply}:${capRaw}`);
    }
    checks.push(`aave-reserve:${market.ref}:${asset.ref}:${config}`);
  }

  private async checkFundingAndApprovals(client: PublicClient, authorization: DefiAuthorization, assets: ReviewedAsset[], block: bigint, checks: string[]): Promise<void> {
    const owner = authorization.context.executionOwner as Address;
    const totals: Record<string, bigint> = { ...authorization.batchPlan.fundingTotals };
    if (authorization.context.executionMode === 'eoa') {
      for (const effect of authorization.batchPlan.effects) {
        if (effect.kind === 'action') totals[effect.token.toLowerCase()] = (totals[effect.token.toLowerCase()] ?? 0n) + effect.amount;
      }
    }
    const assetsByAddress = new Map(assets.map((asset) => [asset.address.toLowerCase(), asset]));
    const recomputedTotals: Record<string, bigint> = {};
    if (authorization.context.executionMode === 'eoa') {
      for (const effect of authorization.batchPlan.effects) if (effect.kind === 'action') {
        const key = effect.token.toLowerCase(); recomputedTotals[key] = (recomputedTotals[key] ?? 0n) + effect.amount;
      }
    } else {
      for (const effect of authorization.batchPlan.effects) if (effect.kind === 'approval' && effect.amount > 0n) {
        const key = effect.token.toLowerCase(); recomputedTotals[key] = (recomputedTotals[key] ?? 0n) + effect.amount;
      }
    }
    if (Object.keys(recomputedTotals).sort().join('|') !== Object.keys(totals).sort().join('|') || Object.entries(recomputedTotals).some(([key, value]) => totals[key] !== value)) this.unavailable();
    for (const [address, total] of Object.entries(totals)) {
      const asset = assetsByAddress.get(address.toLowerCase());
      if (!asset || total <= 0n || total > asset.maxOperationRaw) this.unavailable();
    }
    for (const effect of authorization.batchPlan.effects) {
      if (effect.kind !== 'action') continue;
      const asset = assetsByAddress.get(effect.token.toLowerCase());
      if (!asset || effect.amount <= 0n || effect.amount > asset.maxOperationRaw) this.unavailable();
    }
    for (const asset of assets) {
      const total = totals[asset.address.toLowerCase()] ?? 0n;
      if (total <= 0n) continue;
      const balance = await client.readContract({ address: asset.address as Address, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner], blockNumber: block });
      if (balance < total) this.unavailable();
      checks.push(`funding:${asset.ref}:${total}:${balance}`);
    }
    for (let index = 0; index < authorization.batchPlan.effects.length; index++) {
      const effect = authorization.batchPlan.effects[index];
      if (effect.kind !== 'approval') continue;
      const match = authorization.matches[index];
      const fn = match && this.functionFor(this.manifest, match.capabilityId);
      const registry = fn?.approval;
      const token = this.manifest.assets.find((asset) => asset.ref === registry?.tokenRef);
      const spenderRefs = [...(registry?.spenderRefs ?? []), ...(registry?.spenderRef ? [registry.spenderRef] : [])];
      const spender = this.manifest.deployments.find((deployment) => spenderRefs.includes(deployment.ref) && deployment.address.toLowerCase() === effect.spender.toLowerCase());
      if (!registry || !token || !spender || token.address.toLowerCase() !== effect.token.toLowerCase() || effect.amount > token.maxOperationRaw) this.unavailable();
      const approval = effect;
      const current = await client.readContract({ address: approval.token as Address, abi: ERC20_ABI, functionName: 'allowance', args: [owner, approval.spender as Address], blockNumber: block });
      const previous = authorization.batchPlan.effects[index - 1];
      if (approval.amount > 0n && current !== 0n && !(previous?.kind === 'approval' && previous.amount === 0n && previous.token.toLowerCase() === approval.token.toLowerCase() && previous.spender.toLowerCase() === approval.spender.toLowerCase())) this.unavailable();
      if (approval.amount === 0n && current === 0n) continue;
      checks.push(`allowance:${approval.token.toLowerCase()}:${approval.spender.toLowerCase()}:${current}`);
    }
    for (const effect of authorization.batchPlan.effects) {
      if (effect.kind !== 'action' || effect.funding || !['supply', 'repay'].includes(effect.operation)) continue;
      const market = this.manifest.markets.find((item) => item.deploymentRef === effect.deploymentRef && item.chainId === authorization.context.chainId);
      const deployment = market && this.manifest.deployments.find((item) => item.ref === market.deploymentRef);
      if (!deployment) this.unavailable();
      const allowance = await client.readContract({ address: effect.token as Address, abi: ERC20_ABI, functionName: 'allowance', args: [owner, deployment.address as Address], blockNumber: block });
      if (allowance < effect.amount) this.unavailable();
      checks.push(`action-allowance:${effect.token.toLowerCase()}:${deployment.address.toLowerCase()}:${allowance}`);
    }
  }

  private checkSwap(
    effect: Extract<DefiAuthorization['batchPlan']['effects'][number], { kind: 'action' }>,
    manifest: ReviewedManifest,
    prices: ReadonlyMap<string, { answer: bigint; decimals: number }>,
    observedAtMs: number,
    blockTimestamp: bigint,
    checks: string[],
  ): void {
    const swap = effect.swap!;
    if (swap.deadline * 1000n <= BigInt(observedAtMs) || swap.deadline * 1000n > BigInt(observedAtMs + 120_000)) this.unavailable();
    const pool = manifest.pools.find((item) => item.ref === swap.poolRef);
    const input = manifest.assets.find((asset) => asset.address.toLowerCase() === effect.token.toLowerCase());
    const output = manifest.assets.find((asset) => asset.address.toLowerCase() === swap.tokenOut.toLowerCase());
    if (!pool || !input || !output || pool.chainId !== input.chainId || input.chainId !== output.chainId || pool.tokenInRef !== input.ref || pool.tokenOutRef !== output.ref || !pool.factoryRef || !pool.deploymentRef || pool.routerRef !== effect.deploymentRef) this.unavailable();
    const inFeed = input.priceFeedRef && manifest.priceFeeds.find((feed) => feed.ref === input.priceFeedRef);
    const outFeed = output.priceFeedRef && manifest.priceFeeds.find((feed) => feed.ref === output.priceFeedRef);
    const pin = inFeed && prices.get(inFeed.ref); const pout = outFeed && prices.get(outFeed.ref);
    if (!inFeed || !outFeed || !pin || !pout || pin.answer <= 0n || pout.answer <= 0n || pin.decimals > 18 || pout.decimals > 18 || input.decimals > 36 || output.decimals > 36) this.unavailable();
    // q * Ain * 10^(dout+tokenOut) * 9900 / (Aout * 10^(din+tokenIn) * 10000), rounded up.
    const numerator = effect.amount * pin.answer * 10n ** BigInt(pout.decimals + output.decimals) * 9900n;
    const denominator = pout.answer * 10n ** BigInt(pin.decimals + input.decimals) * 10_000n;
    const minOut = (numerator + denominator - 1n) / denominator;
    if (swap.minOut < minOut) this.unavailable();
    checks.push(`swap:${input.ref}:${output.ref}:${minOut}:${swap.minOut}:${blockTimestamp}`);
  }

  private unavailable(): never {
    throw new DefiPolicyDenial(new HttpException({ code: 'DEFI_POLICY_UNAVAILABLE', message: 'DeFi policy denied' }, 503), { context: this.authorizationContext.getStore(), code: 'DEFI_POLICY_UNAVAILABLE' });
  }
}

function isDeepFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return true;
  if (seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => isDeepFrozen(child, seen));
}

function canonicalEvidence(value: unknown): string {
  if (typeof value === 'bigint') return `bigint:${value}`;
  if (Array.isArray(value)) return `[${value.map(canonicalEvidence).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${key}:${canonicalEvidence(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
