import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildReviewedManifest } from '../registry/defi-manifest';
import { assembleCatalogFromSources, assembleV6SourceCandidates, assembleV7SourceCandidates, assembleV9SourceCandidates, assertBaselinePreserved, BASELINE_MANIFEST_HASH, canonicalSourceSha256, catalogDiff, parseCatalogCliArgs, prepareV6Sources, prepareV7Sources, prepareV9Sources, renderGeneratedModule, stableCatalogJson, validateBaseline, validateCatalogDocument, validateV6AssemblyPlan, validateV7AssemblyPlan, validateV9AssemblyPlan, V6_SOURCE_PATHS, V7_SOURCE_PATHS } from './catalog-generator';
import { functionAbiHash } from '../registry/defi-manifest';
import type { DefiExecutionScope, DefiFunctionPolicy } from '../defi.types';
import { toFunctionSelector } from 'viem';
import { buildSparkLendRegistry } from '../registry/spark-lend';
import { buildFluidRegistry } from '../registry/fluid';
import { buildQuickSwapV2Registry } from '../registry/quickswap-v2';
import { buildRocketPoolRegistry } from '../registry/rocket-pool';
import { buildMoonwellRegistry, MOONWELL_CAPABILITIES } from '../registry/moonwell';
import { assembleV5SourceCandidates, validateV5AssemblyPlan, V5_ASSEMBLY_PLAN_PATH } from './catalog-generator';
import { spawnSync } from 'node:child_process';
import { buildEtherfiRegistry } from '../registry/etherfi';
import { buildCamelotRegistry } from '../registry/camelot-v2';
import { buildLfjRegistry } from '../registry/lfj-liquidity-book';
import { buildBeefyStandardRegistry } from '../registry/beefy-standard';
import { buildKelpRegistry } from '../registry/kelp';
import { buildPendleV3Registry } from '../registry/pendle-v3';
import { buildAmbientRegistry } from '../registry/ambient';
import { buildConvexRegistry } from '../registry/convex';
import { buildMaverickV2Registry } from '../registry/maverick-v2';
import { buildStakeWiseRegistry } from '../registry/stakewise';
import { buildDodoV2Registry } from '../registry/dodo-v2';
import { buildDolomiteRouterRegistry } from '../registry/dolomite-router';
import { buildAuraRegistry } from '../registry/aura';
import { buildEulerVaultRegistry } from '../registry/euler-vault';
import { buildRenzoRegistry } from '../registry/renzo';
import { buildSiloVaultRegistry } from '../registry/silo-vault';
import { executionScopeHash } from '../execution/scope';
import { V6_SOURCE_IDENTITIES } from './v6-identities';
import { V7_SOURCE_IDENTITIES } from './v7-identities';
import { buildOneInchRegistry, ONE_INCH_CAPABILITIES } from '../registry/one-inch';
import { buildZeroXRegistry, ZERO_X_CAPABILITIES } from '../registry/zero-x';
import { buildVeloraRegistry, VELORA_CAPABILITIES } from '../registry/velora';
import { buildBebopRegistry, BEBOP_CAPABILITIES } from '../registry/bebop';
import { buildOpenOceanRegistry, OPEN_OCEAN_CAPABILITIES } from '../registry/open-ocean';
import { createHash } from 'node:crypto';
import { assembleV8SourceCandidates, prepareV8Sources, validateV8AssemblyPlan } from './catalog-generator';
import { V8_ASSEMBLY_PLAN_PATH, V8_BASELINE_RAW_SHA256, V8_ROOT_IDENTITY, V8_SOURCE_CANONICAL_SHA256, V8_SOURCE_PATHS } from './v8-identities';
import { createEnsoStaticWeirollScope } from '../execution/enso-identity';
import { V9_ASSEMBLY_PLAN_PATH, V9_BASELINE_RAW_SHA256, V9_SOURCE_CANONICAL_SHA256, V9_SOURCE_PATHS } from './v9-identities';

const valid = { schemaVersion: 1, chains: buildSparkLendRegistry().chains };

function readV7Inputs() {
  return V7_SOURCE_PATHS.map((sourcePath) => ({ sourcePath, document: JSON.parse(readFileSync(resolve(process.cwd(), sourcePath), 'utf8')) as unknown }));
}

function makeV7Admissions(inputs: ReturnType<typeof readV7Inputs>, bindings = prepareV7Sources(inputs).bindings) {
  return {
    schemaVersion: 1,
    snapshots: inputs.map(({ sourcePath, document }) => ({
      sourcePath,
      canonicalSha256: canonicalSourceSha256(document),
      bindings: bindings.filter((binding) => binding.sourcePath === sourcePath).map(({ familyId, chainId, contract, signature, selector, abiHash, capabilityId, executionScope, executionScopeHash }) => ({ familyId, chainId, contract, signature, selector, abiHash, capabilityId, executionScope, executionScopeHash })).sort((a, b) => {
        const left = `${a.familyId}:${a.chainId}:${a.contract}:${a.signature}`;
        const right = `${b.familyId}:${b.chainId}:${b.contract}:${b.signature}`;
        return left < right ? -1 : left > right ? 1 : 0;
      }),
    })),
  };
}

function assertFixtureBindings(actual: DefiFunctionPolicy[], expected: DefiFunctionPolicy[]): void {
  if (actual.length !== expected.length) throw new Error(`Source/fixture function count mismatch: ${actual.length} vs ${expected.length}`);
  for (const fixture of expected) {
    const matches = actual.filter((fn) => fn.chainId === fixture.chainId && fn.contract.toLowerCase() === fixture.contract.toLowerCase() && fn.signature === fixture.signature);
    if (matches.length !== 1) throw new Error(`Source/fixture target/signature mismatch: ${fixture.capabilityId}`);
    const candidate = matches[0];
    if (candidate.capabilityId !== fixture.capabilityId || functionAbiHash(candidate) !== functionAbiHash(fixture)) throw new Error(`Source/fixture binding mismatch: ${fixture.capabilityId}`);
    const candidateScope = candidate.executionScope ? executionScopeHash(candidate.executionScope) : undefined;
    const fixtureScope = fixture.executionScope ? executionScopeHash(fixture.executionScope) : undefined;
    if (candidateScope !== fixtureScope) throw new Error(`Source/fixture scope mismatch: ${fixture.capabilityId}`);
  }
}

describe('DeFi catalog generator', () => {
  it('compiles all 134 fixed v6 bindings to unique reviewed fixture identities and assembles on frozen v5', () => {
    const inputs = V6_SOURCE_PATHS.map((sourcePath) => ({ sourcePath, document: JSON.parse(readFileSync(resolve(process.cwd(), sourcePath), 'utf8')) as unknown }));
    const report = prepareV6Sources(inputs);
    expect(report).toMatchObject({ sourceCount: 27, familyCount: 27, targetCount: 35, bindingCount: 134 });
    const plan = JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v6/assembly-plan.json'), 'utf8'));
    expect(validateV6AssemblyPlan(plan).sourcePaths).toEqual(V6_SOURCE_PATHS);
    expect(() => validateV6AssemblyPlan({ ...plan, sourcePaths: plan.sourcePaths.slice(1) })).toThrow(/every fixed v6 source/);
    expect(report.sourceDigests).toHaveLength(27);
    expect(report.bindings).toHaveLength(134);
    expect(new Set(report.bindings.map((binding) => binding.capabilityId)).size).toBe(134);
    for (const [familyId, functionName, count] of [['ekubo', 'withdraw', 2], ['ekubo', 'collectFees', 2], ['sky', 'deposit', 2], ['sky', 'mint', 2]] as const) {
      const overloads = report.bindings.filter((binding) => binding.familyId === familyId && binding.functionName === functionName);
      expect(overloads).toHaveLength(count);
      expect(new Set(overloads.map((binding) => binding.capabilityId)).size).toBe(count);
      expect(new Set(overloads.map((binding) => binding.selector)).size).toBe(count);
    }
    expect(V6_SOURCE_IDENTITIES).toHaveLength(134);
    for (const binding of report.bindings) {
      const fixture = V6_SOURCE_IDENTITIES.find((row) => row.sourcePath === binding.sourcePath && row.familyId === binding.familyId && row.chainId === binding.chainId && row.address === binding.contract.toLowerCase() && row.signature === binding.signature);
      expect(fixture).toBeDefined();
      expect(binding).toMatchObject({ capabilityId: fixture!.capabilityId, abiHash: fixture!.abiHash, selector: toFunctionSelector(binding.signature).toLowerCase() });
    }
    const registryDirectory: Record<string, string> = { bancor: 'bancor-v3', gearbox: 'gearbox-pool', liquity: 'liquity-v2' };
    for (const sourcePath of V6_SOURCE_PATHS) {
      const family = sourcePath.split('/').at(-1)!.replace('.json', '');
      const module = require(resolve(process.cwd(), 'src/modules/defi/registry', registryDirectory[family] ?? family));
      const builder = Object.values(module).find((value: any) => typeof value === 'function' && value.name.startsWith('build')) as (() => { chains: Array<{ chainId: number; contracts: Array<{ address: string; functions: DefiFunctionPolicy[] }> }> }) | undefined;
      expect(builder).toBeDefined();
      const fixtureFunctions = builder!().chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => ({ ...fn, chainId: chain.chainId, contract: contract.address }))));
      const compiled = report.bindings.filter((binding) => binding.sourcePath === sourcePath);
      for (const binding of compiled) {
        const match = fixtureFunctions.filter((fn) => fn.chainId === binding.chainId && fn.contract.toLowerCase() === binding.contract.toLowerCase() && fn.signature === binding.signature);
        expect(match).toHaveLength(1);
        expect(match[0].capabilityId).toBe(binding.capabilityId);
        expect(functionAbiHash(match[0])).toBe(binding.abiHash);
      }
    }
    const baseline = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v5/catalog.json'), 'utf8')));
    const makeAdmissions = (sourceInputs: typeof inputs, compiled = prepareV6Sources(sourceInputs)) => ({ schemaVersion: 1, snapshots: sourceInputs.map(({ sourcePath, document }) => ({ sourcePath, canonicalSha256: canonicalSourceSha256(document), bindings: compiled.bindings.filter((binding) => binding.sourcePath === sourcePath).map(({ familyId, chainId, contract, signature, selector, abiHash, capabilityId, executionScope, executionScopeHash }) => ({ familyId, chainId, contract, signature, selector, abiHash, capabilityId, executionScope, executionScopeHash })).sort((a, b) => { const left = `${a.familyId}:${a.chainId}:${a.contract}:${a.signature}`, right = `${b.familyId}:${b.chainId}:${b.contract}:${b.signature}`; return left < right ? -1 : left > right ? 1 : 0; }) })) });
    const inactiveAssembly = assembleV6SourceCandidates({ chains: baseline.chains }, inputs);
    const reportIds = new Set(report.bindings.map((binding) => binding.capabilityId));
    const inactiveV6 = inactiveAssembly.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => reportIds.has(fn.capabilityId));
    expect(inactiveV6).toHaveLength(134);
    expect(inactiveV6.every((fn) => fn.status === 'inactive' && fn.provenance.status === 'candidate')).toBe(true);
    const admissions = makeAdmissions(inputs, report);
    const assembled = assembleV6SourceCandidates({ chains: baseline.chains }, inputs, admissions);
    expect(buildReviewedManifest([assembled]).capabilities).toHaveLength(640);
    expect(renderGeneratedModule(assembled)).toBe(renderGeneratedModule(assembleV6SourceCandidates({ chains: baseline.chains }, inputs, admissions)));
    const v6Ids = new Set(report.bindings.map((binding) => binding.capabilityId));
    const admitted = assembled.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => v6Ids.has(fn.capabilityId));
    expect(admitted).toHaveLength(134);
    expect(admitted.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified')).toBe(true);
    expect(admitted.filter((fn) => fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).toHaveLength(0);
    expect(assembled.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => fn.executionScope)).toHaveLength(15);
    expect(catalogDiff(baseline, assembled)).toMatchObject({ added: expect.arrayContaining(report.bindings.map((binding) => binding.capabilityId)), removed: [], authorityChanged: [], abiChanged: [], metadataChanged: [] });
    const baselineIds = new Set(buildReviewedManifest([baseline]).capabilities.map((fn) => fn.capabilityId));
    expect(assembled.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => baselineIds.has(fn.capabilityId))).toEqual(baseline.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)));
    expect(buildReviewedManifest([baseline]).capabilities).toHaveLength(506);
    const missing = JSON.parse(JSON.stringify(admissions)); missing.snapshots[0].bindings.pop();
    expect(() => assembleV6SourceCandidates({ chains: baseline.chains }, inputs, missing)).toThrow(/binding count mismatch/);
    const omittedScope = JSON.parse(JSON.stringify(admissions)); delete omittedScope.snapshots[0].bindings[0].executionScope;
    expect(() => assembleV6SourceCandidates({ chains: baseline.chains }, inputs, omittedScope)).toThrow(/missing fields: executionScope/);
    const omittedScopeHash = JSON.parse(JSON.stringify(admissions)); delete omittedScopeHash.snapshots[0].bindings[0].executionScopeHash;
    expect(() => assembleV6SourceCandidates({ chains: baseline.chains }, inputs, omittedScopeHash)).toThrow(/missing fields: executionScopeHash/);
    const asymmetricV6Nulls = JSON.parse(JSON.stringify(admissions)); asymmetricV6Nulls.snapshots[0].bindings[0].executionScopeHash = '0x' + '0'.repeat(64);
    expect(() => assembleV6SourceCandidates({ chains: baseline.chains }, inputs, asymmetricV6Nulls)).toThrow(/inconsistent null execution-scope pair/);
    const mismatched = JSON.parse(JSON.stringify(admissions)); mismatched.snapshots[0].bindings[0].abiHash = `0x${'0'.repeat(64)}`;
    expect(() => assembleV6SourceCandidates({ chains: baseline.chains }, inputs, mismatched)).toThrow(/does not match source ABI/);
    const duplicated = JSON.parse(JSON.stringify(admissions)); duplicated.snapshots[0].bindings.push(duplicated.snapshots[0].bindings[0]);
    expect(() => assembleV6SourceCandidates({ chains: baseline.chains }, inputs, duplicated)).toThrow(/binding count mismatch/);
    const withScope = JSON.parse(JSON.stringify(admissions)); const binding: any = withScope.snapshots[0].bindings[0]; binding.executionScope = { kind: 'empty-callback-data-v1', bytesArgIndex: 0 }; binding.executionScopeHash = executionScopeHash(binding.executionScope);
    expect(() => assembleV6SourceCandidates({ chains: baseline.chains }, inputs, withScope)).toThrow(/scope is not defined for this function identity/);
    const badScopeHash = JSON.parse(JSON.stringify(withScope)); badScopeHash.snapshots[0].bindings[0].executionScopeHash = `0x${'0'.repeat(64)}`;
    expect(() => assembleV6SourceCandidates({ chains: baseline.chains }, inputs, badScopeHash)).toThrow(/execution-scope hash mismatch/);
    const alteredScope = JSON.parse(JSON.stringify(withScope)); alteredScope.snapshots[0].bindings[0].executionScope.bytesArgIndex = 1; alteredScope.snapshots[0].bindings[0].executionScopeHash = executionScopeHash(alteredScope.snapshots[0].bindings[0].executionScope);
    expect(() => assembleV6SourceCandidates({ chains: baseline.chains }, inputs, alteredScope)).toThrow(/scope is not defined for this function identity/);
    const sourceScope = JSON.parse(JSON.stringify(inputs)); (sourceScope[0].document as any).families[0].contracts[0].abiFunctions[0].executionScope = { kind: 'empty-callback-data-v1', bytesArgIndex: 0 };
    expect(() => prepareV6Sources(sourceScope)).toThrow(/unsupported fields|scope is not defined/);
    const mutated = JSON.parse(JSON.stringify(inputs)); (mutated[0].document as any).sources[0].evidence += ' changed';
    expect(() => assembleV6SourceCandidates({ chains: baseline.chains }, mutated, admissions)).toThrow(/snapshot hash does not match admission/);
    expect(() => prepareV6Sources(inputs.slice(1))).toThrow(/fixed source path/);
    expect(() => prepareV6Sources([{ ...inputs[0], sourcePath: 'data/defi-catalog/v6/sources/unknown.json' }, ...inputs.slice(1)])).toThrow(/fixed source path/);
    const nullLedger = JSON.parse(JSON.stringify(inputs)); (nullLedger[0].document as any).unresolved = null;
    expect(() => prepareV6Sources(nullLedger)).toThrow(/unsupported source schema/);
    const nullRefs = JSON.parse(JSON.stringify(inputs)); (nullRefs[0].document as any).families[0].contracts[0].sourceRefs = null;
    expect(() => prepareV6Sources(nullRefs)).toThrow(/missing, duplicate, or undeclared source references/);
    expect(buildReviewedManifest([baseline]).capabilities).toHaveLength(506);
  });

  it('prepares five fixed inactive v7 sources against all 640 frozen v6 definitions and synthetic admissions only', () => {
    const inputs = readV7Inputs();
    const plan = JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v7/assembly-plan.json'), 'utf8'));
    expect(validateV7AssemblyPlan(plan)).toEqual({ schemaVersion: 1, baselinePath: 'data/defi-catalog/v6/catalog.json', sourcePaths: V7_SOURCE_PATHS });
    expect(V7_SOURCE_IDENTITIES).toHaveLength(28);
    expect(new Set(V7_SOURCE_IDENTITIES.map((row) => row.capabilityId)).size).toBe(28);
    expect(new Set(V7_SOURCE_IDENTITIES.map((row) => `${row.sourcePath}:${row.chainId}:${row.address}:${row.selector}`)).size).toBe(28);
    expect(inputs.map((input) => input.sourcePath)).toEqual(V7_SOURCE_PATHS);
    const report = prepareV7Sources(inputs);
    expect(report).toMatchObject({ sourceCount: 5, familyCount: 5, targetCount: 5, bindingCount: 28 });
    expect(report.sourceDigests).toHaveLength(5);
    expect(report.bindings).toHaveLength(28);
    for (const binding of report.bindings) {
      const identity = V7_SOURCE_IDENTITIES.find((row) => row.sourcePath === binding.sourcePath && row.familyId === binding.familyId && row.familyVersion === binding.familyVersion && row.chainId === binding.chainId && row.address === binding.contract.toLowerCase() && row.signature === binding.signature);
      expect(identity).toBeDefined();
      expect(binding).toMatchObject({ capabilityId: identity!.capabilityId, abiHash: identity!.abiHash, selector: identity!.selector, executionScope: null, executionScopeHash: null });
    }

    const fixtureFns = [ONE_INCH_CAPABILITIES, ZERO_X_CAPABILITIES, VELORA_CAPABILITIES, BEBOP_CAPABILITIES, OPEN_OCEAN_CAPABILITIES].flat();
    expect(fixtureFns).toHaveLength(28);
    expect(new Set(fixtureFns.map((fn) => fn.capabilityId)).size).toBe(28);
    const candidateFns = report.bindings;
    expect(candidateFns.map((fn) => fn.capabilityId).sort()).toEqual(fixtureFns.map((fn) => fn.capabilityId).sort());
    for (const input of inputs) {
      const source = input.document as any;
      expect(source.families).toHaveLength(1);
      const family = source.families[0];
      const contract = family.contracts[0];
      expect(contract.status).toBe('inactive');
      const refs = new Set(source.sources.map((record: any) => record.sourceId));
      expect(contract.sourceRefs.every((ref: string) => refs.has(ref))).toBe(true);
      const compiledForSource = report.bindings.filter((binding) => binding.sourcePath === input.sourcePath);
      expect(contract.abiFunctions).toHaveLength(compiledForSource.length);
      for (const abiEntry of contract.abiFunctions) {
        const fn = fixtureFns.find((candidate) => candidate.functionName === abiEntry.name && candidate.contract.toLowerCase() === contract.address.toLowerCase());
        expect(fn).toBeDefined();
        const { sourceId: _sourceId, ...fullAbi } = abiEntry;
        expect(fullAbi).toEqual(fn!.abi);
        expect(functionAbiHash({ abi: fullAbi })).toBe(functionAbiHash(fn!));
        expect(toFunctionSelector(fn!.signature)).toBe(report.bindings.find((binding) => binding.capabilityId === fn!.capabilityId)!.selector);
      }
    }
    const oneInchSource = (inputs.find((input) => input.sourcePath.endsWith('/one-inch.json'))!.document as any).families[0].contracts[0].abiFunctions;
    expect(oneInchSource.find((fn: any) => fn.name === 'unoswap')!.inputs.find((input: any) => input.name === 'token')).toMatchObject({ type: 'uint256', internalType: 'Address' });
    const zeroX = (inputs.find((input) => input.sourcePath.endsWith('/zero-x.json'))!.document as any).families[0].contracts[0].abiFunctions.find((fn: any) => fn.name === 'fillRfqOrder');
    expect(zeroX.inputs[0].components.map((field: any) => [field.name, field.type])).toEqual([['makerToken','address'],['takerToken','address'],['makerAmount','uint128'],['takerAmount','uint128'],['maker','address'],['taker','address'],['txOrigin','address'],['pool','bytes32'],['expiry','uint64'],['salt','uint256']]);

    const v6 = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v6/catalog.json'), 'utf8')));
    const inactive = assembleV7SourceCandidates({ chains: v6.chains }, plan, inputs);
    const inactiveDiff = catalogDiff(v6, inactive);
    expect(inactiveDiff).toEqual({ added: expect.arrayContaining(report.bindings.map((binding) => binding.capabilityId)), removed: [], authorityChanged: [], abiChanged: [], metadataChanged: [] });
    expect(inactiveDiff.added).toHaveLength(28);
    const oldById = new Map(v6.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => [fn.capabilityId, fn] as const))));
    const inactiveById = new Map(inactive.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => [fn.capabilityId, fn] as const))));
    expect(oldById.size).toBe(640);
    for (const [id, fn] of oldById) expect(inactiveById.get(id)).toEqual(fn);
    const addedCandidates = report.bindings.map((binding) => inactiveById.get(binding.capabilityId)!);
    expect(addedCandidates).toHaveLength(28);
    expect(addedCandidates.every((fn) => fn.status === 'inactive' && fn.provenance.status === 'candidate')).toBe(true);
    expect(buildReviewedManifest([inactive]).capabilities).toHaveLength(668);
    expect(inactive.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => fn.executionScope)).toHaveLength(15);

    const admissions = makeV7Admissions(inputs, report.bindings);
    const admitted = assembleV7SourceCandidates({ chains: v6.chains }, plan, inputs, admissions);
    const admittedDiff = catalogDiff(v6, admitted);
    expect(admittedDiff.added).toHaveLength(28);
    expect(admittedDiff).toMatchObject({ removed: [], authorityChanged: [], abiChanged: [], metadataChanged: [] });
    const admittedById = new Map(admitted.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => [fn.capabilityId, fn] as const))));
    for (const [id, fn] of oldById) expect(admittedById.get(id)).toEqual(fn);
    expect(report.bindings.map((binding) => admittedById.get(binding.capabilityId)!.status).every((status) => status === 'active')).toBe(true);
    expect(buildReviewedManifest([admitted]).capabilities).toHaveLength(668);
    expect(admitted.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => fn.executionScope)).toHaveLength(15);

    for (const badPlan of [
      { ...plan, extra: true },
      { ...plan, baselinePath: 'data/defi-catalog/v5/catalog.json' },
      { ...plan, sourcePaths: plan.sourcePaths.slice(1) },
      { ...plan, sourcePaths: [...plan.sourcePaths, 'data/defi-catalog/v7/sources/unreviewed.json'] },
      { ...plan, sourcePaths: [...plan.sourcePaths].reverse() },
      { ...plan, sourcePaths: [...plan.sourcePaths, plan.sourcePaths[0]] },
    ]) expect(() => validateV7AssemblyPlan(badPlan)).toThrow();
    expect(() => prepareV7Sources(inputs.slice(1))).toThrow(/fixed source path/);
    expect(() => prepareV7Sources([{ ...inputs[0], sourcePath: 'data/defi-catalog/v7/sources/unreviewed.json' }, ...inputs.slice(1)])).toThrow(/fixed source path/);

    const mutations: Array<(copy: any[]) => void> = [
      (copy) => { copy[0].document.families[0].familyVersion = 'unknown-version'; },
      (copy) => { copy[0].document.families[0].contracts[0].address = '0x0000000000000000000000000000000000000001'; },
      (copy) => { copy[0].document.families[0].contracts[0].sourceRefs = ['missing-reference']; },
      (copy) => { copy[0].document.families[0].contracts[0].abiFunctions[0].outputs[0].name = 'altered'; },
      (copy) => { copy[0].document.families[0].contracts[0].abiFunctions.pop(); },
      (copy) => { copy[0].document.families[0].contracts[0].abiFunctions.push({ ...copy[0].document.families[0].contracts[0].abiFunctions[0] }); },
    ];
    for (const mutate of mutations) {
      const changed = JSON.parse(JSON.stringify(inputs)); mutate(changed);
      expect(() => prepareV7Sources(changed)).toThrow();
    }
    const noScopeRef = JSON.parse(JSON.stringify(inputs)); noScopeRef[0].document.sources[0].sourceId = 'changed-source-id';
    expect(() => prepareV7Sources(noScopeRef)).toThrow();

    const admissionMutations: Array<(copy: any) => void> = [
      (copy) => { copy.snapshots[0].canonicalSha256 = '0'.repeat(64); },
      (copy) => { copy.snapshots[0].bindings[0].capabilityId = 'unreviewed:id'; },
      (copy) => { copy.snapshots[0].bindings[0].abiHash = `0x${'0'.repeat(64)}`; },
      (copy) => { copy.snapshots[0].bindings[0].selector = '0xdeadbeef'; },
      (copy) => { copy.snapshots[0].bindings[0].executionScopeHash = `0x${'0'.repeat(64)}`; },
      (copy) => { delete copy.snapshots[0].bindings[0].executionScope; },
      (copy) => { delete copy.snapshots[0].bindings[0].executionScopeHash; },
      (copy) => { copy.snapshots[0].bindings.pop(); },
      (copy) => { copy.snapshots[0].bindings.push({ ...copy.snapshots[0].bindings[0] }); },
      (copy) => { copy.snapshots[0].bindings[0].executionScope = { kind: 'empty-callback-data-v1', bytesArgIndex: 0 }; copy.snapshots[0].bindings[0].executionScopeHash = executionScopeHash(copy.snapshots[0].bindings[0].executionScope); },
      (copy) => { copy.snapshots[0].sourcePath = 'data/defi-catalog/v7/sources/unreviewed.json'; },
    ];
    for (const mutate of admissionMutations) {
      const changed = JSON.parse(JSON.stringify(admissions)); mutate(changed);
      expect(() => assembleV7SourceCandidates({ chains: v6.chains }, plan, inputs, changed)).toThrow();
    }
    const asymmetricNulls = JSON.parse(JSON.stringify(admissions)); asymmetricNulls.snapshots[0].bindings[0].executionScopeHash = '0x' + '0'.repeat(64);
    expect(() => assembleV7SourceCandidates({ chains: v6.chains }, plan, inputs, asymmetricNulls)).toThrow(/inconsistent null execution-scope pair/);
    expect(() => assembleV7SourceCandidates({ chains: v6.chains.slice(1) }, plan, inputs)).toThrow(/640-definition, 15-scope v6 baseline/);
    expect(() => assembleV7SourceCandidates({ chains: v6.chains }, { ...plan, sourcePaths: plan.sourcePaths.slice(1) }, inputs)).toThrow();
    expect(buildReviewedManifest([v6]).capabilities).toHaveLength(640);
  });

  it('prepares the single exact v8 Enso root over frozen v7 without admission or writes', () => {
    const baselineBytes = readFileSync(resolve(process.cwd(), 'data/defi-catalog/v7/catalog.json'));
    const baselineRawSha256 = createHash('sha256').update(baselineBytes).digest('hex');
    const baseline = validateCatalogDocument(JSON.parse(baselineBytes.toString('utf8')));
    const planValue = JSON.parse(readFileSync(resolve(process.cwd(), V8_ASSEMBLY_PLAN_PATH), 'utf8'));
    const plan = validateV8AssemblyPlan(planValue);
    const inputs = V8_SOURCE_PATHS.map((sourcePath) => ({ sourcePath, document: JSON.parse(readFileSync(resolve(process.cwd(), sourcePath), 'utf8')) as unknown }));
    const report = prepareV8Sources(inputs);
    expect(report).toMatchObject({ sourceCount: 1, familyCount: 1, targetCount: 1, bindingCount: 1 });
    expect(report.sourceDigests).toEqual([{ sourcePath: V8_SOURCE_PATHS[0], canonicalSha256: V8_SOURCE_CANONICAL_SHA256 }]);
    expect(report.bindings[0]).toMatchObject({
      familyId: 'enso', familyVersion: 'router-static-weiroll-v1@c032c8f9', chainId: 1,
      contract: V8_ROOT_IDENTITY.contract, signature: V8_ROOT_IDENTITY.signature, selector: '0xb94c3609',
      capabilityId: V8_ROOT_IDENTITY.capabilityId, abiHash: V8_ROOT_IDENTITY.abiHash,
      executionScope: createEnsoStaticWeirollScope(), executionScopeHash: '0xf55170b87634460f24a5f4ced30d21b134bf950327078b5f31e0bfe2074959e5',
    });
    const inactive = assembleV8SourceCandidates({ chains: baseline.chains }, plan, inputs, baselineRawSha256);
    const diff = catalogDiff(baseline, inactive);
    expect(diff.added).toEqual([V8_ROOT_IDENTITY.capabilityId]);
    expect(diff).toMatchObject({ removed: [], authorityChanged: [], abiChanged: [], metadataChanged: [] });
    const inactiveCapabilities = inactive.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
    expect(inactiveCapabilities).toHaveLength(669);
    expect(inactiveCapabilities.filter((fn) => fn.executionScope)).toHaveLength(16);
    const candidate = inactiveCapabilities.find((fn) => fn.capabilityId === V8_ROOT_IDENTITY.capabilityId)!;
    expect(candidate).toMatchObject({ status: 'inactive', provenance: { status: 'candidate' }, capabilityId: V8_ROOT_IDENTITY.capabilityId });
    expect(candidate.executionScope).toEqual(createEnsoStaticWeirollScope());
    const beforeById = new Map(baseline.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => [fn.capabilityId, fn] as const))));
    const afterById = new Map(inactiveCapabilities.map((fn) => [fn.capabilityId, fn] as const));
    expect(beforeById.size).toBe(668);
    for (const [id, fn] of beforeById) expect(afterById.get(id)).toEqual(fn);
    expect(buildReviewedManifest([inactive]).capabilities).toHaveLength(669);
    expect(renderGeneratedModule(inactive)).toBe(renderGeneratedModule(assembleV8SourceCandidates({ chains: baseline.chains }, plan, inputs, baselineRawSha256)));

    const admission = JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v8/admissions.json'), 'utf8'));
    const admitted = assembleV8SourceCandidates({ chains: baseline.chains }, plan, inputs, baselineRawSha256, admission);
    const admittedCapabilities = admitted.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
    expect(admittedCapabilities).toHaveLength(669);
    expect(admittedCapabilities.filter((fn) => fn.executionScope)).toHaveLength(16);
    expect(admittedCapabilities.find((fn) => fn.capabilityId === V8_ROOT_IDENTITY.capabilityId)).toMatchObject({ status: 'active', provenance: { status: 'verified' } });
    expect(buildReviewedManifest([admitted]).capabilities).toHaveLength(669);

    for (const badPlan of [
      { ...planValue, extra: true }, { ...planValue, baselinePath: 'data/defi-catalog/v6/catalog.json' },
      { ...planValue, baselineRawSha256: '0'.repeat(64) }, { ...planValue, sourceCanonicalSha256: '0'.repeat(64) },
      { ...planValue, baselineManifestHash: '0x' + '0'.repeat(64) },
      { ...planValue, sourcePaths: [] }, { ...planValue, sourcePaths: [...planValue.sourcePaths, V8_SOURCE_PATHS[0]] },
      { ...planValue, sourcePaths: ['data/defi-catalog/v8/sources/unreviewed.json'] },
    ]) expect(() => validateV8AssemblyPlan(badPlan)).toThrow();
    expect(() => assembleV8SourceCandidates({ chains: baseline.chains }, plan, inputs, '0'.repeat(64))).toThrow(/baseline catalog hash/);
    expect(() => prepareV8Sources([])).toThrow(/single fixed Enso source path/);
    expect(() => prepareV8Sources([{ ...inputs[0], sourcePath: 'data/defi-catalog/v8/sources/other.json' }])).toThrow(/single fixed Enso source path/);
    expect(() => assembleV8SourceCandidates({ chains: baseline.chains }, plan, [{ ...inputs[0], document: { ...(inputs[0].document as any), unexpected: true } }], baselineRawSha256)).toThrow(/canonical source digest/);
    const sourceMutations: Array<(source: any) => void> = [
      (source) => { source.families[0].familyId = 'unknown-family'; },
      (source) => { source.families[0].familyVersion = 'unknown-version'; },
      (source) => { source.families[0].contracts[0].address = '0x0000000000000000000000000000000000000001'; },
      (source) => { source.families[0].contracts[0].sourceRefs.pop(); },
      (source) => { source.families[0].contracts[0].abiFunctions[0].outputs[0].name = 'altered'; },
      (source) => { source.families[0].contracts[0].abiFunctions[0].sourceId = 'unknown-source'; },
      (source) => { source.families[0].contracts[0].abiFunctions.push({ ...source.families[0].contracts[0].abiFunctions[0] }); },
    ];
    for (const mutate of sourceMutations) {
      const changed = JSON.parse(JSON.stringify(inputs[0].document));
      mutate(changed);
      expect(() => prepareV8Sources([{ ...inputs[0], document: changed }])).toThrow();
    }
    expect(() => assembleV8SourceCandidates({ chains: baseline.chains.slice(1) }, plan, inputs, baselineRawSha256)).toThrow(/baseline manifest identity/);

    const badAdmissionMutations: Array<(copy: any) => void> = [
      (copy) => { copy.snapshots[0].canonicalSha256 = '0'.repeat(64); },
      (copy) => { copy.snapshots[0].sourcePath = 'data/defi-catalog/v8/sources/other.json'; },
      (copy) => { copy.extra = true; },
      (copy) => { copy.snapshots[0].bindings[0].capabilityId = 'unreviewed:route'; },
      (copy) => { copy.snapshots[0].bindings[0].signature = 'routeMulti(bytes)'; },
      (copy) => { copy.snapshots[0].bindings[0].abiHash = '0x' + '0'.repeat(64); },
      (copy) => { copy.snapshots[0].bindings[0].selector = '0xdeadbeef'; },
      (copy) => { copy.snapshots[0].bindings[0].executionScope = null; },
      (copy) => { copy.snapshots[0].bindings[0].executionScopeHash = null; },
      (copy) => { copy.snapshots[0].bindings[0].executionScope = null; copy.snapshots[0].bindings[0].executionScopeHash = null; },
      (copy) => { copy.snapshots[0].bindings[0].executionScopeHash = '0x' + '0'.repeat(64); },
      (copy) => { copy.snapshots[0].bindings[0].executionScope = { kind: 'empty-callback-data-v1', bytesArgIndex: 0 }; },
      (copy) => { copy.snapshots[0].bindings[0].executionScope.allowedChildren = []; },
      (copy) => { copy.snapshots[0].bindings[0].extra = true; },
      (copy) => { copy.snapshots[0].bindings.pop(); },
      (copy) => { copy.snapshots[0].bindings.push({ ...copy.snapshots[0].bindings[0] }); },
      (copy) => { copy.snapshots.pop(); },
      (copy) => { delete copy.snapshots[0].bindings[0].executionScopeHash; },
    ];
    for (const mutate of badAdmissionMutations) {
      const badAdmission = JSON.parse(JSON.stringify(admission));
      mutate(badAdmission);
      expect(() => assembleV8SourceCandidates({ chains: baseline.chains }, plan, inputs, baselineRawSha256, badAdmission)).toThrow();
    }
  });

  it('prepares exactly four inactive sDAI candidates and accepts only a bijective scope-free synthetic projection', () => {
    const bytes = readFileSync(resolve(process.cwd(), 'data/defi-catalog/v8/catalog.json'));
    const baselineRawSha256 = createHash('sha256').update(bytes).digest('hex');
    const baseline = validateCatalogDocument(JSON.parse(bytes.toString('utf8')));
    const planValue = JSON.parse(readFileSync(resolve(process.cwd(), V9_ASSEMBLY_PLAN_PATH), 'utf8'));
    const plan = validateV9AssemblyPlan(planValue);
    const inputs = V9_SOURCE_PATHS.map((sourcePath) => ({ sourcePath, document: JSON.parse(readFileSync(resolve(process.cwd(), sourcePath), 'utf8')) as unknown }));
    expect(baselineRawSha256).toBe(V9_BASELINE_RAW_SHA256);
    expect(prepareV9Sources(inputs)).toMatchObject({ sourceCount: 1, familyCount: 1, targetCount: 1, bindingCount: 4, sourceDigests: [{ canonicalSha256: V9_SOURCE_CANONICAL_SHA256 }] });
    const inactive = assembleV9SourceCandidates({ chains: baseline.chains }, plan, inputs, baselineRawSha256);
    const diff = catalogDiff(baseline, inactive);
    expect(diff).toMatchObject({ added: expect.arrayContaining(['sdai-savings:no-referral-v1:1:0x83f20f44975d03b1b09e64809b757c47f942beea:deposit']), removed: [], authorityChanged: [], abiChanged: [], metadataChanged: [] });
    expect(diff.added).toHaveLength(4);
    const inactiveFns = buildReviewedManifest([inactive]).capabilities;
    expect(inactiveFns).toHaveLength(673);
    expect(inactiveFns.filter((fn) => fn.executionScope)).toHaveLength(16);
    for (const id of diff.added) {
      const candidate = inactiveFns.find((fn) => fn.capabilityId === id)!;
      expect(candidate).toMatchObject({ status: 'inactive', provenance: { status: 'candidate' } });
      expect(candidate.executionScope).toBeUndefined();
    }
    const bindings = prepareV9Sources(inputs).bindings;
    const admissions = { schemaVersion: 1, snapshots: [{ sourcePath: V9_SOURCE_PATHS[0], canonicalSha256: V9_SOURCE_CANONICAL_SHA256, bindings: bindings.map(({ familyId, chainId, contract, signature, selector, abiHash, capabilityId }) => ({ familyId, chainId, contract, signature, selector, abiHash, capabilityId, executionScope: null, executionScopeHash: null })) }] };
    const projected = assembleV9SourceCandidates({ chains: baseline.chains }, plan, inputs, baselineRawSha256, admissions);
    const projection = buildReviewedManifest([projected]).capabilities;
    expect(projection).toHaveLength(673);
    expect(projection.filter((fn) => fn.status === 'active')).toHaveLength(673);
    expect(projection.filter((fn) => fn.capabilityId.startsWith('sdai-savings:'))).toHaveLength(4);
    expect(projection.filter((fn) => fn.operation === 'approve')).toHaveLength(23);
    expect(projection.filter((fn) => fn.operation !== 'approve')).toHaveLength(650);
    expect(projection.filter((fn) => fn.executionScope)).toHaveLength(16);
    expect(renderGeneratedModule(projected)).toBe(renderGeneratedModule(assembleV9SourceCandidates({ chains: baseline.chains }, plan, inputs, baselineRawSha256, admissions)));
    const fixedAdmissions = JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v9/admissions.json'), 'utf8'));
    const fixedAssembly = assembleV9SourceCandidates({ chains: baseline.chains }, plan, inputs, baselineRawSha256, fixedAdmissions);
    const savedV9 = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v9/catalog.json'), 'utf8')));
    expect(stableCatalogJson(fixedAssembly)).toBe(stableCatalogJson(savedV9));
    expect(renderGeneratedModule(fixedAssembly)).toBe(renderGeneratedModule({ chains: savedV9.chains }));
    expect(() => validateV9AssemblyPlan({ ...planValue, baselineRawSha256: '0'.repeat(64) })).toThrow();
    const badAdmission = JSON.parse(JSON.stringify(admissions)); badAdmission.snapshots[0].bindings[0].executionScopeHash = '0x' + '0'.repeat(64);
    expect(() => assembleV9SourceCandidates({ chains: baseline.chains }, plan, inputs, baselineRawSha256, badAdmission)).toThrow();
    expect(() => prepareV9Sources([])).toThrow(/single fixed sDAI source path/);
    expect(() => assembleV9SourceCandidates({ chains: baseline.chains }, plan, inputs, '0'.repeat(64))).toThrow(/baseline catalog or manifest identity/);
  });

  it('pins the complete pre-migration 202-definition snapshot, hierarchy, and 179/23 action-approval split', () => {
    const dataRoot = resolve(process.cwd(), 'data/defi-catalog/v1');
    const baseline = validateBaseline(JSON.parse(readFileSync(resolve(dataRoot, 'pre-migration-baseline.json'), 'utf8')));
    const catalog = validateCatalogDocument(JSON.parse(readFileSync(resolve(dataRoot, 'catalog.json'), 'utf8')));
    const capabilities = buildReviewedManifest([catalog]).capabilities;
    expect(capabilities).toHaveLength(202);
    expect(capabilities.filter((fn) => fn.type === 'contract_call' && fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).toHaveLength(23);
    expect(capabilities).toHaveLength(179 + 23);
    expect(buildReviewedManifest([catalog]).manifestHash).toBe(BASELINE_MANIFEST_HASH);
    expect(baseline.chains.map((chain) => chain.chainId)).toEqual([1, 10, 56, 137, 143, 8453, 42161]);
    expect(catalogDiff({ chains: baseline.chains }, catalog)).toEqual({ added: [], removed: [], authorityChanged: [], abiChanged: [], metadataChanged: [] });
  });

  it('retains all 202 baseline definitions unchanged in the 315-definition source-assembled v2 catalog', () => {
    const dataRoot = resolve(process.cwd(), 'data/defi-catalog');
    const baseline = validateBaseline(JSON.parse(readFileSync(resolve(dataRoot, 'v1/pre-migration-baseline.json'), 'utf8')));
    const v1 = validateCatalogDocument(JSON.parse(readFileSync(resolve(dataRoot, 'v1/catalog.json'), 'utf8')));
    const v2 = validateCatalogDocument(JSON.parse(readFileSync(resolve(dataRoot, 'v2/catalog.json'), 'utf8')));
    expect(buildReviewedManifest([v2]).capabilities).toHaveLength(315);
    expect(catalogDiff(v1, v2)).toMatchObject({ removed: [], authorityChanged: [], abiChanged: [], metadataChanged: [] });
    expect(catalogDiff(v1, v2).added).toHaveLength(113);
    expect(() => assertBaselinePreserved(v2, baseline)).not.toThrow();
    const replacement = validateCatalogDocument({ schemaVersion: 1, chains: v2.chains.map((chain, index) => index === 0 ? { ...chain, contracts: chain.contracts.map((contract, ci) => ci === 0 ? { ...contract, functions: contract.functions.map((fn, fi) => fi === 0 ? { ...fn, label: `${fn.label} revised` } : fn) } : contract) } : chain) });
    expect(() => assertBaselinePreserved(replacement, baseline)).toThrow(/Pinned baseline definition changed/);
  });

  it('parses versioned repository inputs and rejects arbitrary paths/options', () => {
    expect(parseCatalogCliArgs(['check'])).toEqual({ mode: 'check', inputPath: 'data/defi-catalog/v9/catalog.json' });
    expect(parseCatalogCliArgs(['generate', '--input', 'data/defi-catalog/v2/catalog.json'])).toEqual({ mode: 'generate', inputPath: 'data/defi-catalog/v2/catalog.json' });
    expect(parseCatalogCliArgs(['assemble'])).toEqual({ mode: 'assemble', inputPath: 'data/defi-catalog/v9/catalog.json' });
    expect(parseCatalogCliArgs(['assemble', '--input', 'data/defi-catalog/v8/catalog.json'])).toEqual({ mode: 'assemble', inputPath: 'data/defi-catalog/v8/catalog.json' });
    expect(parseCatalogCliArgs(['prepare-v9'])).toEqual({ mode: 'prepare-v9', inputPath: 'data/defi-catalog/v9/assembly-plan.json' });
    expect(parseCatalogCliArgs(['prepare-v9', '--input', 'data/defi-catalog/v9/assembly-plan.json'])).toEqual({ mode: 'prepare-v9', inputPath: 'data/defi-catalog/v9/assembly-plan.json' });
    expect(parseCatalogCliArgs(['assemble', '--input', 'data/defi-catalog/v7/catalog.json'])).toEqual({ mode: 'assemble', inputPath: 'data/defi-catalog/v7/catalog.json' });
    expect(parseCatalogCliArgs(['prepare-v8'])).toEqual({ mode: 'prepare-v8', inputPath: V8_ASSEMBLY_PLAN_PATH });
    expect(parseCatalogCliArgs(['prepare-v8', '--input', V8_ASSEMBLY_PLAN_PATH])).toEqual({ mode: 'prepare-v8', inputPath: V8_ASSEMBLY_PLAN_PATH });
    expect(() => parseCatalogCliArgs(['prepare-v8', '--input', 'data/defi-catalog/v7/catalog.json'])).toThrow();
    expect(parseCatalogCliArgs(['assemble', '--input', 'data/defi-catalog/v3/catalog.json'])).toEqual({ mode: 'assemble', inputPath: 'data/defi-catalog/v3/catalog.json' });
    expect(parseCatalogCliArgs(['assemble', '--input', 'data/defi-catalog/v4/catalog.json'])).toEqual({ mode: 'assemble', inputPath: 'data/defi-catalog/v4/catalog.json' });
    expect(parseCatalogCliArgs(['generate', '--input', 'data/defi-catalog/v4/catalog.json'])).toEqual({ mode: 'generate', inputPath: 'data/defi-catalog/v4/catalog.json' });
    expect(parseCatalogCliArgs(['check', '--input', 'data/defi-catalog/v4/catalog.json'])).toEqual({ mode: 'check', inputPath: 'data/defi-catalog/v4/catalog.json' });
    expect(parseCatalogCliArgs(['generate', '--input', 'data/defi-catalog/v5/catalog.json'])).toEqual({ mode: 'generate', inputPath: 'data/defi-catalog/v5/catalog.json' });
    expect(parseCatalogCliArgs(['assemble', '--input', 'data/defi-catalog/v5/catalog.json'])).toEqual({ mode: 'assemble', inputPath: 'data/defi-catalog/v5/catalog.json' });
    expect(parseCatalogCliArgs(['assemble', '--input', 'data/defi-catalog/v6/catalog.json'])).toEqual({ mode: 'assemble', inputPath: 'data/defi-catalog/v6/catalog.json' });
    expect(parseCatalogCliArgs(['check', '--input', 'data/defi-catalog/v6/catalog.json'])).toEqual({ mode: 'check', inputPath: 'data/defi-catalog/v6/catalog.json' });
    expect(parseCatalogCliArgs(['prepare-v7'])).toEqual({ mode: 'prepare-v7', inputPath: 'data/defi-catalog/v7/assembly-plan.json' });
    expect(parseCatalogCliArgs(['prepare-v7', '--input', 'data/defi-catalog/v7/assembly-plan.json'])).toEqual({ mode: 'prepare-v7', inputPath: 'data/defi-catalog/v7/assembly-plan.json' });
    for (const args of [
      ['generate', '--input', '../catalog.json'],
      ['generate', '--input', 'https://example.invalid/catalog.json'],
      ['generate', '--input', '/etc/passwd'],
      ['generate', '--input', 'data/defi-catalog/v2/catalog.json', '--input', 'data/defi-catalog/v1/catalog.json'],
      ['generate', '--output', 'arbitrary.ts'],
      ['assemble', '--input', 'data/defi-catalog/v2/catalog.json'],
      ['prepare-v7', '--input', 'data/defi-catalog/v7/sources'],
    ]) expect(() => parseCatalogCliArgs(args)).toThrow();
  });

  it('allows a new inactive candidate ID while preserving every prior definition, but never activates unverified provenance', () => {
    const dataRoot = resolve(process.cwd(), 'data/defi-catalog');
    const baseline = validateBaseline(JSON.parse(readFileSync(resolve(dataRoot, 'v1/pre-migration-baseline.json'), 'utf8')));
    const v2 = validateCatalogDocument(JSON.parse(readFileSync(resolve(dataRoot, 'v1/catalog.json'), 'utf8')));
    const address = '0x0000000000000000000000000000000000000098';
    const candidate = { capabilityId: 'candidate:v2:1:0x0000000000000000000000000000000000000098:ping', type: 'contract_call' as const, chainId: 1, contract: address, functionName: 'ping', signature: 'ping()', abi: { type: 'function' as const, name: 'ping', stateMutability: 'nonpayable' as const, inputs: [], outputs: [] }, status: 'inactive' as const, provenance: { sourceRef: 'candidate source reference', verifiedAt: '2026-10-04', status: 'candidate' as const } };
    const appended = validateCatalogDocument({ schemaVersion: 1, chains: v2.chains.map((chain) => chain.chainId === 1 ? { ...chain, contracts: [...chain.contracts, { address, status: 'inactive' as const, functions: [candidate] }] } : chain) });
    expect(buildReviewedManifest([appended]).capabilities).toHaveLength(203);
    expect(catalogDiff(v2, appended)).toMatchObject({ added: [candidate.capabilityId], removed: [], authorityChanged: [], metadataChanged: [] });
    expect(() => assertBaselinePreserved(appended, baseline)).not.toThrow();
    expect(() => validateCatalogDocument({ schemaVersion: 1, chains: v2.chains.map((chain) => chain.chainId === 1 ? { ...chain, contracts: [...chain.contracts, { address, status: 'active' as const, functions: [{ ...candidate, capabilityId: `${candidate.capabilityId}:active`, status: 'active' as const }] }] } : chain) })).toThrow(/requires verified provenance/);
  });

  it('purely assembles strict frozen source snapshots as deterministic inactive candidates', () => {
    const dataRoot = resolve(process.cwd(), 'data/defi-catalog/v1');
    const baseline = validateCatalogDocument(JSON.parse(readFileSync(resolve(dataRoot, 'catalog.json'), 'utf8')));
    const source = {
      schemaVersion: 1,
      sources: [{ sourceId: 'official-test', url: 'https://example.org/abi.json', retrievedAtUtc: '2026-10-04', evidence: 'Locally frozen ABI artifact.' }],
      unresolved: [{ candidateId: 'not-admitted', reason: 'Address unresolved' }],
      families: [{ familyId: 'test-family', familyVersion: '1', contracts: [{ chainId: 1, address: '0x0000000000000000000000000000000000000098', contractName: 'TestVault', sourceRefs: ['official-test'], abiFunctions: [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [{ name: 'result', type: 'uint256' }] }] }] }],
    };
    const input = [{ sourcePath: 'dex-snapshot.json', document: source }];
    const assembled = assembleCatalogFromSources(baseline, input);
    expect(buildReviewedManifest([assembled]).capabilities).toHaveLength(203);
    const candidate = assembled.chains.find((chain) => chain.chainId === 1)!.contracts.find((contract) => contract.address.endsWith('0098'))!.functions[0];
    expect(candidate).toMatchObject({ status: 'inactive', provenance: { status: 'candidate', sourceRef: 'https://example.org/abi.json', verifiedAt: '2026-10-04' } });
    expect(candidate.warnings).toContain('Payable ABI: caller-supplied value is not bounded by this catalog entry.');
    expect(catalogDiff(baseline, assembleCatalogFromSources(baseline, input)).added).toEqual([candidate.capabilityId]);
    expect(() => assertBaselinePreserved(assembled, validateBaseline(JSON.parse(readFileSync(resolve(dataRoot, 'pre-migration-baseline.json'), 'utf8'))))).not.toThrow();
    expect(source.families[0].contracts[0].abiFunctions[0]).not.toHaveProperty('capabilityId');
  });

  it('rejects malformed evidence and preserves baseline authority when an inactive source copy matches', () => {
    const dataRoot = resolve(process.cwd(), 'data/defi-catalog/v1');
    const baseline = validateCatalogDocument(JSON.parse(readFileSync(resolve(dataRoot, 'catalog.json'), 'utf8')));
    const source = { schemaVersion: 1, sources: [{ sourceId: 's', url: 'https://example.org/abi.json', retrievedAtUtc: '2026-10-04', evidence: 'snapshot' }], unresolved: [], families: [{ familyId: 'f', familyVersion: '1', contracts: [{ chainId: 1, address: '0x0000000000000000000000000000000000000098', contractName: 'C', sourceRefs: ['s'], abiFunctions: [{ name: 'ping', stateMutability: 'nonpayable', inputs: [], outputs: [] }] }] }] };
    const input = [{ sourcePath: 'source.json', document: source }];
    const altered: any = JSON.parse(JSON.stringify(source)); altered.families[0].contracts[0].sourceRefs = ['missing'];
    expect(() => assembleCatalogFromSources(baseline, [{ ...input[0], document: altered }])).toThrow(/undeclared source references/);
    const unknown: any = JSON.parse(JSON.stringify(source)); unknown.families[0].contracts[0].chainId = 999;
    expect(() => assembleCatalogFromSources(baseline, [{ ...input[0], document: unknown }])).toThrow(/unsupported chain/);
    const extra: any = JSON.parse(JSON.stringify(source)); extra.families[0].contracts[0].abiFunctions[0].validator = 'execute arbitrary policy';
    expect(() => assembleCatalogFromSources(baseline, [{ ...input[0], document: extra }])).toThrow(/unsupported fields/);
    const explicitNullLedger: any = JSON.parse(JSON.stringify(source)); explicitNullLedger.unresolved = null;
    expect(() => assembleCatalogFromSources(baseline, [{ ...input[0], document: explicitNullLedger }])).toThrow(/unsupported source schema/);
    const sourceCollision: any = JSON.parse(JSON.stringify(source)); sourceCollision.families[0].contracts[0].address = baseline.chains[0].contracts[0].address;
    sourceCollision.families[0].contracts[0].abiFunctions[0] = { name: baseline.chains[0].contracts[0].functions[0].functionName, stateMutability: baseline.chains[0].contracts[0].functions[0].abi.stateMutability, inputs: baseline.chains[0].contracts[0].functions[0].abi.inputs, outputs: baseline.chains[0].contracts[0].functions[0].abi.outputs };
    const duplicateSource = assembleCatalogFromSources(baseline, [{ ...input[0], document: sourceCollision }]);
    expect(buildReviewedManifest([duplicateSource]).capabilities).toHaveLength(buildReviewedManifest([baseline]).capabilities.length);
    expect(duplicateSource.chains[0].contracts[0].functions[0]).toEqual(baseline.chains[0].contracts[0].functions[0]);
  });

  it('accepts the alternate strict nested-chain source format without activating copied policies', () => {
    const baseline = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v1/catalog.json'), 'utf8')));
    const document = {
      schemaVersion: 1,
      sources: [{ sourceId: 'nested-source', url: 'https://example.org/versioned-abi', retrievedAtUtc: '2026-10-04', evidence: 'Frozen source artifact.' }],
      unresolved: [],
      families: [{ familyId: 'nested-family', familyVersion: '2', chains: [{ chainId: 10, status: 'inactive', contracts: [{ address: '0x0000000000000000000000000000000000000099', status: 'inactive', functions: [{ capabilityId: 'source:nested:ping', type: 'contract_call', chainId: 10, contract: '0x0000000000000000000000000000000000000099', functionName: 'ping', signature: 'ping()', abi: { type: 'function', name: 'ping', stateMutability: 'nonpayable', inputs: [], outputs: [] }, status: 'inactive', provenance: { sourceRef: 'nested-source', verifiedAt: '2026-10-04', status: 'candidate' } }] }] }] }],
    };
    const assembled = assembleCatalogFromSources(baseline, [{ sourcePath: 'nested-source.json', document }]);
    expect(assembled.chains.find((chain) => chain.chainId === 10)!.contracts[0].functions[0]).toMatchObject({ status: 'inactive', provenance: { status: 'candidate', sourceRef: 'https://example.org/versioned-abi' } });
    expect(buildReviewedManifest([assembled]).capabilities).toHaveLength(203);
    const olderContractSourceRefs = JSON.parse(JSON.stringify(document));
    olderContractSourceRefs.families[0].chains[0].contracts[0].sourceRefs = ['nested-source'];
    expect(() => assembleCatalogFromSources(baseline, [{ sourcePath: 'nested-source.json', document: olderContractSourceRefs }])).toThrow(/unsupported fields/);
  });

  it('binds all 113 frozen source functions to explicit hashes and canonical ABI identities', () => {
    const root = resolve(process.cwd(), 'data/defi-catalog/v2');
    const baseline = validateCatalogDocument(JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v1/catalog.json'), 'utf8')));
    const paths = ['data/defi-catalog/v2/sources/dex.json', 'data/defi-catalog/v2/sources/lending-yield.json'];
    const inputs = paths.map((sourcePath) => ({ sourcePath, document: JSON.parse(readFileSync(resolve(process.cwd(), sourcePath), 'utf8')) }));
    const admission = JSON.parse(readFileSync(resolve(root, 'admissions.json'), 'utf8'));
    const sourceOnly = assembleCatalogFromSources(baseline, inputs);
    const candidateFns = sourceOnly.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => !baseline.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).some((prior) => prior.capabilityId === fn.capabilityId));
    expect(candidateFns).toHaveLength(113);
    expect(candidateFns.every((fn) => fn.status === 'inactive' && fn.provenance.status === 'candidate')).toBe(true);
    const assembled = assembleCatalogFromSources(baseline, inputs, admission);
    const admittedFns = assembled.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => candidateFns.some((candidate) => candidate.capabilityId === fn.capabilityId));
    expect(admittedFns).toHaveLength(113);
    expect(admittedFns.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified' && /^https:\/\//.test(fn.provenance.sourceRef))).toBe(true);
    expect(admittedFns.filter((fn) => fn.protocol === 'uniswap-v3-position-manager')).toHaveLength(35);
    expect(admittedFns.filter((fn) => fn.protocol === 'balancer-v2-vault')).toHaveLength(24);
    expect(admittedFns.filter((fn) => fn.protocol === 'aave-v3')).toHaveLength(12);
    expect(admittedFns.filter((fn) => fn.protocol === 'compound-iii')).toHaveLength(20);
    expect(admittedFns.filter((fn) => fn.protocol === 'compound-v2')).toHaveLength(22);
    expect(canonicalSourceSha256(inputs[0].document)).toBe(admission.snapshots[0].canonicalSha256);
    const changedHash: any = JSON.parse(JSON.stringify(admission)); changedHash.snapshots[0].canonicalSha256 = '0'.repeat(64);
    expect(() => assembleCatalogFromSources(baseline, inputs, changedHash)).toThrow(/hash does not match admission/);
    const changedAbi: any = JSON.parse(JSON.stringify(admission)); changedAbi.snapshots[0].bindings[0].abiHash = `0x${'0'.repeat(64)}`;
    expect(() => assembleCatalogFromSources(baseline, inputs, changedAbi)).toThrow(/does not match source ABI/);
    const missingBinding: any = JSON.parse(JSON.stringify(admission)); missingBinding.snapshots[0].bindings.pop();
    expect(() => assembleCatalogFromSources(baseline, inputs, missingBinding)).toThrow(/binding count mismatch/);
    const unknownField: any = JSON.parse(JSON.stringify(admission)); unknownField.unreviewed = true;
    expect(() => assembleCatalogFromSources(baseline, inputs, unknownField)).toThrow(/unsupported fields/);
    const changedSource: any = JSON.parse(JSON.stringify(inputs[0].document)); changedSource.families[0].contracts[0].abiFunctions[0].outputs[0].type = 'unknown-return-type';
    expect(() => assembleCatalogFromSources(baseline, [{ ...inputs[0], document: changedSource }, inputs[1]])).toThrow();
    expect(() => assembleCatalogFromSources(baseline, [{ ...inputs[0], document: changedSource }, inputs[1]], admission)).toThrow(/hash does not match admission/);
    const malformedGap: any = JSON.parse(JSON.stringify(inputs[1].document)); malformedGap.unresolved[0].chainIds = [999];
    expect(() => assembleCatalogFromSources(baseline, [inputs[0], { ...inputs[1], document: malformedGap }])).toThrow(/unsupported chainIds/);
    const extraBinding: any = JSON.parse(JSON.stringify(admission)); extraBinding.snapshots[0].bindings.push({ ...extraBinding.snapshots[0].bindings[0], capabilityId: 'unknown:binding' });
    expect(() => assembleCatalogFromSources(baseline, inputs, extraBinding)).toThrow(/binding count mismatch/);
    expect(catalogDiff(baseline, assembled)).toMatchObject({ added: expect.arrayContaining(admittedFns.map((fn) => fn.capabilityId)), removed: [], authorityChanged: [], abiChanged: [], metadataChanged: [] });
  });

  it('assembles v3 as an offline 349-function catalog with 34 exact additions and 13 scope bindings', () => {
    const root = resolve(process.cwd(), 'data/defi-catalog');
    const v2 = validateCatalogDocument(JSON.parse(readFileSync(resolve(root, 'v2/catalog.json'), 'utf8')));
    const sourcePath = 'data/defi-catalog/v3/sources/workflow-extensions.json';
    const input = { sourcePath, document: JSON.parse(readFileSync(resolve(process.cwd(), sourcePath), 'utf8')) };
    const admissions = JSON.parse(readFileSync(resolve(root, 'v3/admissions.json'), 'utf8'));
    const assembled = assembleCatalogFromSources(v2, [input], admissions);
    const functions = buildReviewedManifest([assembled]).capabilities;
    const additions = catalogDiff(v2, assembled);
    expect(functions).toHaveLength(349);
    expect(additions).toMatchObject({ removed: [], authorityChanged: [], abiChanged: [], metadataChanged: [] });
    expect(additions.added).toHaveLength(34);
    expect(functions.filter((fn) => fn.executionScope)).toHaveLength(13);
    expect(functions.filter((fn) => fn.protocol === 'uniswap-v3-position-manager' && fn.executionScope?.kind === 'same-target-multicall-v1')).toHaveLength(7);
    expect(functions.filter((fn) => fn.protocol === 'morpho-blue' && fn.executionScope?.kind === 'empty-callback-data-v1')).toHaveLength(6);
    expect(functions.filter((fn) => fn.type === 'contract_call' && fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).toHaveLength(23);
    const outputPath = resolve(root, 'v3/catalog.json');
    const written = validateCatalogDocument(JSON.parse(readFileSync(outputPath, 'utf8')));
    expect(stableCatalogJson(written)).toBe(stableCatalogJson(assembled));
    expect(catalogDiff(v2, written)).toEqual(additions);
  });

  it('fails closed on malformed v3 scope hashes, missing scope, and altered child bindings', () => {
    const root = resolve(process.cwd(), 'data/defi-catalog');
    const v2 = validateCatalogDocument(JSON.parse(readFileSync(resolve(root, 'v2/catalog.json'), 'utf8')));
    const sourcePath = 'data/defi-catalog/v3/sources/workflow-extensions.json';
    const input = { sourcePath, document: JSON.parse(readFileSync(resolve(process.cwd(), sourcePath), 'utf8')) };
    const admission = JSON.parse(readFileSync(resolve(root, 'v3/admissions.json'), 'utf8'));
    const mutations = [
      (copy: any) => { const binding = copy.snapshots[0].bindings[0]; binding.chainId = 10; },
      (copy: any) => { const binding = copy.snapshots[0].bindings[0]; binding.contract = `0x${'0'.repeat(40)}`; },
      (copy: any) => { const binding = copy.snapshots[0].bindings[0]; binding.signature = 'invented()'; },
      (copy: any) => { const binding = copy.snapshots[0].bindings[0]; binding.abiHash = `0x${'0'.repeat(64)}`; },
      (copy: any) => { copy.snapshots[0].bindings[0].unreviewed = true; },
      (copy: any) => { copy.snapshots[0].bindings.find((binding: any) => binding.signature === 'multicall(bytes[])').executionScope = undefined; },
      (copy: any) => { copy.snapshots[0].bindings.find((binding: any) => binding.executionScope?.kind === 'same-target-multicall-v1').executionScopeHash = `0x${'0'.repeat(64)}`; },
      (copy: any) => { delete copy.snapshots[0].bindings.find((binding: any) => binding.executionScope?.kind === 'empty-callback-data-v1').executionScope; },
      (copy: any) => { copy.snapshots[0].bindings.find((binding: any) => binding.executionScope?.kind === 'same-target-multicall-v1').executionScope.allowedChildren[0].capabilityId = 'unknown:child'; },
      (copy: any) => { copy.snapshots[0].bindings.find((binding: any) => binding.executionScope?.kind === 'empty-callback-data-v1').executionScope.bytesArgIndex = 99; },
    ];
    for (const mutate of mutations) {
      const copy = JSON.parse(JSON.stringify(admission));
      mutate(copy);
      expect(() => assembleCatalogFromSources(v2, [input], copy)).toThrow();
    }
  });

  it('rejects null or missing mandatory scopes in real v3 Morpho and v4 Pancake admissions', () => {
    const root = resolve(process.cwd(), 'data/defi-catalog');
    const v2 = validateCatalogDocument(JSON.parse(readFileSync(resolve(root, 'v2/catalog.json'), 'utf8')));
    const v3Path = 'data/defi-catalog/v3/sources/workflow-extensions.json';
    const v3Inputs = [{ sourcePath: v3Path, document: JSON.parse(readFileSync(resolve(process.cwd(), v3Path), 'utf8')) }];
    const v3Admission = JSON.parse(readFileSync(resolve(root, 'v3/admissions.json'), 'utf8'));
    const morphoBinding = (copy: any) => copy.snapshots[0].bindings.find((binding: any) => binding.capabilityId.includes('morpho-blue') && binding.signature.startsWith('supply('));
    expect(assembleCatalogFromSources(v2, v3Inputs, v3Admission).chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).find((fn) => fn.capabilityId.includes('morpho-blue') && fn.signature.startsWith('supply('))?.executionScope).toBeDefined();

    const v3Mutations = [
      (binding: any) => { delete binding.executionScope; delete binding.executionScopeHash; },
      (binding: any) => { binding.executionScope = null; },
      (binding: any) => { binding.executionScopeHash = null; },
      (binding: any) => { binding.executionScope = null; binding.executionScopeHash = null; },
      (binding: any) => { delete binding.executionScope; },
      (binding: any) => { delete binding.executionScopeHash; },
    ];
    for (const mutate of v3Mutations) {
      const copy = JSON.parse(JSON.stringify(v3Admission)); mutate(morphoBinding(copy));
      expect(() => assembleCatalogFromSources(v2, v3Inputs, copy)).toThrow(/scope/i);
    }

    const v3 = validateCatalogDocument(JSON.parse(readFileSync(resolve(root, 'v3/catalog.json'), 'utf8')));
    const v4Paths = ['data/defi-catalog/v4/sources/ordinary-protocols.json', 'data/defi-catalog/v4/sources/yearn.json'];
    const v4Inputs = v4Paths.map((sourcePath) => ({ sourcePath, document: JSON.parse(readFileSync(resolve(process.cwd(), sourcePath), 'utf8')) }));
    const v4Admission = JSON.parse(readFileSync(resolve(root, 'v4/admissions.json'), 'utf8'));
    const pancakeBinding = (copy: any) => copy.snapshots.flatMap((snapshot: any) => snapshot.bindings).find((binding: any) => binding.capabilityId.startsWith('pancakeswap-v3-position-manager:') && binding.signature === 'multicall(bytes[])');
    const valid = assembleCatalogFromSources(v3, v4Inputs, v4Admission);
    expect(valid.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).find((fn) => fn.capabilityId.startsWith('pancakeswap-v3-position-manager:') && fn.signature === 'multicall(bytes[])')?.executionScope).toMatchObject({ kind: 'same-target-multicall-v1', allowedChildren: expect.any(Array) });
    for (const mutate of v3Mutations) {
      const copy = JSON.parse(JSON.stringify(v4Admission)); mutate(pancakeBinding(copy));
      expect(() => assembleCatalogFromSources(v3, v4Inputs, copy)).toThrow(/scope/i);
    }
    const elevenChildExploit = JSON.parse(JSON.stringify(v4Admission));
    const wrapperBinding = pancakeBinding(elevenChildExploit);
    delete wrapperBinding.executionScope;
    delete wrapperBinding.executionScopeHash;
    expect(() => assembleCatalogFromSources(v3, v4Inputs, elevenChildExploit)).toThrow(/scope/i);
  });

  it('assigns stable selector-qualified Yearn overload IDs while keeping v4 candidates inactive', () => {
    const root = resolve(process.cwd(), 'data/defi-catalog');
    const v3 = validateCatalogDocument(JSON.parse(readFileSync(resolve(root, 'v3/catalog.json'), 'utf8')));
    const sourcePath = 'data/defi-catalog/v4/sources/yearn.json';
    const source = JSON.parse(readFileSync(resolve(process.cwd(), sourcePath), 'utf8'));
    const input = [{ sourcePath, document: source }];
    const first = assembleCatalogFromSources(v3, input);
    const second = assembleCatalogFromSources(v3, [{ sourcePath, document: JSON.parse(JSON.stringify(source)) }]);
    expect(stableCatalogJson(first)).toBe(stableCatalogJson(second));
    const metadataOnly: any = JSON.parse(JSON.stringify(source)); metadataOnly.families[0].familyVersion = 'future-source-label'; metadataOnly.sources.forEach((record: any) => { record.retrievedAtUtc = '2026-10-05'; record.evidence = 'refreshed evidence copy'; });
    const refreshed = assembleCatalogFromSources(v3, [{ sourcePath, document: metadataOnly }]);
    const yearn = first.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => fn.protocol === 'yearn-tokenized-strategy');
    const refreshedYearn = refreshed.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => fn.protocol === 'yearn-tokenized-strategy');
    expect(yearn).toHaveLength(6);
    expect(refreshedYearn.map((fn) => fn.capabilityId).sort()).toEqual(yearn.map((fn) => fn.capabilityId).sort());
    expect(yearn.every((fn) => fn.status === 'inactive' && fn.provenance.status === 'candidate')).toBe(true);
    for (const name of ['withdraw', 'redeem']) {
      const overloads = yearn.filter((fn) => fn.functionName === name);
      expect(overloads).toHaveLength(2);
      expect(overloads[0].capabilityId).not.toBe(overloads[1].capabilityId);
      expect(overloads[0].capabilityId).toMatch(new RegExp(`:${toFunctionSelector(overloads[0].signature).slice(2)}$`));
      expect(overloads[1].capabilityId).toMatch(new RegExp(`:${toFunctionSelector(overloads[1].signature).slice(2)}$`));
    }
    expect(catalogDiff(v3, first)).toMatchObject({ removed: [], authorityChanged: [], abiChanged: [], metadataChanged: [] });
    expect(catalogDiff(v3, first).added).toHaveLength(6);
  });

  it('prepares the complete explicit v5 source cohort as inactive candidates matching all reviewed fixtures', () => {
    const root = resolve(process.cwd(), 'data/defi-catalog');
    const plan = validateV5AssemblyPlan(JSON.parse(readFileSync(resolve(process.cwd(), V5_ASSEMBLY_PLAN_PATH), 'utf8')));
    expect(plan).toEqual({ schemaVersion: 1, baselinePath: 'data/defi-catalog/v4/catalog.json', sourcePaths: [
      'data/defi-catalog/v5/sources/ambient.json', 'data/defi-catalog/v5/sources/aura.json', 'data/defi-catalog/v5/sources/beefy.json',
      'data/defi-catalog/v5/sources/camelot.json', 'data/defi-catalog/v5/sources/convex.json',
      'data/defi-catalog/v5/sources/dodo.json', 'data/defi-catalog/v5/sources/dolomite.json',
      'data/defi-catalog/v5/sources/etherfi.json', 'data/defi-catalog/v5/sources/euler.json', 'data/defi-catalog/v5/sources/fluid.json',
      'data/defi-catalog/v5/sources/kelp.json', 'data/defi-catalog/v5/sources/lfj.json',
      'data/defi-catalog/v5/sources/maverick.json', 'data/defi-catalog/v5/sources/moonwell.json',
      'data/defi-catalog/v5/sources/pendle.json', 'data/defi-catalog/v5/sources/quickswap.json',
      'data/defi-catalog/v5/sources/renzo.json', 'data/defi-catalog/v5/sources/rocket-pool.json',
      'data/defi-catalog/v5/sources/silo.json', 'data/defi-catalog/v5/sources/stakewise.json',
    ] });
    const v4 = validateCatalogDocument(JSON.parse(readFileSync(resolve(root, 'v4/catalog.json'), 'utf8')));
    const inputs = plan.sourcePaths.map((sourcePath) => ({ sourcePath, document: JSON.parse(readFileSync(resolve(process.cwd(), sourcePath), 'utf8')) }));
    const candidate = assembleV5SourceCandidates({ chains: v4.chains }, plan, inputs);
    const added = catalogDiff(v4, candidate).added;
    const v4Functions = buildReviewedManifest([v4]).capabilities;
    expect(v4Functions).toHaveLength(368);
    expect(v4Functions.filter((fn) => fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).toHaveLength(23);
    expect(v4Functions.filter((fn) => fn.executionScope !== undefined)).toHaveLength(14);
    expect(added).toHaveLength(138);
    const additions = candidate.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => added.includes(fn.capabilityId));
    expect(additions).toHaveLength(138);
    expect(additions.every((fn) => fn.status === 'inactive' && fn.provenance.status === 'candidate')).toBe(true);
    expect(buildReviewedManifest([candidate]).capabilities).toHaveLength(506);
    expect(catalogDiff(v4, candidate)).toMatchObject({ removed: [], authorityChanged: [], abiChanged: [], metadataChanged: [] });
    const sources = [buildQuickSwapV2Registry(), buildMoonwellRegistry(), buildFluidRegistry(), buildRocketPoolRegistry(),
      buildEtherfiRegistry(), buildCamelotRegistry(), buildLfjRegistry(), buildBeefyStandardRegistry(),
      buildKelpRegistry(), buildPendleV3Registry(), buildAmbientRegistry(), buildConvexRegistry(),
      buildMaverickV2Registry(), buildStakeWiseRegistry(), buildDodoV2Registry(), buildDolomiteRouterRegistry(),
      buildAuraRegistry(), buildEulerVaultRegistry(), buildRenzoRegistry(), buildSiloVaultRegistry()]
      .flatMap(({ chains }) => chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)));
    expect(sources).toHaveLength(138);
    const expectedIds = new Set(sources.map((fn) => fn.capabilityId));
    expect(additions.map((fn) => fn.capabilityId).sort()).toEqual([...expectedIds].sort());
    expect(additions.filter((fn) => fn.abi.stateMutability === 'payable')).toHaveLength(22);
    expect(additions.filter((fn) => fn.protocol === 'moonwell')).toHaveLength(17);
    expect(MOONWELL_CAPABILITIES).toHaveLength(17);
    const expectedCounts: Record<string, number> = {
      'quickswap-v2': 10, moonwell: 17, 'fluid-lending': 16, 'fluid-vault-t1': 1,
      'rocket-pool': 2, etherfi: 7, 'camelot-v2': 3, 'lfj-liquidity-book': 3,
      'beefy-standard': 8, kelp: 4, 'pendle-v3': 6, ambient: 1, convex: 6,
      'maverick-v2': 2, stakewise: 3, 'dodo-v2': 3, 'dolomite-router': 6,
      aura: 6, 'euler-vault': 12, 'euler-evc': 4, renzo: 6, 'silo-vault': 12,
    };
    for (const [family, count] of Object.entries(expectedCounts)) expect(additions.filter((fn) => fn.protocol === family)).toHaveLength(count);
    for (const input of inputs) {
      const doc = input.document as any;
      const digest = canonicalSourceSha256(doc);
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
      expect(canonicalSourceSha256(JSON.parse(JSON.stringify(doc)))).toBe(digest);
      expect(doc.sources.every((source: any) => Object.keys(source).sort().join(',') === 'evidence,retrievedAtUtc,sourceId,url')).toBe(true);
      expect(new Set(doc.sources.map((source: any) => source.sourceId)).size).toBe(doc.sources.length);
      for (const family of doc.families) {
        for (const contract of family.contracts ?? family.chains.flatMap((chain: any) => chain.contracts)) {
          if (contract.status !== undefined) expect(contract.status).toBe('inactive');
          for (const fn of contract.abiFunctions ?? contract.functions) if (fn.status !== undefined) expect(fn.status).toBe('inactive');
        }
      }
    }
    assertFixtureBindings(additions, sources);
    for (const fixture of sources) {
      const candidateFn = additions.find((fn) => fn.chainId === fixture.chainId && fn.contract.toLowerCase() === fixture.contract.toLowerCase() && fn.signature === fixture.signature)!;
      expect(candidateFn.abiHash).toBe(functionAbiHash(fixture));
    }
    const candidateById = new Map(candidate.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions.map((fn) => [fn.capabilityId, fn] as const))));
    for (const oldFn of v4.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions))) expect(candidateById.get(oldFn.capabilityId)).toEqual(oldFn);
    const fluidOverloads = additions.filter((fn) => fn.protocol === 'fluid-lending');
    expect(fluidOverloads).toHaveLength(16);
    for (const fn of fluidOverloads) expect(fn.capabilityId).toMatch(new RegExp(`:${toFunctionSelector(fn.signature).slice(2)}$`));
    expect(additions.find((fn) => fn.protocol === 'fluid-vault-t1')?.capabilityId).toMatch(/:operate$/);
    const moonwellSource = JSON.parse(readFileSync(resolve(process.cwd(), 'data/defi-catalog/v5/sources/moonwell.json'), 'utf8'));
    expect(moonwellSource.families[0].contracts[0].address).toBe('0xedc817a28e8b93b03976fbd4a3ddbc9f7d176c22');
    const missingHex = JSON.parse(JSON.stringify(moonwellSource));
    missingHex.families[0].contracts[0].address = '0xedc817a28e8b93b03976fb4a3ddbc9f7d176c22';
    expect(() => assembleV5SourceCandidates({ chains: v4.chains }, plan, inputs.map((input, index) => index === 1 ? { ...input, document: missingHex } : input))).toThrow(/address must be an EVM address/);
    const ambientIndex = inputs.findIndex((input) => input.sourcePath.endsWith('/ambient.json'));
    const missingAmbientScope = JSON.parse(JSON.stringify(inputs[ambientIndex].document));
    delete missingAmbientScope.families[0].chains[0].contracts[0].functions[0].executionScope;
    expect(() => assembleV5SourceCandidates({ chains: v4.chains }, plan, inputs.map((input, index) => index === ambientIndex ? { ...input, document: missingAmbientScope } : input))).toThrow(/mandatory cold-path scope/);
    const wrongAmbientScope = JSON.parse(JSON.stringify(inputs[ambientIndex].document));
    wrongAmbientScope.families[0].chains[0].contracts[0].functions[0].executionScope.bytesArgIndex = 2;
    expect(() => assembleV5SourceCandidates({ chains: v4.chains }, plan, inputs.map((input, index) => index === ambientIndex ? { ...input, document: wrongAmbientScope } : input))).toThrow();
    const wrongAmbientRoot = JSON.parse(JSON.stringify(inputs[ambientIndex].document));
    wrongAmbientRoot.families[0].chains[0].contracts[0].functions[0].contract = '0x0000000000000000000000000000000000000001';
    expect(() => assembleV5SourceCandidates({ chains: v4.chains }, plan, inputs.map((input, index) => index === ambientIndex ? { ...input, document: wrongAmbientRoot } : input))).toThrow(/identity\/status|Ethereum userCmd ABI/);
    const changedAbi = JSON.parse(JSON.stringify(inputs[ambientIndex].document));
    changedAbi.families[0].chains[0].contracts[0].functions[0].abi.outputs[0].type = 'uint256';
    expect(() => assembleV5SourceCandidates({ chains: v4.chains }, plan, inputs.map((input, index) => index === ambientIndex ? { ...input, document: changedAbi } : input))).toThrow(/exact Ethereum userCmd ABI/);
    const missingInternalType = JSON.parse(JSON.stringify(inputs[ambientIndex].document));
    delete missingInternalType.families[0].chains[0].contracts[0].functions[0].abi.inputs[0].internalType;
    expect(() => assembleV5SourceCandidates({ chains: v4.chains }, plan, inputs.map((input, index) => index === ambientIndex ? { ...input, document: missingInternalType } : input))).toThrow(/exact Ethereum userCmd ABI/);
    const nullAmbientScope = JSON.parse(JSON.stringify(inputs[ambientIndex].document));
    nullAmbientScope.families[0].chains[0].contracts[0].functions[0].executionScope = null;
    expect(() => assembleV5SourceCandidates({ chains: v4.chains }, plan, inputs.map((input, index) => index === ambientIndex ? { ...input, document: nullAmbientScope } : input))).toThrow();
    const dodoIndex = inputs.findIndex((input) => input.sourcePath.endsWith('/dodo.json'));
    const malformedDodoBool = JSON.parse(JSON.stringify(inputs[dodoIndex].document));
    const dodoFn = malformedDodoBool.families[0].chains[0].contracts[0].functions[0];
    dodoFn.abi.inputs.find((param: any) => param.type === 'bool').name = 'notUnnamed';
    const malformedDodo = assembleV5SourceCandidates({ chains: v4.chains }, plan, inputs.map((input, index) => index === dodoIndex ? { ...input, document: malformedDodoBool } : input));
    const malformedDodoAdded = malformedDodo.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => !v4.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).some((old) => old.capabilityId === fn.capabilityId));
    expect(() => assertFixtureBindings(malformedDodoAdded, sources)).toThrow(/Source\/fixture binding mismatch/);
    const lfjIndex = inputs.findIndex((input) => input.sourcePath.endsWith('/lfj.json'));
    const wrongLfjTuple = JSON.parse(JSON.stringify(inputs[lfjIndex].document));
    const tupleFn = wrongLfjTuple.families[0].contracts.flatMap((contract: any) => contract.abiFunctions).find((fn: any) => fn.inputs.some((param: any) => param.type.startsWith('tuple')));
    expect(tupleFn).toBeDefined();
    tupleFn.inputs.find((param: any) => param.type.startsWith('tuple')).components[0].type = 'uint8';
    const malformedTuple = assembleV5SourceCandidates({ chains: v4.chains }, plan, inputs.map((input, index) => index === lfjIndex ? { ...input, document: wrongLfjTuple } : input));
    const malformedTupleAdded = malformedTuple.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => !v4.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).some((old) => old.capabilityId === fn.capabilityId));
    expect(() => assertFixtureBindings(malformedTupleAdded, sources)).toThrow(/Source\/fixture target\/signature mismatch/);
  });

  it('strictly validates v5 plan paths and source candidacy and exposes only fixed v5 CLI routes', () => {
    const plan = JSON.parse(readFileSync(resolve(process.cwd(), V5_ASSEMBLY_PLAN_PATH), 'utf8'));
    const root = resolve(process.cwd(), 'data/defi-catalog');
    const v4 = validateCatalogDocument(JSON.parse(readFileSync(resolve(root, 'v4/catalog.json'), 'utf8')));
    const inputs = plan.sourcePaths.map((sourcePath: string) => ({ sourcePath, document: JSON.parse(readFileSync(resolve(process.cwd(), sourcePath), 'utf8')) }));
    for (const bad of [
      { ...plan, unexpected: true }, { ...plan, baselinePath: 'data/defi-catalog/v1/catalog.json' },
      { ...plan, sourcePaths: [...plan.sourcePaths, plan.sourcePaths[0]] },
      { ...plan, sourcePaths: ['../secret.json'] }, { ...plan, sourcePaths: [...plan.sourcePaths].reverse() },
      { ...plan, sourcePaths: plan.sourcePaths.slice(1) },
      { ...plan, sourcePaths: plan.sourcePaths.map((path: string) => `https://example.invalid/${path}`) },
    ]) expect(() => validateV5AssemblyPlan(bad)).toThrow();
    expect(() => assembleV5SourceCandidates({ chains: v4.chains }, plan, inputs.slice(1))).toThrow(/exactly match/);
    const forgedVersion = JSON.parse(JSON.stringify(inputs[0].document)); forgedVersion.families[0].familyVersion = 'made-up-version';
    expect(() => assembleV5SourceCandidates({ chains: v4.chains }, plan, [{ ...inputs[0], document: forgedVersion }, ...inputs.slice(1)])).toThrow(/familyVersion/);
    const forgedStatus = JSON.parse(JSON.stringify(inputs[0].document)); forgedStatus.families[0].chains[0].contracts[0].functions[0].status = 'active';
    expect(() => assembleV5SourceCandidates({ chains: v4.chains }, plan, [{ ...inputs[0], document: forgedStatus }, ...inputs.slice(1)])).toThrow(/identity\/status/);
    expect(parseCatalogCliArgs(['prepare-v5'])).toEqual({ mode: 'prepare-v5', inputPath: V5_ASSEMBLY_PLAN_PATH });
    const cli = resolve(process.cwd(), 'scripts/defi-catalog/cli.ts');
    const prepared = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', cli, 'prepare-v5'], { cwd: process.cwd(), encoding: 'utf8' });
    expect(prepared.status).toBe(0);
    expect(prepared.stdout).toMatch(/Prepared 138 inactive v5 source candidates from 20 explicit snapshots; no admission or catalog file was written/);
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'defi-v5-plan-symlink-'));
    try {
      const planDirectory = resolve(temporaryRoot, 'data/defi-catalog/v5');
      mkdirSync(planDirectory, { recursive: true });
      symlinkSync(resolve(process.cwd(), V5_ASSEMBLY_PLAN_PATH), resolve(planDirectory, 'assembly-plan.json'));
      const cliPath = resolve(process.cwd(), 'scripts/defi-catalog/cli.ts');
      const tsNodeRegister = resolve(process.cwd(), 'node_modules/ts-node/register/transpile-only');
      const symlinkedPlan = spawnSync(process.execPath, ['-r', tsNodeRegister, cliPath, 'prepare-v5'], { cwd: temporaryRoot, encoding: 'utf8', env: { ...process.env, TS_NODE_PROJECT: resolve(process.cwd(), 'tsconfig.json') } });
      expect(symlinkedPlan.status).toBe(1);
    expect(symlinkedPlan.stderr).toMatch(/fixed repository-owned file/);
    } finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
  });

  it('admits exactly 138 bound v5 functions onto the immutable 368-definition v4 baseline', () => {
    const root = resolve(process.cwd(), 'data/defi-catalog');
    const plan = validateV5AssemblyPlan(JSON.parse(readFileSync(resolve(process.cwd(), V5_ASSEMBLY_PLAN_PATH), 'utf8')));
    const v4 = validateCatalogDocument(JSON.parse(readFileSync(resolve(root, 'v4/catalog.json'), 'utf8')));
    const inputs = plan.sourcePaths.map((sourcePath) => ({ sourcePath, document: JSON.parse(readFileSync(resolve(process.cwd(), sourcePath), 'utf8')) }));
    const admissions = JSON.parse(readFileSync(resolve(root, 'v5/admissions.json'), 'utf8'));
    const admitted = assembleCatalogFromSources({ chains: v4.chains }, inputs, admissions);
    const output = validateCatalogDocument(JSON.parse(readFileSync(resolve(root, 'v5/catalog.json'), 'utf8')));
    expect(buildReviewedManifest([v4]).capabilities).toHaveLength(368);
    expect(buildReviewedManifest([v4]).capabilities.filter((fn) => fn.executionScope)).toHaveLength(14);
    expect(buildReviewedManifest([admitted]).capabilities).toHaveLength(506);
    expect(buildReviewedManifest([admitted]).capabilities.filter((fn) => fn.executionScope)).toHaveLength(15);
    expect(buildReviewedManifest([admitted]).capabilities.filter((fn) => fn.type === 'contract_call' && fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).toHaveLength(23);
    expect(catalogDiff(v4, admitted)).toMatchObject({ added: expect.any(Array), removed: [], authorityChanged: [], abiChanged: [], metadataChanged: [] });
    expect(catalogDiff(v4, admitted).added).toHaveLength(138);
    expect(stableCatalogJson(output)).toBe(stableCatalogJson(admitted));
    expect(admitted.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => fn.status === 'active')).toHaveLength(506);
    expect(admitted.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => fn.protocol === 'ambient')[0].executionScope).toEqual({ kind: 'ambient-coldpath-v1', callpathArgIndex: 0, bytesArgIndex: 1 });

    const mutate = (fn: (copy: any) => void) => { const copy = JSON.parse(JSON.stringify(admissions)); fn(copy); return copy; };
    const wrongHash = mutate((copy) => { copy.snapshots[0].canonicalSha256 = '0'.repeat(64); });
    expect(() => assembleCatalogFromSources({ chains: v4.chains }, inputs, wrongHash)).toThrow(/hash does not match admission/);
    const missing = mutate((copy) => { copy.snapshots[0].bindings.pop(); });
    expect(() => assembleCatalogFromSources({ chains: v4.chains }, inputs, missing)).toThrow(/binding count mismatch/);
    const extra = mutate((copy) => { copy.snapshots[0].bindings.push(copy.snapshots[0].bindings[0]); });
    expect(() => assembleCatalogFromSources({ chains: v4.chains }, inputs, extra)).toThrow(/binding count mismatch/);
    const ambient = admissions.snapshots.find((snapshot: any) => snapshot.sourcePath.endsWith('/ambient.json'));
    const ambientIndex = admissions.snapshots.indexOf(ambient);
    const noScope = mutate((copy) => { delete copy.snapshots[ambientIndex].bindings[0].executionScope; delete copy.snapshots[ambientIndex].bindings[0].executionScopeHash; });
    expect(() => assembleCatalogFromSources({ chains: v4.chains }, inputs, noScope)).toThrow(/scope|scope binding/i);
    const badScopeHash = mutate((copy) => { copy.snapshots[ambientIndex].bindings[0].executionScopeHash = `0x${'0'.repeat(64)}`; });
    expect(() => assembleCatalogFromSources({ chains: v4.chains }, inputs, badScopeHash)).toThrow(/scope hash mismatch/);
    expect(() => assembleCatalogFromSources({ chains: v4.chains }, inputs.slice(0, 1), { schemaVersion: 1, snapshots: [] })).toThrow(/complete selected v5 plan group/);

  });

  it('admits the exact v4 source group, preserves v3, and binds the Pancake wrapper to exactly eight scoped children', () => {
    const root = resolve(process.cwd(), 'data/defi-catalog');
    const v3 = validateCatalogDocument(JSON.parse(readFileSync(resolve(root, 'v3/catalog.json'), 'utf8')));
    const ordinaryPath = 'data/defi-catalog/v4/sources/ordinary-protocols.json';
    const yearnPath = 'data/defi-catalog/v4/sources/yearn.json';
    const inputs = [ordinaryPath, yearnPath].map((sourcePath) => ({ sourcePath, document: JSON.parse(readFileSync(resolve(process.cwd(), sourcePath), 'utf8')) }));
    const admission = JSON.parse(readFileSync(resolve(root, 'v4/admissions.json'), 'utf8'));
    const sourceOnly = assembleCatalogFromSources(v3, inputs);
    const candidates = sourceOnly.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).filter((fn) => !v3.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).some((old) => old.capabilityId === fn.capabilityId));
    expect(candidates).toHaveLength(19);
    expect(candidates.filter((fn) => fn.protocol === 'curve-3pool-stableswap')).toHaveLength(4);
    expect(candidates.filter((fn) => fn.protocol === 'pancakeswap-v3-position-manager')).toHaveLength(9);
    expect(candidates.filter((fn) => fn.protocol === 'yearn-tokenized-strategy')).toHaveLength(6);
    expect(candidates.every((fn) => fn.status === 'inactive' && fn.provenance.status === 'candidate')).toBe(true);
    const wrapper = candidates.find((fn) => fn.protocol === 'pancakeswap-v3-position-manager' && fn.signature === 'multicall(bytes[])')!;
    expect(wrapper.executionScope).toBeUndefined();
    const active = assembleCatalogFromSources(v3, inputs, admission);
    const all = buildReviewedManifest([active]).capabilities;
    const admitted = all.filter((fn) => candidates.some((candidate) => candidate.capabilityId === fn.capabilityId));
    expect(all).toHaveLength(368);
    expect(admitted).toHaveLength(19);
    expect(admitted.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified')).toBe(true);
    expect(admitted.filter((fn) => fn.executionScope)).toHaveLength(1);
    const scopedWrapper = admitted.find((fn) => fn.signature === 'multicall(bytes[])')!;
    expect(scopedWrapper.executionScope?.kind).toBe('same-target-multicall-v1');
    if (scopedWrapper.executionScope?.kind !== 'same-target-multicall-v1') throw new Error('Expected Pancake bounded multicall scope');
    expect(scopedWrapper.executionScope.allowedChildren).toHaveLength(8);
    expect(scopedWrapper.executionScope.allowedChildren.map((child) => child.capabilityId)).toEqual(admitted.filter((fn) => fn.protocol === 'pancakeswap-v3-position-manager' && fn.capabilityId !== scopedWrapper.capabilityId).map((fn) => fn.capabilityId).sort());
    expect(catalogDiff(v3, active)).toMatchObject({ added: expect.arrayContaining(admitted.map((fn) => fn.capabilityId)), removed: [], authorityChanged: [], abiChanged: [], metadataChanged: [] });
    expect(catalogDiff(v3, active).added).toHaveLength(19);
    const changedHash: any = JSON.parse(JSON.stringify(admission)); changedHash.snapshots[0].canonicalSha256 = '0'.repeat(64);
    expect(() => assembleCatalogFromSources(v3, inputs, changedHash)).toThrow(/hash does not match admission/);
    const changedId: any = JSON.parse(JSON.stringify(admission)); changedId.snapshots[1].bindings[0].capabilityId = 'yearn:invented';
    expect(() => assembleCatalogFromSources(v3, inputs, changedId)).toThrow(/does not match source ABI/);
    const wrongScope: any = JSON.parse(JSON.stringify(admission)); wrongScope.snapshots[0].bindings.find((binding: any) => binding.signature === 'multicall(bytes[])').executionScope.allowedChildren.pop();
    expect(() => assembleCatalogFromSources(v3, inputs, wrongScope)).toThrow();
    expect(() => assembleCatalogFromSources(v3, [inputs[1]], admission)).toThrow(/allowlisted v2 source snapshots/);
  });

  it('validates a versioned nested fragment and renders deterministic TypeScript without runtime imports', () => {
    const fragment = validateCatalogDocument(valid);
    expect(stableCatalogJson(fragment)).toBe(stableCatalogJson(validateCatalogDocument(JSON.parse(stableCatalogJson(fragment)))));
    const generated = renderGeneratedModule(fragment);
    expect(generated).toContain("import type { DefiRegistryFragment }");
    expect(generated).not.toContain('from "viem"');
    expect(buildReviewedManifest([fragment]).capabilities).toHaveLength(4);
  });

  it.each([
    [{ ...valid, schemaVersion: 2 }, /schemaVersion/],
    [{ ...valid, unknown: true }, /unsupported fields/],
    [{ ...valid, chains: [{ ...valid.chains[0], chainId: Number.POSITIVE_INFINITY }] }, /invalid fields/],
    [{ ...valid, chains: [{ ...valid.chains[0], contracts: [{ ...valid.chains[0].contracts[0], functions: [{ ...valid.chains[0].contracts[0].functions[0], extra: 'no' }] }] }] }, /unsupported fields/],
    [{ ...valid, chains: [{ ...valid.chains[0], contracts: [{ ...valid.chains[0].contracts[0], functions: [{ ...valid.chains[0].contracts[0].functions[0], abi: { ...valid.chains[0].contracts[0].functions[0].abi, outputs: [{ name: 'x', type: 'uint256', indexed: true }] } }] }] }] }, /unsupported fields/],
  ])('rejects malformed or unsupported catalog data', (document, error) => {
    expect(() => validateCatalogDocument(document)).toThrow(error);
  });

  it('fails closed on active unverified provenance, inconsistent ABI, duplicate IDs and colliding selectors', () => {
    const source = valid.chains[0];
    const contract = source.contracts[0];
    const fn = contract.functions[0];
    const withFunctions = (functions: unknown[]) => ({ schemaVersion: 1, chains: [{ ...source, contracts: [{ ...contract, functions }] }] });
    expect(() => validateCatalogDocument(withFunctions([{ ...fn, provenance: { ...fn.provenance, status: 'candidate' } }]))).toThrow(/requires verified provenance/);
    expect(() => validateCatalogDocument(withFunctions([{ ...fn, signature: 'wrong()' }]))).toThrow(/Inconsistent fixed DeFi ABI/);
    expect(() => validateCatalogDocument(withFunctions([fn, fn]))).toThrow(/Duplicate DeFi capability identity/);
    expect(() => validateCatalogDocument(withFunctions([fn, { ...fn, capabilityId: `${fn.capabilityId}:duplicate` }]))).toThrow(/Ambiguous DeFi selector/);
  });

  it('reports metadata changes separately from ABI identity and blocks baseline changes', () => {
    const before = validateCatalogDocument(valid);
    const fn = before.chains[0].contracts[0].functions[0];
    const after = validateCatalogDocument({ schemaVersion: 1, chains: [{ ...before.chains[0], contracts: [{ ...before.chains[0].contracts[0], functions: before.chains[0].contracts[0].functions.map((item) => item.capabilityId === fn.capabilityId ? { ...item, label: 'Changed copy' } : item) }] }] });
    expect(catalogDiff(before, after)).toMatchObject({ added: [], removed: [], authorityChanged: [], abiChanged: [], metadataChanged: [fn.capabilityId] });
    expect(() => assertBaselinePreserved(after, { schemaVersion: 1, baselineManifestHash: 'ignored', chains: before.chains } as never)).toThrow(/Pinned baseline definition changed/);
  });

  it('classifies same-ID target, chain, type, function, status, and ABI changes as authority changes', () => {
    const source = validateCatalogDocument(valid).chains[0];
    const baseFn = source.contracts[0].functions[0];
    const fragment = (fn: typeof baseFn, chainId = fn.chainId) => ({ chains: [{ chainId, status: 'active' as const, contracts: [{ address: fn.contract, status: 'active' as const, functions: [fn] }] }] });
    const cases = [
      { name: 'target', fn: { ...baseFn, contract: '0x0000000000000000000000000000000000000009' } },
      { name: 'chain', fn: { ...baseFn, chainId: 10 }, chainId: 10 },
      { name: 'type', fn: { ...baseFn, type: 'typed_data_sign' as const } },
      { name: 'functionName', fn: { ...baseFn, functionName: 'supplyElsewhere' } },
      { name: 'status', fn: { ...baseFn, status: 'inactive' as const } },
      { name: 'ABI/signature', fn: { ...baseFn, functionName: 'supplyElsewhere', signature: 'supplyElsewhere(address,uint256,address,uint16)', abi: { ...baseFn.abi, name: 'supplyElsewhere' } }, abiChanged: true },
    ];
    for (const item of cases) {
      const diff = catalogDiff(fragment(baseFn), fragment(item.fn, item.chainId));
      expect(diff.authorityChanged).toEqual([baseFn.capabilityId]);
      expect(diff.metadataChanged).toEqual([]);
      expect(diff.abiChanged).toEqual(item.abiChanged ? [baseFn.capabilityId] : []);
    }
  });

  it('classifies provenance source/date copy changes as metadata only', () => {
    const before = validateCatalogDocument(valid);
    const fn = before.chains[0].contracts[0].functions[0];
    for (const provenance of [
      { ...fn.provenance, sourceRef: 'new display/source reference' },
      { ...fn.provenance, verifiedAt: '2026-10-04' },
    ]) {
      const after = validateCatalogDocument({ schemaVersion: 1, chains: [{ ...before.chains[0], contracts: [{ ...before.chains[0].contracts[0], functions: before.chains[0].contracts[0].functions.map((item) => item.capabilityId === fn.capabilityId ? { ...item, provenance } : item) }] }] });
      expect(catalogDiff(before, after)).toMatchObject({ authorityChanged: [], abiChanged: [], metadataChanged: [fn.capabilityId] });
    }
  });

  it('classifies finite execution-scope changes as authority changes while preserving scope-free legacy identity', () => {
    const root = resolve(process.cwd(), 'data/defi-catalog');
    const v2 = validateCatalogDocument(JSON.parse(readFileSync(resolve(root, 'v2/catalog.json'), 'utf8')));
    const v3 = validateCatalogDocument(JSON.parse(readFileSync(resolve(root, 'v3/catalog.json'), 'utf8')));
    expect(catalogDiff(v2, v3)).toMatchObject({ authorityChanged: [], added: expect.any(Array) });
    const wrapper = v3.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).find((fn) => fn.signature === 'multicall(bytes[])')!;
    const scope = wrapper.executionScope!;
    const children = scope.kind === 'same-target-multicall-v1' ? scope.allowedChildren.map((child, index) => index === 0 ? { ...child, capabilityId: `${child.capabilityId}:revised` } : child) : [];
    const changed = { ...wrapper, executionScope: { ...scope, allowedChildren: children } as DefiExecutionScope };
    const one = { chains: [{ chainId: wrapper.chainId, status: 'active' as const, contracts: [{ address: wrapper.contract, status: 'active' as const, functions: [wrapper] }] }] };
    const two = { chains: [{ chainId: wrapper.chainId, status: 'active' as const, contracts: [{ address: wrapper.contract, status: 'active' as const, functions: [changed] }] }] };
    expect(catalogDiff(one, two).authorityChanged).toEqual([wrapper.capabilityId]);
    const scopeFree = v2.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).find((fn) => !fn.executionScope)!;
    expect(catalogDiff({ chains: [{ chainId: scopeFree.chainId, status: 'active', contracts: [{ address: scopeFree.contract, status: 'active', functions: [scopeFree] }] }] }, { chains: [{ chainId: scopeFree.chainId, status: 'active', contracts: [{ address: scopeFree.contract, status: 'active', functions: [{ ...scopeFree, executionScope: undefined }] }] }] }).authorityChanged).toEqual([]);
  });
});
