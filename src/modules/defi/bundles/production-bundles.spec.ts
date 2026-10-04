import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { encodeFunctionData } from 'viem';
import { DefiCatalogService } from '../defi-catalog.service';
import { DefiPolicyService } from '../defi-policy.service';
import { DefiPolicyDenial, defiPauseScopeKeysForCapability, type DefiFunctionPolicy } from '../defi.types';
import { PRODUCTION_DEFI_MANIFEST, PRODUCTION_DEFI_CATALOG } from '../registry/production-registry';
import { PRODUCTION_DEFI_CAPABILITY_BUNDLES } from './production-bundles';
import { capabilityBundleFingerprint } from './bundle.service';
import { DefiBundleService } from './bundle.service';
import { buildReviewedManifest } from '../registry/defi-manifest';

const OWNER = '0x0000000000000000000000000000000000000001';
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const flat = PRODUCTION_DEFI_MANIFEST.capabilities;
const addressValue = '0x0000000000000000000000000000000000000002';
type TestAbiParameter = { type: string; components?: readonly TestAbiParameter[] };

function sample(parameter: TestAbiParameter): unknown {
  if (parameter.type === 'address') return addressValue;
  if (parameter.type === 'bool') return false;
  if (parameter.type === 'bytes') return '0x';
  if (parameter.type === 'string') return '';
  if (parameter.type === 'bytes32') return `0x${'00'.repeat(32)}`;
  if (parameter.type.endsWith('[]')) return [];
  if (parameter.type.startsWith('tuple')) return (parameter.components ?? []).map(sample);
  if (/^(u?int)/.test(parameter.type)) return 1n;
  return addressValue;
}

function encoded(fn: DefiFunctionPolicy, overrides: Record<string, unknown> = {}): `0x${string}` {
  const args = fn.abi.inputs.map((input, index) => {
    if (Object.prototype.hasOwnProperty.call(overrides, String(index))) return overrides[String(index)];
    return sample(input as TestAbiParameter);
  });
  return encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName, args: args as never });
}

function makePolicy(pausedScopeKeys: string[] = []) {
  const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue({ id: 'global', pausedScopeKeys }) } };
  const catalog = new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST);
  return { policy: new DefiPolicyService(prisma as never, {} as never, catalog), prisma, catalog };
}

function catalogIds(path: string): string[] {
  const catalog = JSON.parse(readFileSync(path, 'utf8')) as { chains: Array<{ contracts: Array<{ functions: Array<{ capabilityId: string }> }> }> };
  return catalog.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => fn.capabilityId)));
}

function first20SourceIds(): string[] {
  const root = resolve(process.cwd(), 'data/defi-catalog');
  const before = catalogIds(resolve(root, 'v4/catalog.json'));
  const after = catalogIds(resolve(root, 'v5/catalog.json'));
  const existing = new Set(before);
  return after.filter((id) => !existing.has(id)).sort(cmp);
}

const phase2Builders = [
  ['ajna', 'buildAjnaErc20PoolRegistry'], ['bancor-v3', 'buildBancorV3Registry'],
  ['ekubo', 'buildEkuboRegistry'], ['enzyme', 'buildEnzymeRegistry'], ['exactly', 'buildExactlyRegistry'],
  ['gearbox-pool', 'buildGearboxPoolRegistry'], ['hashflow', 'buildHashflowRegistry'], ['izumi', 'buildIZumiRegistry'],
  ['integral', 'buildIntegralSizeRelayerRegistry'], ['lombard', 'buildLombardStakedLbtcRegistry'],
  ['liquity-v2', 'buildLiquityV2Registry'], ['puffer', 'buildPufferRegistry'], ['swell', 'buildSwellRegistry'],
  ['stakestone', 'buildStakeStoneRegistry'], ['solv', 'buildSolvRouterV2Registry'],
  ['stakedao', 'buildStakeDaoCrvDepositorRegistry'], ['eigenlayer', 'buildEigenLayerRegistry'],
  ['symbiotic', 'buildSymbioticRegistry'], ['harvest', 'buildHarvestRegistry'], ['idle', 'buildIdleRegistry'],
  ['origin', 'buildOriginOethRegistry'], ['sky', 'buildSkyRegistry'], ['frax', 'buildFraxRegistry'],
  ['ethena', 'buildEthenaRegistry'], ['usual', 'buildUsualRegistry'], ['angle', 'buildAngleRegistry'],
  ['lista', 'buildListaRegistry'],
] as const;

const phase3Builders = [
  ['one-inch', 'ONE_INCH_CAPABILITIES'], ['zero-x', 'ZERO_X_CAPABILITIES'], ['velora', 'VELORA_CAPABILITIES'],
  ['bebop', 'BEBOP_CAPABILITIES'], ['open-ocean', 'OPEN_OCEAN_CAPABILITIES'],
] as const;

function phase2CandidateManifest() {
  const fragments = phase2Builders.map(([directory, builder]) => {
    const module = require(`../registry/${directory}`) as Record<string, () => unknown>;
    return module[builder]();
  });
  return buildReviewedManifest(fragments as never[]);
}

function phase3CandidateCapabilities(): DefiFunctionPolicy[] {
  return phase3Builders.flatMap(([directory, exportName]) => {
    const module = require(`../registry/${directory}`) as Record<string, DefiFunctionPolicy[]>;
    return module[exportName];
  });
}

describe('published production profiles', () => {
  it('pins the actual production manifest inventory and all literal fingerprints', () => {
    expect(flat).toHaveLength(668);
    expect(flat.filter((fn) => fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).toHaveLength(23);
    expect(flat.filter((fn) => fn.type === 'contract_call' && !(fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)'))).toHaveLength(645);
    expect(flat.filter((fn) => fn.executionScope)).toHaveLength(15);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES).toHaveLength(67);
    const ids = new Set<string>();
    for (const bundle of PRODUCTION_DEFI_CAPABILITY_BUNDLES) {
      expect(bundle.version).toBe('1.0.0');
      expect(bundle.chainIds).toHaveLength(1);
      if (PRODUCTION_DEFI_CAPABILITY_BUNDLES.indexOf(bundle) < 12) {
        expect(bundle.capabilityIds).toHaveLength(bundle.bundleId.startsWith('uniswap-v3-') ? 9 : bundle.bundleId === 'curve-3pool-1' ? 4 : bundle.bundleId === 'pancakeswap-v3-positions-56' ? 9 : bundle.bundleId === 'yearn-tokenized-strategy-1' ? 6 : 6);
      } else if (PRODUCTION_DEFI_CAPABILITY_BUNDLES.indexOf(bundle) < 33) {
        expect(bundle.capabilityIds.length).toBeLessThanOrEqual(17);
      } else if (PRODUCTION_DEFI_CAPABILITY_BUNDLES.indexOf(bundle) < 62) {
        expect(bundle.capabilityIds.length).toBeLessThanOrEqual(10);
      } else {
        expect(bundle.capabilityIds.length).toBeLessThanOrEqual(100);
      }
      expect(bundle.capabilityIds).toEqual([...bundle.capabilityIds].sort(cmp));
      expect(new Set(bundle.capabilityIds).size).toBe(bundle.capabilityIds.length);
      expect(bundle.fingerprint).toBe(capabilityBundleFingerprint(bundle, flat));
      for (const id of bundle.capabilityIds) {
        expect(ids.has(id)).toBe(false);
        ids.add(id);
        expect(flat.find((fn) => fn.capabilityId === id)).toMatchObject({ status: 'active', type: 'contract_call' });
      }
    }
    const npm = PRODUCTION_DEFI_CAPABILITY_BUNDLES.filter((bundle) => bundle.bundleId.startsWith('uniswap-v3-'));
    const blue = PRODUCTION_DEFI_CAPABILITY_BUNDLES.filter((bundle) => bundle.bundleId.startsWith('morpho-blue-'));
    expect(npm).toHaveLength(7);
    expect(blue).toHaveLength(2);
    expect(npm.map((bundle) => bundle.chainIds[0])).toEqual([1, 10, 56, 137, 143, 8453, 42161]);
    expect(blue.map((bundle) => bundle.chainIds[0])).toEqual([1, 8453]);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(0, 12).flatMap((bundle) => bundle.capabilityIds)).toHaveLength(94);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(12, 33)).toHaveLength(21);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(12, 33).map(({ bundleId, chainIds, capabilityIds }) => [bundleId, chainIds[0], capabilityIds.length])).toEqual([
      ['quickswap-137', 137, 10], ['camelot-42161', 42161, 3], ['lfj-42161', 42161, 3],
      ['maverick-8453', 8453, 1], ['maverick-42161', 42161, 1], ['dodo-8453', 8453, 3],
      ['ambient-1', 1, 1], ['fluid-8453', 8453, 17], ['euler-1', 1, 16], ['silo-42161', 42161, 12],
      ['moonwell-8453', 8453, 17], ['dolomite-42161', 42161, 6], ['rocket-pool-1', 1, 2],
      ['ether-fi-1', 1, 7], ['renzo-1', 1, 6], ['kelp-1', 1, 4], ['stakewise-1', 1, 3],
      ['beefy-8453', 8453, 8], ['pendle-1', 1, 6], ['convex-1', 1, 6], ['aura-1', 1, 6],
    ]);
    const newIds = PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(12, 33).flatMap((bundle) => bundle.capabilityIds);
    expect(new Set(newIds).size).toBe(138);
    expect(newIds.sort(cmp)).toEqual(first20SourceIds());
    expect(Math.max(...PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(0, 33).map((bundle) => bundle.capabilityIds.length))).toBe(17);
    expect(Math.max(...PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(0, 12).map((bundle) => bundle.capabilityIds.length))).toBe(9);
    expect(new Set(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(12, 33).map((bundle) => bundle.chainIds[0]))).toEqual(new Set([1, 137, 8453, 42161]));
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(12, 33).filter((bundle) => bundle.bundleId.startsWith('maverick-')).map((bundle) => bundle.chainIds[0])).toEqual([8453, 42161]);
    expect(newIds.every((id) => !id.includes(':approve'))).toBe(true);
    for (const bundle of PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(12, 33)) {
      expect(bundle.warnings.join(' ')).toMatch(/approvals are separate authority and are not included or automatic/);
      expect(bundle.limitations.join(' ')).toMatch(/not a complete workflow/);
    }
    const copy = PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(12, 33).map((bundle) => `${bundle.warnings.join(' ')} ${bundle.limitations.join(' ')}`).join(' ');
    expect(copy).toMatch(/no LP entry\/exit workflow/);
    expect(copy).toMatch(/asset0.*asset1.*not verified/i);
    expect(copy).toMatch(/not a curated safety list.*LTV compatibility/i);
    expect(copy).toMatch(/No verified open-deposit pool.*pool-0.*shutdown/i);
    expect(copy).toMatch(/bounded samples do not prove all pools are closed/i);
    expect(copy).toMatch(/One historical pool-0 reward-pool relation.*not a full pool inventory/i);
    expect(copy).toMatch(/fToken lending functions.*VaultT1.*Signed operate deltas remain caller-chosen/i);
    expect(copy).toMatch(/protocol error codes/);
    expect(copy).toMatch(/depositAll consumes.*underlying-asset.*withdrawAll concerns vault shares/i);
    expect(copy).toMatch(/Pre-expiry redemption requires PT plus YT/);
    expect(copy).toMatch(/SY, PT, YT, and LP funding\/approvals are independent/);
    expect(copy).toMatch(/dated deployment snapshot.*registry state can change.*subject to liquidity/);
    expect(copy).toMatch(/asynchronous.*immediate-exit guarantee/);
    expect(copy).toMatch(/claim can be triggered for another user and pays that user/);
    expect(copy).toMatch(/not swap-only authority/);
    expect(copy).toMatch(/nonzero conduit can hold LP.*counterparty asset-loss risk.*governable sidecars/i);
    expect(copy).toMatch(/externalSwap is excluded/);
    expect(copy).toMatch(/extra referrer argument and void return/);
  });

  it('preserves all 62 immutable 74bb052 full-metadata profile objects exactly', () => {
    const fixtureBytes = readFileSync(resolve(process.cwd(), 'src/modules/defi/bundles/__fixtures__/phase3-baseline-profiles-74bb052.json'));
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe('3a73ad25307a3bd7ac4f77517b5cd9b09da4d83373fed1ea1f98176b9f7ff2a6');
    const fixture = JSON.parse(fixtureBytes.toString('utf8')) as { provenance: { gitCommit: string; sourcePath: string }; profiles: unknown[] };
    expect(fixture.provenance).toEqual({ gitCommit: '74bb052ec003656e5810d5af42d50a300e94aad3', sourcePath: 'src/modules/defi/bundles/production-bundles.ts' });
    expect(fixture.profiles).toHaveLength(62);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(0, 62)).toEqual(fixture.profiles);
  });

  it('preserves the independent 82d96a7 full-metadata profile baseline exactly', () => {
    const legacyFixtureBytes = readFileSync(resolve(process.cwd(), 'src/modules/defi/bundles/__fixtures__/legacy-production-profiles-82d96a7.json'));
    expect(createHash('sha256').update(legacyFixtureBytes).digest('hex')).toBe('e227c92dc24be8e0a307618e91e8bd201f8c1ae4938e928df187edd70e4d9eb1');
    const legacyFixture = JSON.parse(legacyFixtureBytes.toString('utf8')) as { provenance: { gitCommit: string; sourcePath: string }; profiles: Array<{ capabilityIds: string[] }> };
    expect(legacyFixture.provenance).toEqual({ gitCommit: '82d96a7', sourcePath: 'src/modules/defi/bundles/production-bundles.ts' });
    expect(legacyFixture.profiles).toHaveLength(12);
    expect(legacyFixture.profiles.reduce((sum, profile) => sum + profile.capabilityIds.length, 0)).toBe(94);
    expect(legacyFixture.profiles).toEqual(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(0, 12));
  });

  it('preserves all 33 profiles from immutable baseline 587f888 byte-for-byte', () => {
    const fixtureBytes = readFileSync(resolve(process.cwd(), 'src/modules/defi/bundles/__fixtures__/phase2-baseline-profiles-587f888.json'));
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe('9e6f596c0630b5a0dba45e03541612bc4b3e6915dad8d89db470926f1b512783');
    const fixture = JSON.parse(fixtureBytes.toString('utf8')) as { provenance: { gitCommit: string; sourcePath: string }; profiles: unknown[] };
    expect(fixture.provenance).toEqual({ gitCommit: '587f888', sourcePath: 'src/modules/defi/bundles/production-bundles.ts' });
    expect(fixture.profiles).toHaveLength(33);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(0, 33)).toEqual(fixture.profiles);
  });

  it('pins 29 literal phase2 profiles to all 134 selected active manifest identities and isolated ABI fingerprints', () => {
    const candidates = phase2CandidateManifest();
    const candidateIds = candidates.capabilities.map((fn) => fn.capabilityId).sort(cmp);
    const profiles = PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(33, 62);
    expect(candidates.capabilities).toHaveLength(134);
    expect(profiles).toHaveLength(29);
    expect(profiles.map((profile) => profile.version)).toEqual(Array(29).fill('1.0.0'));
    const memberIds = profiles.flatMap((profile) => profile.capabilityIds);
    expect(memberIds).toHaveLength(134);
    expect(new Set(memberIds).size).toBe(134);
    expect([...memberIds].sort(cmp)).toEqual(candidateIds);

    for (const profile of profiles) {
      expect(profile.capabilityIds).toEqual([...profile.capabilityIds].sort(cmp));
      expect(profile.fingerprint).toBe(capabilityBundleFingerprint(profile, candidates.capabilities));
      for (const id of profile.capabilityIds) {
        const candidate = candidates.capabilities.find((fn) => fn.capabilityId === id)!;
        expect(candidate).toMatchObject({ type: 'contract_call', status: 'active', provenance: { status: 'verified' } });
        const admitted = flat.find((fn) => fn.capabilityId === id)!;
        expect(admitted).toMatchObject({ type: 'contract_call', status: 'active', abi: candidate.abi, signature: candidate.signature, chainId: candidate.chainId });
        expect(admitted.contract.toLowerCase()).toBe(candidate.contract.toLowerCase());
      }
      expect(profile.warnings.join(' ')).toMatch(/selected source-qualified ABI calls/);
      expect(profile.warnings.join(' ')).toMatch(/not included, automatic, or paired/);
      expect(profile.limitations.join(' ')).toMatch(/not a broad product, market-coverage, or whole-workflow claim/);
    }
    expect(profiles.map((profile) => profile.bundleId).filter((id) => id.startsWith('exactly-'))).toEqual([
      'exactly-op-usdc-market-10', 'exactly-op-weth-market-10', 'exactly-op-auditor-10',
    ]);
    const exactly = profiles.filter((profile) => profile.bundleId.startsWith('exactly-'));
    expect(exactly.map((profile) => profile.capabilityIds.length)).toEqual([10, 10, 2]);
    expect(exactly[2].label).toContain('Auditor enter/exit controls');
    expect(exactly[2].limitations).toContain('Only Auditor market enter/exit calls are selected; no lending-market operations are included.');
    const auditor = candidates.capabilities.filter((fn) => fn.capabilityId.includes(':0xaeb62e6f27bc103702e7bc879ae98bcea56f027e:'));
    expect(auditor.map((fn) => fn.functionName).sort(cmp)).toEqual(['enterMarket', 'exitMarket']);
    const sky = profiles.find((profile) => profile.bundleId === 'sky-phase2-1')!;
    expect(sky.capabilityIds).toHaveLength(6);
    expect(candidates.capabilities.filter((fn) => fn.capabilityId.startsWith('sky:')).map((fn) => fn.capabilityId).sort(cmp)).toEqual(sky.capabilityIds);
    const caveats = profiles.map((profile) => `${profile.label} ${profile.warnings.join(' ')} ${profile.limitations.join(' ')}`).join(' ');
    for (const phrase of [
      'deposit-only', 'settlement/payout is not represented', 'Ethereum LP position subset',
      'dated agEUR Savings identity snapshot', 'one sampled pool', 'Bitcoin-script redemption',
      'frxETH; it is not an ETH queue', 'withdrawal settlement or completion', 'exits and settlement are not represented',
      'Comptroller interface, not a Vault',
    ]) expect(caveats).toContain(phrase);
  });

  it('pins five literal phase3 selections to exactly 28 source-builder identities without automatic approvals', () => {
    const candidates = phase3CandidateCapabilities();
    const profiles = PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(62);
    expect(candidates).toHaveLength(28);
    expect(profiles.map(({ bundleId, capabilityIds }) => [bundleId, capabilityIds.length])).toEqual([
      ['one-inch-ethereum', 12], ['zero-x-native-orders-ethereum', 8], ['velora-augustus-rfq-ethereum', 4],
      ['bebop-bop-amm-ethereum', 1], ['open-ocean-uniswap-routes-ethereum', 3],
    ]);
    expect(profiles).toHaveLength(5);
    const memberIds = profiles.flatMap((profile) => profile.capabilityIds);
    expect(memberIds).toHaveLength(28);
    expect(new Set(memberIds).size).toBe(28);
    expect([...memberIds].sort(cmp)).toEqual(candidates.map((fn) => fn.capabilityId).sort(cmp));
    const baselineIds = new Set(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(0, 62).flatMap((profile) => profile.capabilityIds));
    expect(memberIds.some((id) => baselineIds.has(id))).toBe(false);
    expect(memberIds.every((id) => !id.includes(':approve'))).toBe(true);
    for (const profile of profiles) {
      expect(profile.version).toBe('1.0.0');
      expect(profile.chainIds).toEqual([1]);
      expect(profile.capabilityIds).toEqual([...profile.capabilityIds].sort(cmp));
      expect(profile.fingerprint).toBe(capabilityBundleFingerprint(profile, candidates));
      expect(profile.capabilityIds.length).toBeLessThanOrEqual(100);
      expect(profile.warnings.join(' ')).toMatch(/approvals?.*independent|approvals? are separate/i);
      expect(profile.warnings.join(' ')).toMatch(/not .*paired|not automatic|not included|neither .*paired/i);
      expect(profile.limitations.join(' ')).toMatch(/not all .* (?:methods|routes|routing)|not a complete workflow|all .* workflow.*not certified|not full .* (?:routing|workflow)/i);
      expect(profile.limitations.join(' ')).toMatch(/current (?:facet\/)?runtime/i);
      expect(profile.limitations.join(' ')).toMatch(/liquidity.*funded execution/i);
    }
    const oneInch = profiles[0];
    expect(oneInch.capabilityIds).toHaveLength(12);
    expect(oneInch.warnings.join(' ')).toMatch(/ten decoded execution nodes per request/);
    expect(oneInch.warnings.join(' ')).toMatch(/V3 canonical factory\/pool checks apply only.*external-payer callback branch/i);
    expect(oneInch.warnings.join(' ')).toMatch(/Curve\/router-balance callbacks assume no stranded router funds/i);
    const zeroX = profiles[1];
    expect(zeroX.warnings.join(' ')).toMatch(/RFQ txOrigin eligibility.*not a platform-owner restriction/i);
    expect(zeroX.warnings.join(' ')).toMatch(/historical Native Orders facet.*not a current facet\/runtime identity/i);
    expect(profiles[2].warnings.join(' ')).toMatch(/WithTarget.*bounded selection, not a restriction imposed by the platform/i);
    expect(profiles[3].warnings.join(' ')).toMatch(/fallback.*callback.*other Bebop RFQ.*pricing-selected maker\/fee hooks may still be invoked.*execution\/trust dependencies/i);
    expect(profiles[3].limitations.join(' ')).toMatch(/fixed-route fee\/maker hooks.*remain external dependencies/i);
    expect(profiles[3].limitations.join(' ')).toMatch(/All Bebop RFQ products.*full workflow.*not certified/i);
    expect(profiles[4].warnings.join(' ')).toMatch(/opaque makeCalls.*excluded/i);
    expect(profiles[4].warnings.join(' ')).toMatch(/returnAmount may differ from net recipient proceeds/i);
    expect(profiles[4].warnings.join(' ')).toMatch(/whenNotPaused guards.*platform pause remains an independent policy overlay/i);
  });

  it('binds every NPM multicall profile to its wrapper and exactly its eight explicit child grants', () => {
    for (const bundle of PRODUCTION_DEFI_CAPABILITY_BUNDLES.filter((item) => item.bundleId.startsWith('uniswap-v3-'))) {
      const wrapper = flat.find((fn) => fn.capabilityId.endsWith(':multicall') && fn.chainId === bundle.chainIds[0] && fn.capabilityId.startsWith('uniswap-v3-position-manager:'))!;
      expect(wrapper.executionScope?.kind).toBe('same-target-multicall-v1');
      if (wrapper.executionScope?.kind !== 'same-target-multicall-v1') throw new Error('Expected scoped NPM multicall');
      expect(wrapper.executionScope.allowedChildren.map((child) => child.capabilityId).sort(cmp)).toEqual(bundle.capabilityIds.filter((id) => id !== wrapper.capabilityId));
      expect(wrapper.executionScope.allowedChildren).toHaveLength(8);
      expect(bundle.warnings.join(' ')).toMatch(/delegatecall/);
      expect(bundle.warnings.join(' ')).toMatch(/residual contract balances/);
    }
  });

  it('includes all legacy Morpho methods and only the three callback-free additions per chain', () => {
    for (const bundle of PRODUCTION_DEFI_CAPABILITY_BUNDLES.filter((item) => item.bundleId.startsWith('morpho-blue-'))) {
      const functions = bundle.capabilityIds.map((id) => flat.find((fn) => fn.capabilityId === id)!);
      expect(functions.map((fn) => fn.functionName).sort(cmp)).toEqual(['borrow', 'repay', 'supply', 'supplyCollateral', 'withdraw', 'withdrawCollateral'].sort(cmp));
      expect(functions.filter((fn) => fn.protocol === 'Morpho Blue')).toHaveLength(3);
      expect(functions.filter((fn) => fn.executionScope?.kind === 'empty-callback-data-v1')).toHaveLength(3);
      expect(bundle.warnings.join(' ')).toMatch(/supply, supplyCollateral, and repay/);
      expect(bundle.warnings.join(' ')).toMatch(/caller-controlled/);
    }
  });

  it('resolves each new literal profile selection to an exact reviewed manifest ABI', () => {
    const newIds = first20SourceIds();
    expect(newIds).toHaveLength(138);
    for (const id of newIds) {
      const fn = flat.find((candidate) => candidate.capabilityId === id)!;
      expect(fn).toMatchObject({ status: 'active', type: 'contract_call' });
      expect(fn.abiHash).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it('requires the NPM wrapper and each selected child grant independently and denies unknown recursion', async () => {
    const profile = PRODUCTION_DEFI_CAPABILITY_BUNDLES.find((bundle) => bundle.bundleId === 'uniswap-v3-positions-1')!;
    const wrapper = flat.find((fn) => fn.capabilityId.endsWith(':multicall') && fn.chainId === 1)!;
    if (wrapper.executionScope?.kind !== 'same-target-multicall-v1') throw new Error('Missing production NPM scope');
    const children = wrapper.executionScope.allowedChildren.map((binding) => flat.find((fn) => fn.capabilityId === binding.capabilityId)!);
    const childCalls = children.map((child) => encoded(child));
    const allCalls = encoded(wrapper, { 0: childCalls });
    const { policy } = makePolicy();
    const context = (allowedCapabilityIds: string[]) => ({ userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId: 1, executionMode: 'eoa', executionOwner: OWNER, allowedCapabilityIds });
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: allCalls }], context([...profile.capabilityIds]))).resolves.toMatchObject({ executionPlan: expect.arrayContaining([expect.objectContaining({ path: [0, 0] })]) });
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: allCalls }], context(profile.capabilityIds.filter((id) => id !== wrapper.capabilityId)))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: allCalls }], context(profile.capabilityIds.filter((id) => id !== children[0].capabilityId)))).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    const recursive = encoded(wrapper, { 0: [encoded(wrapper, { 0: [encoded(children[0])] })] });
    await expect(policy.authorizeContractCalls([{ to: wrapper.contract, data: recursive }], context([...profile.capabilityIds]))).rejects.toMatchObject({ audit: { code: 'DEFI_FUNCTION_NOT_ALLOWED' } });
  });

  it('permits only empty callback bytes for all six actual Morpho callback functions', async () => {
    const callbacks = flat.filter((fn) => fn.protocol === 'morpho-blue' && fn.executionScope?.kind === 'empty-callback-data-v1');
    expect(callbacks).toHaveLength(6);
    const grants = PRODUCTION_DEFI_CAPABILITY_BUNDLES.filter((bundle) => bundle.bundleId.startsWith('morpho-blue-')).flatMap((bundle) => bundle.capabilityIds);
    const { policy } = makePolicy();
    for (const fn of callbacks) {
      await expect(policy.authorizeContractCalls([{ to: fn.contract, data: encoded(fn) }], {
        userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId: fn.chainId,
        executionMode: 'eoa', executionOwner: OWNER, allowedCapabilityIds: grants,
    })).resolves.toMatchObject({ matches: [expect.objectContaining({ capabilityId: fn.capabilityId })] });
    }
    const fn = callbacks[0];
    const scope = fn.executionScope;
    if (!scope || scope.kind !== 'empty-callback-data-v1') throw new Error('Expected Morpho callback scope');
    const bytesIndex = scope.bytesArgIndex;
    await expect(policy.authorizeContractCalls([{ to: fn.contract, data: encoded(fn, { [bytesIndex]: '0x00' }) }], {
      userId: 'user', apiKeyId: '00000000-0000-4000-8000-000000000001', walletId: 'wallet', chainId: fn.chainId,
      executionMode: 'eoa', executionOwner: OWNER, allowedCapabilityIds: grants,
    })).rejects.toMatchObject({ audit: { code: 'DEFI_INVALID_PARAMETERS' } });
  });

  it('keeps complete fixed membership visible when a live pause marks one bundle member unavailable', async () => {
    const bundle = PRODUCTION_DEFI_CAPABILITY_BUNDLES[0];
    const pausedId = bundle.capabilityIds[0];
    const pausedFunction = flat.find((fn) => fn.capabilityId === pausedId)!;
    const state = { id: 'global', pausedScopeKeys: [defiPauseScopeKeysForCapability(pausedFunction).at(-1)!] };
    const prisma = { defiPolicyState: { findUnique: jest.fn().mockResolvedValue(state) } };
    const catalog = new DefiCatalogService(PRODUCTION_DEFI_CATALOG, prisma as never, PRODUCTION_DEFI_MANIFEST);
    const service = new DefiBundleService(PRODUCTION_DEFI_CAPABILITY_BUNDLES, catalog);
    const response = await service.listMetadata();
    expect(response.maxGrants).toBe(100);
    expect(response.bundles[0]).toMatchObject({ available: false, capabilityIds: bundle.capabilityIds, unavailableCapabilityIds: [pausedId] });
    expect(response.bundles).toHaveLength(67);
  });
});
