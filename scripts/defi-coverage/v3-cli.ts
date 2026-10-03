import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { adaptV3Coverage } from '../../src/modules/defi/coverage-tooling/v3-adapter';
import { computeCoverage } from '../../src/modules/defi/coverage-tooling/calculator';
import { isCoverageReportCurrent, serializeCoverageReport } from '../../src/modules/defi/coverage-tooling/cli-helpers';

const ROOT = process.cwd();
const INPUTS = {
  m1Catalog: 'data/defi-catalog/v1/catalog.json',
  m2Catalog: 'data/defi-catalog/v2/catalog.json',
  m2DexSource: 'data/defi-catalog/v2/sources/dex.json',
  v3Catalog: 'data/defi-catalog/v3/catalog.json',
  workflowExtensions: 'data/defi-catalog/v3/sources/workflow-extensions.json',
  baseInput: 'data/defi-coverage/v2/normalized-input.json',
  m2CoverageReport: 'data/defi-coverage/v2/coverage-report.json',
  m2NormalizationEvidence: 'data/defi-coverage/v2/normalization-evidence.json',
  m2IdentityCrosswalk: 'data/defi-coverage/v2/identity-crosswalk.json',
  m2ActivityMethods: 'data/defi-coverage/v2/activity-methods.json',
  m2WorkflowInventory: 'data/defi-coverage/v2/workflow-inventory.json',
  m2ActivitySnapshot: 'data/defi-coverage/v2/activity-snapshot.json',
} as const;
const OUTPUTS = {
  workflowInventory: 'data/defi-coverage/v3/workflow-inventory.json',
  normalizedInput: 'data/defi-coverage/v3/normalized-input.json',
  coverageReport: 'data/defi-coverage/v3/coverage-report.json',
  normalizationEvidence: 'data/defi-coverage/v3/normalization-evidence.json',
} as const;

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check')) throw new Error('Usage: v3-cli.ts [--check]');
  const check = args.includes('--check');
  const paths = Object.values(INPUTS);
  const buffers = await Promise.all(paths.map((path) => readFile(resolve(ROOT, path))));
  const parsed = Object.fromEntries(paths.map((path, index) => [path, JSON.parse(buffers[index]!.toString('utf8'))])) as Record<string, any>;
  const sourceDigests = Object.fromEntries(paths.map((path, index) => [path, createHash('sha256').update(buffers[index]!).digest('hex')]));
  const projection = adaptV3Coverage({
    m1Catalog: parsed[INPUTS.m1Catalog], m2Catalog: parsed[INPUTS.m2Catalog], v3Catalog: parsed[INPUTS.v3Catalog],
    workflowExtensions: parsed[INPUTS.workflowExtensions], baseInput: parsed[INPUTS.baseInput], sourceDigests,
    frozenEvidence: {
      m2CoverageReport: parsed[INPUTS.m2CoverageReport],
      m2NormalizationEvidence: parsed[INPUTS.m2NormalizationEvidence],
      m2IdentityCrosswalk: parsed[INPUTS.m2IdentityCrosswalk],
      m2ActivityMethods: parsed[INPUTS.m2ActivityMethods],
      workflowInventory: parsed[INPUTS.m2WorkflowInventory],
      activitySnapshot: parsed[INPUTS.m2ActivitySnapshot],
    },
  });
  const calculated = computeCoverage(projection.input, projection.capabilities);
  if (calculated.objectiveEstablished) throw new Error('V3 scoped-workflow additions cannot establish the frozen market-coverage objective');
  const targetRows = calculated.workflowCoverage.rows.filter((row) => row.workflowId.startsWith('m3:v3:'));
  const targetScopeResults = { evaluatedRows: targetRows.length, completeExactTargetRows: targetRows.filter((row) => row.complete).length, incompleteUnenumeratedPopulationRows: targetRows.filter((row) => row.claimedStatus === 'missing' || !row.complete).length, productMarketCompletenessEstablished: false };
  const workflowInventory = { ...projection.workflowInventory, evaluatedTargetScopeResults: targetScopeResults };
  const report = { ...calculated, scopedWorkflowProgress: { ...workflowInventory.summary, ...targetScopeResults }, v3CatalogManifestHash: workflowInventory.v3CatalogManifestHash, workflowInventorySha256: createHash('sha256').update(JSON.stringify(workflowInventory)).digest('hex'), v3WorkflowInventoryRef: OUTPUTS.workflowInventory };
  const outputs: Record<string, string> = {
    [OUTPUTS.workflowInventory]: pretty(workflowInventory),
    [OUTPUTS.normalizedInput]: pretty(projection.input),
    [OUTPUTS.coverageReport]: serializeCoverageReport(report),
    [OUTPUTS.normalizationEvidence]: pretty({ ...projection.normalizationEvidence, coverageReportFingerprint: report.inputFingerprint, workflowInventorySummary: workflowInventory.summary, evaluatedTargetScopeResults: targetScopeResults }),
  };
  if (check) {
    for (const [path, expected] of Object.entries(outputs)) {
      const actual = await readFile(resolve(ROOT, path), 'utf8');
      if (!isCoverageReportCurrent(expected, actual)) throw new Error(`Stale v3 coverage output: ${path}`);
    }
  } else {
    for (const [path, contents] of Object.entries(outputs)) await writeFile(resolve(ROOT, path), contents, 'utf8');
  }
  process.stdout.write(`${JSON.stringify({ mode: check ? 'check' : 'normalize', outputs: Object.keys(outputs), ...report.scopedWorkflowProgress, rawRosterRows: report.unresolvedUniverseRecordRows, activeCanonicalProducts: report.products.activeProducts, objectiveEstablished: report.objectiveEstablished, fingerprint: report.inputFingerprint, v3CatalogManifestHash: report.v3CatalogManifestHash, workflowInventorySha256: report.workflowInventorySha256 }, null, 2)}\n`);
}

function pretty(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

run().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; });
