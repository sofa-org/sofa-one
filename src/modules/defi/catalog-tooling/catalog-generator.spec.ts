import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildReviewedManifest } from '../registry/defi-manifest';
import { assembleCatalogFromSources, assertBaselinePreserved, BASELINE_MANIFEST_HASH, canonicalSourceSha256, catalogDiff, parseCatalogCliArgs, renderGeneratedModule, stableCatalogJson, validateBaseline, validateCatalogDocument } from './catalog-generator';
import { functionAbiHash } from '../registry/defi-manifest';
import { toFunctionSelector } from 'viem';
import { buildSparkLendRegistry } from '../registry/spark-lend';

const valid = { schemaVersion: 1, chains: buildSparkLendRegistry().chains };

describe('DeFi catalog generator', () => {
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
    expect(parseCatalogCliArgs(['check'])).toEqual({ mode: 'check', inputPath: 'data/defi-catalog/v1/catalog.json' });
    expect(parseCatalogCliArgs(['generate', '--input', 'data/defi-catalog/v2/catalog.json'])).toEqual({ mode: 'generate', inputPath: 'data/defi-catalog/v2/catalog.json' });
    expect(parseCatalogCliArgs(['assemble'])).toEqual({ mode: 'assemble', inputPath: 'data/defi-catalog/v2/catalog.json' });
    expect(parseCatalogCliArgs(['assemble', '--input', 'data/defi-catalog/v3/catalog.json'])).toEqual({ mode: 'assemble', inputPath: 'data/defi-catalog/v3/catalog.json' });
    expect(parseCatalogCliArgs(['assemble', '--input', 'data/defi-catalog/v4/catalog.json'])).toEqual({ mode: 'assemble', inputPath: 'data/defi-catalog/v4/catalog.json' });
    expect(parseCatalogCliArgs(['generate', '--input', 'data/defi-catalog/v4/catalog.json'])).toEqual({ mode: 'generate', inputPath: 'data/defi-catalog/v4/catalog.json' });
    expect(parseCatalogCliArgs(['check', '--input', 'data/defi-catalog/v4/catalog.json'])).toEqual({ mode: 'check', inputPath: 'data/defi-catalog/v4/catalog.json' });
    for (const args of [
      ['generate', '--input', '../catalog.json'],
      ['generate', '--input', 'https://example.invalid/catalog.json'],
      ['generate', '--input', '/etc/passwd'],
      ['generate', '--input', 'data/defi-catalog/v2/catalog.json', '--input', 'data/defi-catalog/v1/catalog.json'],
      ['generate', '--output', 'arbitrary.ts'],
      ['assemble', '--input', 'data/defi-catalog/v2/catalog.json'],
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
    const changed = { ...wrapper, executionScope: { ...scope, allowedChildren: children } };
    const one = { chains: [{ chainId: wrapper.chainId, status: 'active' as const, contracts: [{ address: wrapper.contract, status: 'active' as const, functions: [wrapper] }] }] };
    const two = { chains: [{ chainId: wrapper.chainId, status: 'active' as const, contracts: [{ address: wrapper.contract, status: 'active' as const, functions: [changed] }] }] };
    expect(catalogDiff(one, two).authorityChanged).toEqual([wrapper.capabilityId]);
    const scopeFree = v2.chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions)).find((fn) => !fn.executionScope)!;
    expect(catalogDiff({ chains: [{ chainId: scopeFree.chainId, status: 'active', contracts: [{ address: scopeFree.contract, status: 'active', functions: [scopeFree] }] }] }, { chains: [{ chainId: scopeFree.chainId, status: 'active', contracts: [{ address: scopeFree.contract, status: 'active', functions: [{ ...scopeFree, executionScope: undefined }] }] }] }).authorityChanged).toEqual([]);
  });
});
