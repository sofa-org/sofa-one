import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PRODUCTION_DEFI_CAPABILITY_BUNDLES } from '../../src/modules/defi/bundles/production-bundles';
import { compactArrayPropertyHash, independentAudit, INDEPENDENT_AUDIT_DEFAULT_AS_OF, sha256 } from '../../src/modules/defi/coverage-tooling/independent-audit';
import type { AuditInputs, JsonObject, StaticProfile } from '../../src/modules/defi/coverage-tooling/independent-audit';

const ROOT = process.cwd();
const BASE_INPUTS = {
  market: 'data/defi-coverage/market-snapshot.json',
  classification: 'data/defi-coverage/discovery-classification.json',
  m1Catalog: 'data/defi-catalog/v1/catalog.json',
  m2Catalog: 'data/defi-catalog/v2/catalog.json',
  m2DexSource: 'data/defi-catalog/v2/sources/dex.json',
  m3Catalog: 'data/defi-catalog/v3/catalog.json',
  admissions: 'data/defi-catalog/v3/admissions.json',
  workflowExtensions: 'data/defi-catalog/v3/sources/workflow-extensions.json',
  m2Activity: 'data/defi-coverage/v2/activity-snapshot.json',
  m2ActivityMethods: 'data/defi-coverage/v2/activity-methods.json',
  m2Identity: 'data/defi-coverage/v2/identity-crosswalk.json',
  m2Evidence: 'data/defi-coverage/v2/normalization-evidence.json',
  m2CoverageReport: 'data/defi-coverage/v2/coverage-report.json',
  m2WorkflowInventory: 'data/defi-coverage/v2/workflow-inventory.json',
  m2Normalized: 'data/defi-coverage/v2/normalized-input.json',
  m3Normalized: 'data/defi-coverage/v3/normalized-input.json',
  m3WorkflowInventory: 'data/defi-coverage/v3/workflow-inventory.json',
  m3ComparisonReport: 'data/defi-coverage/v3/coverage-report.json',
  v3ProfileFixture: 'src/modules/defi/catalog-tooling/__fixtures__/v3-bundle-baseline.json',
} as const;
const V4_INPUTS = {
  currentV4Catalog: 'data/defi-catalog/v4/catalog.json',
  currentV4Admissions: 'data/defi-catalog/v4/admissions.json',
  currentV4OrdinarySource: 'data/defi-catalog/v4/sources/ordinary-protocols.json',
  currentV4YearnSource: 'data/defi-catalog/v4/sources/yearn.json',
  currentProfileSource: 'src/modules/defi/bundles/production-bundles.ts',
} as const;
const OUTPUTS = {
  report: 'data/defi-coverage/v4/independent-audit.json',
  evidence: 'data/defi-coverage/v4/audit-evidence.json',
} as const;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let check = false;
  let assertGoal = false;
  let catalogVersion: 'v3' | 'v4' = 'v4';
  let versionWasSet = false;
  let explicitAsOf: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--check') { if (check) throw new Error('Duplicate --check'); check = true; }
    else if (arg === '--assert-goal') { if (assertGoal) throw new Error('Duplicate --assert-goal'); assertGoal = true; }
    else if (arg === '--catalog-version') {
      if (versionWasSet) throw new Error('Duplicate --catalog-version');
      const version = args[++index];
      if (version !== 'v3' && version !== 'v4') throw new Error('--catalog-version must be exactly v3 or v4');
      catalogVersion = version;
      versionWasSet = true;
    }
    else if (arg === '--as-of') {
      if (explicitAsOf) throw new Error('Duplicate --as-of');
      explicitAsOf = args[++index];
      if (!explicitAsOf || explicitAsOf.startsWith('--')) throw new Error('Missing ISO timestamp for --as-of');
    } else throw new Error('Usage: audit-cli.ts [--catalog-version v3|v4] [--check] [--assert-goal] [--as-of ISO_UTC_TIMESTAMP]');
  }
  const selected = { ...BASE_INPUTS, ...(catalogVersion === 'v4' ? V4_INPUTS : {}) };
  const paths = Object.values(selected);
  const raw = await Promise.all(paths.map((path) => readFile(resolve(ROOT, path))));
  const jsonPaths = Object.entries(selected).filter(([key]) => key !== 'currentProfileSource').map(([, path]) => path);
  const parsed = Object.fromEntries(jsonPaths.map((path) => {
    const index = paths.indexOf(path);
    return [path, JSON.parse(raw[index]!.toString('utf8'))];
  })) as Record<string, JsonObject>;
  const byKey = Object.fromEntries(Object.entries(selected).filter(([key]) => key !== 'currentProfileSource').map(([key, path]) => [key, parsed[path]!])) as Record<string, JsonObject>;
  let auditAsOf = explicitAsOf ?? INDEPENDENT_AUDIT_DEFAULT_AS_OF;
  if (check && !explicitAsOf) {
    const current = JSON.parse(await readFile(resolve(ROOT, OUTPUTS.report), 'utf8')) as { auditAsOf?: unknown };
    if (typeof current.auditAsOf !== 'string') throw new Error('Existing audit report lacks auditAsOf; supply --as-of to check');
    auditAsOf = current.auditAsOf;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(auditAsOf) || !Number.isFinite(Date.parse(auditAsOf))) throw new Error('--as-of must be an explicit UTC ISO timestamp');
  const rawSha256 = Object.fromEntries(paths.map((path, index) => [path, sha256(raw[index]!)]));
  const marketText = raw[paths.indexOf(BASE_INPUTS.market)]!.toString('utf8');
  const fixtureBytes = raw[paths.indexOf(BASE_INPUTS.v3ProfileFixture)]!;
  const fixture = byKey.v3ProfileFixture!;
  const baselineProfiles = (Array.isArray(fixture.profiles) ? fixture.profiles : []) as unknown as StaticProfile[];
  const selectedRawSha256 = Object.fromEntries(paths.map((path, index) => [path, sha256(raw[index]!)]));
  const rawAuditInputPaths = [BASE_INPUTS.v3ProfileFixture, ...(catalogVersion === 'v4' ? [
    V4_INPUTS.currentV4Catalog, V4_INPUTS.currentV4Admissions,
    V4_INPUTS.currentV4OrdinarySource, V4_INPUTS.currentV4YearnSource, V4_INPUTS.currentProfileSource,
  ] : [])];
  const rawSourceContents = Object.fromEntries(rawAuditInputPaths.map((path) => [path, raw[paths.indexOf(path)]!.toString('utf8')]));
  const inputs: AuditInputs = {
    catalogVersion,
    market: byKey.market!, classification: byKey.classification!,
    m1Catalog: byKey.m1Catalog!, m2Catalog: byKey.m2Catalog!, m3Catalog: byKey.m3Catalog!,
    admissions: byKey.admissions!, workflowExtensions: byKey.workflowExtensions!,
    m2Activity: byKey.m2Activity!, m2ActivityMethods: byKey.m2ActivityMethods!,
    m2Identity: byKey.m2Identity!, m2Evidence: byKey.m2Evidence!,
    m2WorkflowInventory: byKey.m2WorkflowInventory!, m2Normalized: byKey.m2Normalized!,
    m3Normalized: byKey.m3Normalized!, m3WorkflowInventory: byKey.m3WorkflowInventory!,
    m3ComparisonReport: byKey.m3ComparisonReport!,
    profiles: baselineProfiles,
    v3ProfileFixture: fixture,
    v3ProfileFixtureSha256: sha256(fixtureBytes),
    rawSourceContents,
    ...(catalogVersion === 'v4' ? {
      currentV4Catalog: byKey.currentV4Catalog!, currentV4Admissions: byKey.currentV4Admissions!,
      currentV4OrdinarySource: byKey.currentV4OrdinarySource!, currentV4YearnSource: byKey.currentV4YearnSource!,
      currentV4Profiles: PRODUCTION_DEFI_CAPABILITY_BUNDLES as readonly StaticProfile[],
    } : {}),
    rawSha256: selectedRawSha256,
    protocolUniverseCompactSha256: compactArrayPropertyHash(marketText, 'protocolUniverse'), auditAsOf,
  };
  const { report, evidence } = independentAudit(inputs);
  const outputs: Record<string, string> = {
    [OUTPUTS.report]: `${JSON.stringify(report, null, 2)}\n`,
    [OUTPUTS.evidence]: `${JSON.stringify(evidence, null, 2)}\n`,
  };
  const activitySummary = report.identityAndActivity as unknown as { canonicalActiveProductCount: number; positiveDexSourceIdCount: number; positiveDexObservationCount: number; rawUniverseRows: number };
  const rosterSet = (((report.workflows as unknown as { observationSetAccounting: { activeUnresolvedRosterAccounting: { activeUnresolvedIntersectionCount: number; activeUnresolvedUnionCount: number } } }).observationSetAccounting).activeUnresolvedRosterAccounting);
  const v4Summary = report.currentCatalogVerification as unknown as { functionCount?: number; addedFunctionCount?: number; executionScopes?: { total?: number }; profileAuthority?: { currentProfileCount?: number } } | null;
  if (check) {
    for (const [path, expected] of Object.entries(outputs)) {
      const actual = await readFile(resolve(ROOT, path), 'utf8');
      if (actual !== expected) throw new Error(`Stale independent-audit artifact: ${path}`);
    }
  } else {
    for (const [path, content] of Object.entries(outputs)) await writeFile(resolve(ROOT, path), content, 'utf8');
  }
  process.stdout.write(`${JSON.stringify({ mode: check ? 'check' : 'write', auditedCatalogVersion: catalogVersion, outputPaths: Object.keys(outputs), auditAsOf, currentEvidenceStatus: report.currentEvidenceStatus, independentSourceAndAuthorityChecksValid: report.independentSourceAndAuthorityChecksValid, objectiveEstablished: report.objectiveEstablished, marketDenominator: report.goal && (report.goal as unknown as { marketDenominator: number | null }).marketDenominator, frozenV3Functions: (report.functionCatalog as unknown as { v3FunctionCount: number }).v3FunctionCount, currentV4Functions: v4Summary?.functionCount ?? null, currentV4Additions: v4Summary?.addedFunctionCount ?? null, currentV4Scopes: v4Summary?.executionScopes?.total ?? null, currentProfiles: v4Summary?.profileAuthority?.currentProfileCount ?? null, canonicalActiveProducts: activitySummary.canonicalActiveProductCount, positiveDexRawSourceIds: activitySummary.positiveDexSourceIdCount, positiveDexObservations: activitySummary.positiveDexObservationCount, activeUnresolvedIntersection: rosterSet.activeUnresolvedIntersectionCount, activeUnresolvedUnion: rosterSet.activeUnresolvedUnionCount, rawUniverseRows: activitySummary.rawUniverseRows, fingerprint: evidence.outputReportSha256 }, null, 2)}\n`);
  if (assertGoal && report.objectiveEstablished !== true) process.exitCode = 2;
}

main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
