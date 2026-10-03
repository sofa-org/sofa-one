import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { adaptV2Sources, buildV2Manifest } from '../../src/modules/defi/coverage-tooling/v2-adapter';
import { computeCoverage } from '../../src/modules/defi/coverage-tooling/calculator';
import { validateCoverageInput } from '../../src/modules/defi/coverage-tooling/calculator';
import { compactJsonPropertyHash } from '../../src/modules/defi/coverage-tooling/baseline-adapter';

const ROOT = process.cwd();
const files = {
  market: 'data/defi-coverage/market-snapshot.json',
  activity: 'data/defi-coverage/v2/activity-snapshot.json',
  crosswalk: 'data/defi-coverage/v2/identity-crosswalk.json',
  methods: 'data/defi-coverage/v2/activity-methods.json',
  workflows: 'data/defi-coverage/v2/workflow-inventory.json',
  catalog: 'data/defi-catalog/v2/catalog.json',
  catalogSource: 'data/defi-catalog/v2/sources/dex.json',
} as const;
const outputs = {
  input: 'data/defi-coverage/v2/normalized-input.json',
  report: 'data/defi-coverage/v2/coverage-report.json',
  evidence: 'data/defi-coverage/v2/normalization-evidence.json',
} as const;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check')) throw new Error('Usage: npx ts-node scripts/defi-coverage/v2-cli.ts [--check]');
  const check = args.includes('--check');
  const loaded = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, path]) => [key, JSON.parse(await readFile(resolve(ROOT, path), 'utf8'))]))) as any;
  const marketText = await readFile(resolve(ROOT, files.market), 'utf8');
  const actualRosterHash = compactJsonPropertyHash(marketText, 'protocolUniverse');
  if (actualRosterHash !== loaded.crosswalk.m1UniverseCanonicalJsonSha256) throw new Error('Frozen M1 protocolUniverse content hash mismatch');
  const projection = adaptV2Sources(loaded);
  const manifest = buildV2Manifest(loaded.catalog, loaded.catalogSource);
  const errors = validateCoverageInput(projection.input, manifest);
  if (errors.length) throw new Error(`Normalized input failed strict calculator validation: ${JSON.stringify(errors)}`);
  const report = computeCoverage(projection.input, manifest);
  const evidence = { ...projection.evidence, reportFingerprint: report.inputFingerprint, outputClaim: 'Reproducible source-normalized evidence; not proof of market completeness, execution safety, liquidity, or transaction success.' };
  const generated = [[outputs.input, projection.input], [outputs.report, report], [outputs.evidence, evidence]] as const;
  for (const [path, value] of generated) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (check) {
      const actual = await readFile(resolve(ROOT, path), 'utf8');
      if (actual !== text) throw new Error(`Stale v2 coverage output: ${path}`);
    } else await writeFile(resolve(ROOT, path), text, 'utf8');
  }
  console.log(JSON.stringify({ mode: check ? 'check' : 'generate', outputs: Object.values(outputs), rawRosterRows: 8476, metricRows: loaded.activity.sourceIdMetricRows.length, mappedIdentityRows: projection.evidence.identityLedger.filter((row: any) => row.disposition === 'mapped').length, partialIdentityRows: projection.evidence.identityLedger.filter((row: any) => row.disposition === 'partial').length, unresolvedProxyRows: report.products.unresolvedUniverseRecords, activeProducts: report.products.activeProducts, observedCoverageBps: report.products.observedActiveCoverageBps, conservativeCoverageBps: report.products.conservativeCoverageBps, workflowRows: report.workflowInventory.length, objectiveEstablished: report.objectiveEstablished, fingerprint: report.inputFingerprint }, null, 2));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
