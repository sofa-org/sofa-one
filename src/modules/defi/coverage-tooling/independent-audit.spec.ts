import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PRODUCTION_DEFI_CAPABILITY_BUNDLES } from '../bundles/production-bundles';
import { compactArrayPropertyHash, evaluateGoalClosure, independentAudit, sha256, stableJson } from './independent-audit';
import type { AuditInputs, JsonObject, StaticProfile } from './independent-audit';
import type { JsonValue } from './independent-audit';
import { keccak256, stringToHex } from 'viem';

const jsonObject = (value: JsonValue | undefined): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const jsonArray = (value: JsonValue | undefined): JsonValue[] => Array.isArray(value) ? value : [];
const objectArray = (value: JsonValue | undefined): JsonObject[] => jsonArray(value).map((item) => jsonObject(item));
const catalogFunctions = (catalog: JsonObject): JsonObject[] => objectArray(catalog.chains).flatMap((chain) => objectArray(chain.contracts).flatMap((contract) => objectArray(contract.functions)));

const paths = {
  market: 'data/defi-coverage/market-snapshot.json', classification: 'data/defi-coverage/discovery-classification.json',
  m1Catalog: 'data/defi-catalog/v1/catalog.json', m2Catalog: 'data/defi-catalog/v2/catalog.json', m3Catalog: 'data/defi-catalog/v3/catalog.json',
  admissions: 'data/defi-catalog/v3/admissions.json', workflowExtensions: 'data/defi-catalog/v3/sources/workflow-extensions.json',
  m2Activity: 'data/defi-coverage/v2/activity-snapshot.json', m2ActivityMethods: 'data/defi-coverage/v2/activity-methods.json',
  m2Identity: 'data/defi-coverage/v2/identity-crosswalk.json', m2Evidence: 'data/defi-coverage/v2/normalization-evidence.json',
  m2WorkflowInventory: 'data/defi-coverage/v2/workflow-inventory.json', m2Normalized: 'data/defi-coverage/v2/normalized-input.json',
  m3Normalized: 'data/defi-coverage/v3/normalized-input.json', m3WorkflowInventory: 'data/defi-coverage/v3/workflow-inventory.json',
  m3ComparisonReport: 'data/defi-coverage/v3/coverage-report.json', m2CoverageReport: 'data/defi-coverage/v2/coverage-report.json',
  m2DexSource: 'data/defi-catalog/v2/sources/dex.json',
  v3ProfileFixture: 'src/modules/defi/catalog-tooling/__fixtures__/v3-bundle-baseline.json',
  currentV4Catalog: 'data/defi-catalog/v4/catalog.json',
  currentV4Admissions: 'data/defi-catalog/v4/admissions.json',
  currentV4OrdinarySource: 'data/defi-catalog/v4/sources/ordinary-protocols.json',
  currentV4YearnSource: 'data/defi-catalog/v4/sources/yearn.json',
  currentProfileSource: 'src/modules/defi/bundles/production-bundles.ts',
  legacyProfileFixture: 'src/modules/defi/bundles/__fixtures__/legacy-production-profiles-82d96a7.json',
} as const;

function loadInputs(): AuditInputs {
  const entries = Object.entries(paths).filter(([key]) => key !== 'currentProfileSource' && key !== 'legacyProfileFixture').map(([key, path]) => [key, JSON.parse(readFileSync(path, 'utf8'))] as const);
  const values = Object.fromEntries(entries) as Record<string, JsonObject>;
  const legacyProfileFixture = JSON.parse(readFileSync(paths.legacyProfileFixture, 'utf8')) as { profiles: StaticProfile[] };
  const legacyProfileSource = `PRODUCTION_DEFI_CAPABILITY_BUNDLES: readonly DefiCapabilityBundle[] = Object.freeze(${JSON.stringify(legacyProfileFixture.profiles)} as readonly DefiCapabilityBundle[]);`;
  const rawSha256 = Object.fromEntries(Object.values(paths).filter((path) => path !== paths.currentProfileSource && path !== paths.legacyProfileFixture).map((path) => [path, sha256(readFileSync(path))]));
  rawSha256[paths.currentProfileSource] = sha256(legacyProfileSource);
  const rawSourceContents = Object.fromEntries(Object.values(paths).filter((path) => path === paths.v3ProfileFixture || path.startsWith('data/defi-catalog/v4/')).map((path) => [path, readFileSync(path, 'utf8')]));
  rawSourceContents[paths.currentProfileSource] = legacyProfileSource;
  const marketText = readFileSync(paths.market, 'utf8');
  const fixture = values.v3ProfileFixture!;
  return {
    ...(values as unknown as Omit<AuditInputs, 'profiles' | 'rawSha256' | 'rawSourceContents' | 'protocolUniverseCompactSha256' | 'auditAsOf' | 'v3ProfileFixtureSha256' | 'v3ProfileFixture' | 'currentV4Profiles'>),
    catalogVersion: 'v4',
    profiles: objectArray(fixture.profiles) as unknown as StaticProfile[],
    v3ProfileFixture: fixture,
    v3ProfileFixtureSha256: rawSha256[paths.v3ProfileFixture],
    currentV4Catalog: values.currentV4Catalog!,
    currentV4Admissions: values.currentV4Admissions!,
    currentV4OrdinarySource: values.currentV4OrdinarySource!,
    currentV4YearnSource: values.currentV4YearnSource!,
    currentV4Profiles: legacyProfileFixture.profiles,
    rawSha256,
    rawSourceContents,
    protocolUniverseCompactSha256: compactArrayPropertyHash(marketText, 'protocolUniverse'),
    auditAsOf: '2026-10-04T00:26:00Z',
  };
}

describe('independent DeFi coverage audit', () => {
  it('keeps the immutable v4 audit profiles, complete 74bb052 baseline, and phase2/phase3 additions separate', () => {
    const legacyProfiles = loadInputs().currentV4Profiles!;
    const appendedProfiles = PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(12, 33);
    const phase2Profiles = PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(33, 62);
    const phase3Profiles = PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(62, 67);
    const ensoRootProfile = PRODUCTION_DEFI_CAPABILITY_BUNDLES[67];
    expect(legacyProfiles).toHaveLength(12);
    expect(legacyProfiles.reduce((sum, profile) => sum + profile.capabilityIds.length, 0)).toBe(94);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES).toHaveLength(68);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(0, 12)).toEqual(legacyProfiles);
    const phase3BaselineBytes = readFileSync('src/modules/defi/bundles/__fixtures__/phase3-baseline-profiles-74bb052.json');
    expect(sha256(phase3BaselineBytes)).toBe('3a73ad25307a3bd7ac4f77517b5cd9b09da4d83373fed1ea1f98176b9f7ff2a6');
    const phase3Baseline = JSON.parse(phase3BaselineBytes.toString('utf8')) as { provenance: { gitCommit: string }; profiles: StaticProfile[] };
    expect(phase3Baseline.provenance.gitCommit).toBe('74bb052ec003656e5810d5af42d50a300e94aad3');
    expect(phase3Baseline.profiles).toHaveLength(62);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(0, 62)).toEqual(phase3Baseline.profiles);
    const phase2BaselineBytes = readFileSync('src/modules/defi/bundles/__fixtures__/phase2-baseline-profiles-587f888.json');
    expect(sha256(phase2BaselineBytes)).toBe('9e6f596c0630b5a0dba45e03541612bc4b3e6915dad8d89db470926f1b512783');
    const phase2Baseline = JSON.parse(phase2BaselineBytes.toString('utf8')) as { provenance: { gitCommit: string }, profiles: StaticProfile[] };
    expect(phase2Baseline.provenance.gitCommit).toBe('587f888');
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(0, 33)).toEqual(phase2Baseline.profiles);
    expect(appendedProfiles).toHaveLength(21);
    const addedIds = appendedProfiles.flatMap((profile) => profile.capabilityIds);
    expect(addedIds).toHaveLength(138);
    expect(new Set(addedIds).size).toBe(138);
    expect(Math.max(...appendedProfiles.map((profile) => profile.capabilityIds.length))).toBe(17);
    expect(phase2Profiles).toHaveLength(29);
    const phase2Ids = phase2Profiles.flatMap((profile) => profile.capabilityIds);
    expect(phase2Ids).toHaveLength(134);
    expect(new Set(phase2Ids).size).toBe(134);
    expect(Math.max(...phase2Profiles.map((profile) => profile.capabilityIds.length))).toBe(10);
    const allProfileIds = PRODUCTION_DEFI_CAPABILITY_BUNDLES.flatMap((profile) => profile.capabilityIds);
    expect(phase3Profiles).toHaveLength(5);
    expect(phase3Profiles.reduce((sum, profile) => sum + profile.capabilityIds.length, 0)).toBe(28);
    expect(Math.max(...phase3Profiles.map((profile) => profile.capabilityIds.length))).toBe(12);
    expect(phase3Profiles.flatMap((profile) => profile.capabilityIds).every((id) => !id.includes(':approve'))).toBe(true);
    expect(ensoRootProfile).toMatchObject({ bundleId: 'enso-static-weiroll-root-v1', version: '1.0.0', chainIds: [1], capabilityIds: ['enso:router-static-weiroll-v1:1:0xf75584ef6673ad213a685a1b58cc0330b8ea22cf:route-single'] });
    expect(ensoRootProfile.capabilityIds).toHaveLength(1);
    expect(allProfileIds).toHaveLength(395);
    expect(new Set(allProfileIds).size).toBe(395);
    const baselineProfileBytes = readFileSync('src/modules/defi/bundles/__fixtures__/enso-baseline-profiles-445d448.json');
    expect(sha256(baselineProfileBytes)).toBe('1467dc962a15dd4cc795267e2b677857babc45398a654d5b2ba37c1d7208dd94');
    const baselineProfiles = JSON.parse(baselineProfileBytes.toString('utf8')) as { provenance: { gitCommit: string }; profiles: StaticProfile[] };
    expect(baselineProfiles.provenance.gitCommit).toBe('445d448cca6fb4e8b2c2cf9d649c2a68f4122242');
    expect(baselineProfiles.profiles).toHaveLength(67);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES.slice(0, 67)).toEqual(baselineProfiles.profiles);
  });

  it('recomputes catalog, admission, scopes, activity and exact-profile facts without trusting a coverage report', () => {
    const result = independentAudit(loadInputs());
    const report = result.report;
    expect(report.functionCatalog).toMatchObject({ m1FunctionCount: 202, m2FunctionCount: 315, v3FunctionCount: 349, m1BaselineCompletelyRetained: true, m2AuthorityCompletelyRetained: true, v3AdditionCount: 34, finiteScopeBindingsValid: true });
    expect(report.auditedCatalogBaseline).toMatchObject({ catalogVersion: 'v4', functionCount: 368, finiteExecutionScopeCount: 14, exactProfileCount: 12, frozenBaselineOnly: false, currentVersionInputIncluded: true, finalM4GatePassed: false });
    expect((report.functionCatalog as JsonObject).admission).toMatchObject({ snapshotsSourceHashValid: true, admissionBindingCount: 69, everyAdmissionBindingMatchesCatalogAbiAndScope: true, unadmittedAdditions: 0 });
    expect(report.frozenV3Baseline).toMatchObject({ functionCount: 349, scopeCount: 13, profileCount: 9, profileReferenceCount: 75, profileFixtureValid: true });
    expect(report.currentCatalogVerification).toMatchObject({
      catalogVersion: 'v4', functionCount: 368, v3FunctionCountPreserved: 349, v3FunctionsCompletelyUnchanged: true,
      activeFunctionCount: 368, addedFunctionCount: 19, sourceFunctionRows: 19, sourceRowsHaveUniqueFamilyChainTargetSignature: true,
      allSourceAbisMatchExactlyOneActiveCatalogFunction: true, everyNewCatalogFunctionBoundExactlyOnce: true,
      sourceSnapshots: [
        { sourcePath: 'data/defi-catalog/v4/sources/ordinary-protocols.json', sourceRecordCount: 6, unresolvedRecords: 0, exactCaptureTimeAvailable: false },
        { sourcePath: 'data/defi-catalog/v4/sources/yearn.json', sourceRecordCount: 3, unresolvedRecords: 0, exactCaptureTimeAvailable: false },
      ],
      admissions: { snapshots: 2, digestBoundToExactSources: true, bindings: 19, everyBindingMatchesFamilyChainTargetSignatureAbiCapabilityAndConditionalScope: true },
      executionScopes: { total: 14, sameTargetMulticall: 8, emptyCallbackData: 6, exactlyOneNewCakeScopeAndAllEightChildrenBound: true },
      v3ProfileFixture: { exactV3Profiles: true },
      profileAuthority: { currentProfileCount: 12, currentProfileReferences: 94, currentUniqueProfileMemberIds: 94, maximumCurrentProfileSize: 9, exactBaselineNineFullMetadataAndMembershipUnchanged: true, allTwelveCurrentProfilesFingerprintAndCatalogBound: true, newProfileSetsExactlyCoverTheirFamilyFunctions: true },
      marketIdentityOrActivityPromoted: false, currentProfileRowsAreNotGrantAssignments: true, noRuntimeOrFinancialArgumentSafetyClaim: true,
      inputSourcesHashRecorded: true, rawContentsMatchRecordedDigests: true, verifierValid: true,
    });
    expect(report.identityAndActivity).toMatchObject({ rawUniverseRows: 8476, rawUniverseDigestValid: true, identityLedgerMatchesRosterOrder: true, canonicalMappings: 4, partialMappings: 1, unresolvedIdentityLedgerRows: 8471, unresolvedProxyRowsIncludingPartial: 8472, unmatchedMetricRecords: 7, canonicalActiveProductCount: 3, http200ActivitySources: 14, compoundV2FeesQualify: false });
    expect(report.identityAndActivity).toMatchObject({ positiveDexObservationCount: 603, positiveDexSourceIdCount: 349, positiveDexObservationEvidenceComplete: true, unmatchedPositiveDexObservationCount: 0 });
    expect(report.workflows).toMatchObject({ m2WorkflowDefinitions: 144, m2RequiredCapabilityReferences: 59, m2DefinitionsPreservedExactlyInV3: true, targetScopedWorkflowBundles: 9, targetBundleCapabilityReferences: 69, exactTargetBindingsIndependentlyRevalidated: 69, wholeProductWorkflowCompletionEstablished: false });
    expect((report.workflows as JsonObject).observationSetAccounting).toMatchObject({
      coverageUnitProductCount: 4,
      activeObservationRowCount: 18,
      unresolvedObservationRowCount: 4,
      ignoredLineageOnlyObservationRowCount: 2,
      activeProductCount: 3,
      activeProductIds: ['raw-provider:119', 'raw-provider:2198', 'raw-provider:2611'],
      unresolvedProductCount: 3,
      unresolvedProductIds: ['raw-provider:114', 'raw-provider:119', 'raw-provider:2611'],
      activeUnresolvedIntersectionCount: 2,
      activeUnresolvedIntersectionProductIds: ['raw-provider:119', 'raw-provider:2611'],
      activeUnresolvedUnionCount: 4,
      activeUnresolvedUnionProductIds: ['raw-provider:114', 'raw-provider:119', 'raw-provider:2198', 'raw-provider:2611'],
      activeOnlyCount: 1,
      unresolvedOnlyCount: 1,
      unmatchedMetricRecordsAreRosterRows: false,
      activeUnresolvedRosterAccounting: {
        rosterSourceRowCount: 8476,
        unresolvedProxyRosterRows: 8472,
        activeSourceIdCount: 349,
        activeEvidenceObservationCount: 603,
        unresolvedSourceIdCount: 8475,
        unresolvedObservationSourceIds: ['114', '119', '2611'],
        unresolvedObservationChainsBySourceId: { '114': [1], '119': [143], '2611': [56, 143] },
        activeUnresolvedIntersectionCount: 348,
        activeUnresolvedUnionCount: 8476,
        activeOnlyCount: 1,
        activeOnlySourceIds: ['2198'],
        unresolvedOnlyCount: 8127,
        unresolvedOnlyProxyRosterRowCount: 8126,
        unresolvedOnlyObservedSourceIds: ['114'],
        inclusionExclusionUnionCount: 8476,
        unionEqualsFrozenRoster: true,
        proxyRowsConservedAgainstM2: true,
        unmatchedMetricRecordsCount: 7,
        unmatchedMetricRecordsAreExtraRosterRows: false,
      },
    });
    const accounting = ((report.workflows as JsonObject).observationSetAccounting as JsonObject).activeUnresolvedRosterAccounting as JsonObject;
    expect(accounting.activeSourceIds).toEqual(expect.arrayContaining(['119', '2198', '2611']));
    expect(accounting.activeUnresolvedIntersectionSourceIds).toEqual(expect.arrayContaining(['119', '2611']));
    expect(accounting.activeUnresolvedIntersectionSourceIds).toHaveLength(348);
    expect(accounting.activePositiveDexObservationChainsBySourceId).toHaveProperty('119');
    expect(report.profiles).toMatchObject({ profileCount: 9, profileReferenceCount: 75, uniqueProfileMemberIds: 75, maximumProfileSize: 9, allNineLiteralProfilesValid: true });
    expect(report.captureTimeInterpretation).toMatchObject({ frozenM1RosterCaptureUtc: null, currentM2ActivityCaptureUtc: '2026-10-03T19:11:22Z', currentActivityCaptureKnownAndFresh: true });
    expect(report.goal).toMatchObject({ marketDenominator: null, observedActiveProducts: 3, fullySupportedProducts: 0, objectiveEstablished: false });
    expect(report.legacyM3ReportComparison).toMatchObject({ comparisonCatalogVersion: 'v3', m3ReportedActiveProducts: 3, m3ReportedUnresolvedProducts: 8475, m3ReportedConservativeDenominator: 8476, reportUnresolvedCountIsObservationSetCount: false, reportCountsAssumedDisjoint: false, reportCountFormulaReconstructed: false, reportActiveCountMatchesObservationSetCardinality: true, reportUnresolvedCountMatchesIndependentRosterSetCardinality: true, reportConservativeDenominatorMatchesIndependentSetUnion: true, independentlyDerivedInclusionExclusionUnion: 8476, independentUnionEqualsRawRosterRows: true, reportIsNotAuthorityForThisAudit: true });
    expect(report.objectiveEstablished).toBe(false);
    expect(result.evidence.factsValid).toBe(true);
  });

  it('does not treat missing source identities, a substituted report denominator, or a name alias as coverage closure', () => {
    const source = loadInputs();
    const baseline = independentAudit(source).report;
    const renamed = structuredClone(source);
    objectArray(renamed.m2Identity.mappings)[0]!.productLabel = 'Uniswap alias';
    objectArray(renamed.m2Activity.sourceIdMetricRows)[0]!.name = 'Uniswap alias';
    jsonObject(renamed.m3ComparisonReport.products).conservativeDenominator = 1;
    jsonObject(renamed.m3ComparisonReport.products).unresolvedProducts = 0;
    const result = independentAudit(renamed).report;
    expect(result.identityAndActivity).toMatchObject({ canonicalActiveProductCount: 3, canonicalActiveSourceIds: ['119', '2198', '2611'] });
    expect(result.goal).toMatchObject({ marketDenominator: null, objectiveEstablished: false });
    expect(result.independentSourceAndAuthorityChecksValid).toBe(true);
    expect(result.legacyM3ReportComparison).toMatchObject({ legacyComparisonMatchesIndependentSetCardinalities: false, reportIsNotAuthorityForThisAudit: true });
    expect(baseline.goal).toEqual(result.goal);
    const droppedLedger = structuredClone(source);
    jsonArray(droppedLedger.m2Identity.ledger).pop();
    expect(independentAudit(droppedLedger).report.identityAndActivity).toMatchObject({ rawUniverseRows: 8476, identityLedgerRows: 8475, identityLedgerMatchesRosterOrder: false });
  });

  it('fails closed on source digest, active-candidate, ABI admission, finite-scope and frozen-workflow tampering', () => {
    const source = loadInputs();
    const badDigest = { ...source, rawSha256: { ...source.rawSha256, 'data/defi-catalog/v3/catalog.json': '0'.repeat(64) } };
    expect(independentAudit(badDigest).report.inputSourceDigestsVerified).toBe(false);

    const candidate = structuredClone(source);
    const addedFunction = catalogFunctions(candidate.m3Catalog).find((fn) => String(fn.capabilityId).endsWith(':refund-eth'))!;
    (addedFunction.provenance as JsonObject).status = 'candidate';
    expect(() => independentAudit(candidate)).toThrow(/Active catalog function lacks verified provenance/);

    const brokenScope = structuredClone(source);
    const wrapper = catalogFunctions(brokenScope.m3Catalog).find((fn) => jsonObject(fn.executionScope).kind === 'same-target-multicall-v1')!;
    jsonArray(jsonObject(wrapper.executionScope).allowedChildren).pop();
    expect(independentAudit(brokenScope).report.functionCatalog).toMatchObject({ finiteScopeBindingsValid: false });

    const changedAdmission = structuredClone(source);
    objectArray(jsonObject(jsonArray(changedAdmission.admissions.snapshots)[0]).bindings)[0]!.abiHash = `0x${'0'.repeat(64)}`;
    expect(independentAudit(changedAdmission).report.functionCatalog).toMatchObject({ admission: { everyAdmissionBindingMatchesCatalogAbiAndScope: false } });

    const changedScopeAdmission = structuredClone(source);
    const scopeBinding = objectArray(jsonObject(jsonArray(changedScopeAdmission.admissions.snapshots)[0]).bindings).find((binding) => binding.signature === 'multicall(bytes[])')!;
    scopeBinding.executionScopeHash = `0x${'0'.repeat(64)}`;
    expect(independentAudit(changedScopeAdmission).report.functionCatalog).toMatchObject({ admission: { sourceAdmissionCatalogBijectionValid: false, everyAdmissionBindingMatchesCatalogAbiAndScope: false } });

    const missingRequirement = structuredClone(source);
    const resolved = objectArray(missingRequirement.m2Normalized.workflowDefinitions).find((workflow) => workflow.requirementStatus === 'resolved')!;
    resolved.requiredCapabilities = [];
    expect(independentAudit(missingRequirement).report.workflows).toMatchObject({ resolvedWorkflowRequirementsNonemptyAndExact: false });
  });

  it('rejects duplicate, missing, and extra V3 admission bindings even when the source digest itself is valid', () => {
    const source = loadInputs();
    const duplicate = structuredClone(source);
    const duplicateSnapshot = objectArray(jsonArray(duplicate.admissions.snapshots))[0]!;
    const duplicateBindings = jsonArray(duplicateSnapshot.bindings);
    duplicateBindings[1] = structuredClone(duplicateBindings[0]!);
    const duplicateReport = independentAudit(duplicate).report;
    expect(duplicateReport.functionCatalog).toMatchObject({ admission: { uniqueAdmissionBindingIdentities: false, sourceAdmissionCatalogBijectionValid: false, everyAdmissionBindingMatchesCatalogAbiAndScope: false } });
    expect(duplicateReport.independentSourceAndAuthorityChecksValid).toBe(false);

    const missing = structuredClone(source);
    const missingSnapshot = objectArray(jsonArray(missing.admissions.snapshots))[0]!;
    (missingSnapshot.bindings as JsonValue[]).pop();
    expect(independentAudit(missing).report.functionCatalog).toMatchObject({ admission: { sourceAdmissionCatalogBijectionValid: false, everyAdmissionBindingMatchesCatalogAbiAndScope: false } });

    const extra = structuredClone(source);
    const extraSnapshot = objectArray(jsonArray(extra.admissions.snapshots))[0]!;
    (extraSnapshot.bindings as JsonValue[]).push(structuredClone(jsonArray(extraSnapshot.bindings)[0]!));
    const extraAdmission = jsonObject((independentAudit(extra).report.functionCatalog as JsonObject).admission);
    expect(extraAdmission.sourceAdmissionCatalogBijectionValid).toBe(false);
    expect(extraAdmission.unadmittedAdditions).toBe(1);
  });

  it('rejects a unique hash-consistent V3 source/admission substitution that leaves a catalog addition unadmitted', () => {
    const source = loadInputs();
    const altered = structuredClone(source);
    const extensionPath = paths.workflowExtensions;
    const extension = altered.workflowExtensions;
    const morphoFamily = objectArray(jsonArray(extension.families)).find((family) => family.familyId === 'morpho-blue')!;
    const ethMorpho = objectArray(morphoFamily.contracts).find((contract) => contract.chainId === 1 && String(contract.address).toLowerCase() === '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb')!;
    const repayIndex = jsonArray(ethMorpho.abiFunctions).findIndex((abi) => jsonObject(abi).name === 'repay');
    expect(repayIndex).toBeGreaterThanOrEqual(0);
    const baselineBorrow = catalogFunctions(altered.m2Catalog).find((fn) => fn.capabilityId === 'morpho-blue:v1:1:0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb:borrow')!;
    (ethMorpho.abiFunctions as JsonValue[])[repayIndex] = structuredClone(baselineBorrow.abi);

    const snapshot = objectArray(jsonArray(altered.admissions.snapshots))[0]!;
    const repayAdmission = objectArray(snapshot.bindings).find((binding) => String(binding.capabilityId).includes(':repay') && Number(binding.chainId) === 1 && String(binding.contract).toLowerCase() === '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb')!;
    repayAdmission.capabilityId = baselineBorrow.capabilityId;
    repayAdmission.signature = baselineBorrow.signature;
    repayAdmission.abiHash = keccak256(stringToHex(stableJson([baselineBorrow.abi])));
    delete repayAdmission.executionScope;
    delete repayAdmission.executionScopeHash;
    snapshot.canonicalSha256 = sha256(stableJson(extension));

    const sourceBytes = `${JSON.stringify(extension, null, 2)}\n`;
    const admissionBytes = `${JSON.stringify(altered.admissions, null, 2)}\n`;
    const sourceDigest = sha256(sourceBytes);
    const rawSha256 = {
      ...altered.rawSha256,
      [extensionPath]: sourceDigest,
      [paths.admissions]: sha256(admissionBytes),
    };
    const rawSourceContents = { ...altered.rawSourceContents, [extensionPath]: sourceBytes };
    const oldSourceRef = `${extensionPath}#sha256=${source.rawSha256[extensionPath]}`;
    const newSourceRef = `${extensionPath}#sha256=${sourceDigest}`;
    const m3WorkflowInventory = { ...altered.m3WorkflowInventory, sourceRefs: jsonArray(altered.m3WorkflowInventory.sourceRefs).map((ref) => String(ref) === oldSourceRef ? newSourceRef : ref) };

    const result = independentAudit({ ...altered, rawSha256, rawSourceContents, m3WorkflowInventory });
    const catalogs = jsonObject(result.report.functionCatalog);
    const closure = jsonObject(catalogs.admission);
    expect(closure).toMatchObject({ snapshotsSourceHashValid: true, bindingBijectionValid: true, uniqueAdmissionBindingIdentities: true, admissionBindingCount: 69, unadmittedAdditions: 1, admissionClosureValid: false });
    expect(catalogs.exactV3AdditionsSourceBound).toBe(false);
    expect(result.report.inputSourceDigestsVerified).toBe(true);
    expect(result.report.independentSourceAndAuthorityChecksValid).toBe(false);
    expect(result.report.currentCatalogVerification).toMatchObject({ historicalV3ClosureValid: false, verifierValid: false });
  });

  it('keeps unsupported raw proxies, unqualified fee evidence, missing chains, and incomplete instances as blockers', () => {
    const source = loadInputs();
    const report = independentAudit(source).report;
    expect(report.identityAndActivity).toMatchObject({ unresolvedProxyRowsIncludingPartial: 8472, unmatchedMetricRecords: 7, compoundV2FeesQualify: false });
    expect(report.identityAndActivity).toHaveProperty('responseCanonicalHashMismatches');
    expect(report.workflows).toMatchObject({ missingExpectedProductChainObservations: expect.any(Number), completeInstanceAndWorkflowObservationRows: 0, wholeProductWorkflowCompletionEstablished: false });
    expect((report.goal as JsonObject).blockers).toEqual(expect.arrayContaining(['unresolved_identity_proxy_universe', 'unmatched_identity_records', 'chain_enumeration_incomplete', 'product_instance_enumeration_incomplete']));

    const qualifiedFee = structuredClone(source);
    const fee = objectArray(qualifiedFee.m2ActivityMethods.methods).find((method) => (method.sourceIds as string[]).includes('114'))!;
    fee.qualifiesAsUserActivity = true;
    expect(independentAudit(qualifiedFee).report.identityAndActivity).toMatchObject({ compoundV2FeesQualify: true });

    const droppedProxy = structuredClone(source);
    jsonArray(droppedProxy.m2Normalized.unresolvedUniverseRecords).pop();
    expect(independentAudit(droppedProxy).report.identityAndActivity).toMatchObject({ unresolvedProxyRecordsConservedAgainstLedger: false });
    const droppedM3Proxy = structuredClone(source);
    jsonArray(droppedM3Proxy.m3Normalized.unresolvedUniverseRecords).pop();
    expect(independentAudit(droppedM3Proxy).report.independentSourceAndAuthorityChecksValid).toBe(false);
    const omittedChain = structuredClone(source);
    jsonArray(omittedChain.m3Normalized.observations).pop();
    expect(independentAudit(omittedChain).report.workflows).toMatchObject({ missingExpectedProductChainObservations: expect.any(Number), wholeProductWorkflowCompletionEstablished: false });
  });

  it('rejects altered static profile membership and distinguishes stale output from a failed goal assertion', () => {
    const source = loadInputs();
    const baselineProfiles = structuredClone(source.v3ProfileFixture!);
    const firstBaselineProfile = objectArray(baselineProfiles.profiles)[0]!;
    firstBaselineProfile.capabilityIds = [...(firstBaselineProfile.capabilityIds as string[]), '*'];
    const baselineTampered = independentAudit({ ...source, v3ProfileFixture: baselineProfiles }).report;
    expect(baselineTampered.independentSourceAndAuthorityChecksValid).toBe(false);
    expect(baselineTampered.frozenV3Baseline).toMatchObject({ profileFixtureValid: false });

    const currentProfiles = [...source.currentV4Profiles!];
    currentProfiles[9] = { ...currentProfiles[9]!, capabilityIds: [...currentProfiles[9]!.capabilityIds, '*'] };
    expect(independentAudit({ ...source, currentV4Profiles: currentProfiles }).report.currentCatalogVerification).toMatchObject({ profileAuthority: { allTwelveCurrentProfilesFingerprintAndCatalogBound: false } });

    const historical = independentAudit({ ...source, catalogVersion: 'v3', currentV4Catalog: undefined, currentV4Admissions: undefined, currentV4OrdinarySource: undefined, currentV4YearnSource: undefined, currentV4Profiles: undefined }).report;
    expect(historical).toMatchObject({ auditedCatalogVersion: 'v3', auditedCatalogBaseline: { catalogVersion: 'v3', functionCount: 349, frozenBaselineOnly: true, currentVersionInputIncluded: false, finalM4GatePassed: false }, currentCatalogVerification: null });

    const check = spawnSync(process.execPath, ['-r', 'ts-node/register', 'scripts/defi-coverage/audit-cli.ts', '--check', '--assert-goal'], { encoding: 'utf8' });
    if (check.status === 1) {
      expect(check.stderr).toMatch(/Stale independent-audit artifact: data\/defi-coverage\/v4\//);
    } else {
      expect(check.status).toBe(2);
      expect(JSON.parse(check.stdout)).toMatchObject({ mode: 'check', objectiveEstablished: false, marketDenominator: null });
    }
  });

  it('independently binds all V4 source, admission, profile and ABI facts to the current catalog without promoting market identity', () => {
    const source = loadInputs();
    const wrongRawDigest = { ...source, rawSha256: { ...source.rawSha256, [paths.currentV4YearnSource]: '0'.repeat(64) } };
    expect(independentAudit(wrongRawDigest).report.currentCatalogVerification).toMatchObject({ rawContentsMatchRecordedDigests: false, verifierValid: false });

    const badAdmission = structuredClone(source);
    jsonObject(jsonArray(badAdmission.currentV4Admissions!.snapshots)[1]).canonicalSha256 = '0'.repeat(64);
    expect(independentAudit(badAdmission).report.currentCatalogVerification).toMatchObject({ admissions: { digestBoundToExactSources: false }, verifierValid: false });

    const candidate = structuredClone(source);
    const added = catalogFunctions(candidate.currentV4Catalog!).find((fn) => String(fn.capabilityId).startsWith('curve-3pool-stableswap:'))!;
    added.status = 'inactive_candidate';
    expect(independentAudit(candidate).report.currentCatalogVerification).toMatchObject({ allSourceAbisMatchExactlyOneActiveCatalogFunction: false, verifierValid: false });

    const scopeHashTamper = structuredClone(source);
    const pancakeAdmission = objectArray(scopeHashTamper.currentV4Admissions!.snapshots).find((item) => item.sourcePath === 'data/defi-catalog/v4/sources/ordinary-protocols.json')!;
    const pancakeWrapper = objectArray(pancakeAdmission.bindings).find((item) => String(item.signature) === 'multicall(bytes[])')!;
    pancakeWrapper.executionScopeHash = `0x${'0'.repeat(64)}`;
    expect(independentAudit(scopeHashTamper).report.currentCatalogVerification).toMatchObject({ admissions: { everyBindingMatchesFamilyChainTargetSignatureAbiCapabilityAndConditionalScope: false }, verifierValid: false });

    const unsupportedScope = structuredClone(source);
    const wrapper = catalogFunctions(unsupportedScope.currentV4Catalog!).find((fn) => String(fn.capabilityId).startsWith('pancakeswap-v3-position-manager:') && jsonObject(fn.executionScope).kind === 'same-target-multicall-v1')!;
    jsonArray(jsonObject(wrapper.executionScope).allowedChildren).push({ capabilityId: 'wildcard:*', signature: '*', abiHash: `0x${'0'.repeat(64)}` });
    expect(independentAudit(unsupportedScope).report.currentCatalogVerification).toMatchObject({ executionScopes: { exactlyOneNewCakeScopeAndAllEightChildrenBound: false }, verifierValid: false });

    const sourceAddressMutation = structuredClone(source);
    objectArray(jsonObject(jsonArray(sourceAddressMutation.currentV4OrdinarySource!.families)[0]).contracts)[0]!.address = '0x0000000000000000000000000000000000000001';
    expect(() => independentAudit(sourceAddressMutation)).toThrow(/Unexpected V4 source deployment/);

    const duplicateV4Admission = structuredClone(source);
    const admissionDoc = duplicateV4Admission.currentV4Admissions!;
    const yearnSnapshot = objectArray(jsonArray(admissionDoc.snapshots)).find((item) => item.sourcePath === 'data/defi-catalog/v4/sources/yearn.json')!;
    const yearnBindings = jsonArray(yearnSnapshot.bindings);
    yearnBindings[1] = structuredClone(yearnBindings[0]!);
    const rawAdmission = JSON.stringify(admissionDoc, null, 2) + '\n';
    const duplicateV4Inputs = { ...duplicateV4Admission, rawSourceContents: { ...duplicateV4Admission.rawSourceContents, 'data/defi-catalog/v4/admissions.json': rawAdmission }, rawSha256: { ...duplicateV4Admission.rawSha256, 'data/defi-catalog/v4/admissions.json': sha256(rawAdmission) } };
    expect(independentAudit(duplicateV4Inputs).report.currentCatalogVerification).toMatchObject({ admissions: { uniqueBindingIdentities: false, sourceAdmissionCatalogBijectionValid: false }, verifierValid: false });

    const missingV4Admission = structuredClone(source);
    const missingSnapshot = objectArray(jsonArray(missingV4Admission.currentV4Admissions!.snapshots)).find((item) => item.sourcePath === 'data/defi-catalog/v4/sources/yearn.json')!;
    (missingSnapshot.bindings as JsonValue[]).pop();
    const missingAdmissionRaw = JSON.stringify(missingV4Admission.currentV4Admissions, null, 2) + '\n';
    const missingV4Inputs = { ...missingV4Admission, rawSourceContents: { ...missingV4Admission.rawSourceContents, 'data/defi-catalog/v4/admissions.json': missingAdmissionRaw }, rawSha256: { ...missingV4Admission.rawSha256, 'data/defi-catalog/v4/admissions.json': sha256(missingAdmissionRaw) } };
    expect(independentAudit(missingV4Inputs).report.currentCatalogVerification).toMatchObject({ admissions: { sourceAdmissionCatalogBijectionValid: false }, verifierValid: false });

    const extraV4 = structuredClone(source);
    const extraYearn = objectArray(jsonArray(extraV4.currentV4Admissions!.snapshots)).find((item) => item.sourcePath === 'data/defi-catalog/v4/sources/yearn.json')!;
    const alienBinding = structuredClone(jsonArray(extraYearn.bindings)[0]!) as JsonObject;
    alienBinding.signature = 'unauthorized()';
    (extraYearn.bindings as JsonValue[]).push(alienBinding);
    expect(independentAudit(extraV4).report.currentCatalogVerification).toMatchObject({ admissions: { bindings: 20, sourceAdmissionCatalogBijectionValid: false }, verifierValid: false });
  });

  it('requires expected chains, enumerated instances and exact nonempty resolved workflow claims for product completion', () => {
    const source = loadInputs();
    const mutateEth2198 = (input: AuditInputs, mutate: (observation: JsonObject) => void) => {
      const observation = objectArray(input.m3Normalized.observations).find((row) => row.productId === 'raw-provider:2198' && row.chainId === 1)!;
      mutate(observation);
    };
    const emptyClaims = structuredClone(source);
    mutateEth2198(emptyClaims, (observation) => {
      observation.instanceEnumeration = 'complete';
      observation.workflowSet = { ...jsonObject(observation.workflowSet), status: 'complete' };
      observation.instances = [{ instanceId: 'vacuum', workflowClaims: [] }];
    });
    expect((independentAudit(emptyClaims).report.workflows as JsonObject)).toMatchObject({ completeDistinctCanonicalActiveProductCount: 0 });

    const missingWorkflow = structuredClone(source);
    mutateEth2198(missingWorkflow, (observation) => {
      observation.instanceEnumeration = 'complete';
      observation.workflowSet = { ...jsonObject(observation.workflowSet), status: 'complete' };
      jsonArray(observation.workflowSet && jsonObject(observation.workflowSet).workflowIds).pop();
    });
    expect((independentAudit(missingWorkflow).report.workflows as JsonObject).completeDistinctCanonicalActiveProductCount).toBe(0);

    const duplicateProductChain = structuredClone(source);
    const ethObservation = objectArray(duplicateProductChain.m3Normalized.observations).find((row) => row.productId === 'raw-provider:2198' && row.chainId === 1)!;
    duplicateProductChain.m3Normalized.observations = [...jsonArray(duplicateProductChain.m3Normalized.observations), structuredClone(ethObservation)];
    expect((independentAudit(duplicateProductChain).report.workflows as JsonObject).completeDistinctCanonicalActiveProductCount).toBe(0);

    const falseCompletionLabel = structuredClone(source);
    const sushi = objectArray(falseCompletionLabel.m3Normalized.products).find((row) => row.productId === 'raw-provider:119')!;
    sushi.chainInventoryCompleteness = 'complete';
    expect((independentAudit(falseCompletionLabel).report.workflows as JsonObject).completeDistinctCanonicalActiveProductCount).toBe(0);
  });

  it('can affirm a complete synthetic 90% fixture, while rejecting an incomplete or attacker-shrunk roster', () => {
    const positive = evaluateGoalClosure({ rawUniverseCount: 100, unresolvedIdentityProxyCount: 0, unmatchedIdentityCount: 0, canonicalProductCount: 100, activeProductCount: 10, fullySupportedProductCount: 9, chainsEnumerated: true, activityComplete: true, workflowsComplete: true, instancesComplete: true, rawCanonicalDeduplicationDocumented: true });
    expect(positive).toMatchObject({ marketDenominator: 10, observedActiveProducts: 10, fullySupportedProducts: 9, objectiveEstablished: true, blockers: [] });
    const documentedDedup = evaluateGoalClosure({ rawUniverseCount: 100, unresolvedIdentityProxyCount: 0, unmatchedIdentityCount: 0, canonicalProductCount: 90, activeProductCount: 10, fullySupportedProductCount: 9, chainsEnumerated: true, activityComplete: true, workflowsComplete: true, instancesComplete: true, rawCanonicalDeduplicationDocumented: true });
    expect(documentedDedup).toMatchObject({ marketDenominator: 10, objectiveEstablished: true, blockers: [] });
    expect(evaluateGoalClosure({ rawUniverseCount: 100, unresolvedIdentityProxyCount: 0, unmatchedIdentityCount: 0, canonicalProductCount: 100, activeProductCount: 10, fullySupportedProductCount: 9, chainsEnumerated: true, activityComplete: true, workflowsComplete: true, instancesComplete: true })).toMatchObject({ marketDenominator: null, objectiveEstablished: false });
    expect(evaluateGoalClosure({ rawUniverseCount: 10, unresolvedIdentityProxyCount: 1, unmatchedIdentityCount: 0, canonicalProductCount: 10, activeProductCount: 9, fullySupportedProductCount: 9, chainsEnumerated: true, activityComplete: true, workflowsComplete: true, instancesComplete: true })).toMatchObject({ marketDenominator: null, objectiveEstablished: false });
    expect(evaluateGoalClosure({ rawUniverseCount: 100, unresolvedIdentityProxyCount: 0, unmatchedIdentityCount: 0, canonicalProductCount: 90, activeProductCount: 10, fullySupportedProductCount: 9, chainsEnumerated: true, activityComplete: true, workflowsComplete: true, instancesComplete: true })).toMatchObject({ marketDenominator: null, objectiveEstablished: false });
    expect(evaluateGoalClosure({ rawUniverseCount: 10, unresolvedIdentityProxyCount: 0, unmatchedIdentityCount: 0, canonicalProductCount: 10, activeProductCount: 0, fullySupportedProductCount: 0, chainsEnumerated: true, activityComplete: true, workflowsComplete: true, instancesComplete: true, rawCanonicalDeduplicationDocumented: true })).toMatchObject({ marketDenominator: null, objectiveEstablished: false, blockers: ['no_active_products_for_coverage_ratio', 'market_denominator_not_independently_closed'] });
    expect(evaluateGoalClosure({ rawUniverseCount: 10, unresolvedIdentityProxyCount: 0, unmatchedIdentityCount: 0, canonicalProductCount: 10, activeProductCount: 9, fullySupportedProductCount: 10, chainsEnumerated: true, activityComplete: true, workflowsComplete: true, instancesComplete: true, rawCanonicalDeduplicationDocumented: true })).toMatchObject({ marketDenominator: null, objectiveEstablished: false, blockers: ['invalid_independent_product_accounting', 'market_denominator_not_independently_closed'] });
    expect(evaluateGoalClosure({ rawUniverseCount: 100, unresolvedIdentityProxyCount: 0, unmatchedIdentityCount: 0, canonicalProductCount: 100, activeProductCount: 10, fullySupportedProductCount: 9, chainsEnumerated: true, activityComplete: false, workflowsComplete: true, instancesComplete: true, rawCanonicalDeduplicationDocumented: true })).toMatchObject({ marketDenominator: null, objectiveEstablished: false, blockers: ['activity_evidence_incomplete', 'market_denominator_not_independently_closed'] });
  });
});
