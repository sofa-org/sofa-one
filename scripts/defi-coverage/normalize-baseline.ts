import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { adaptFrozenBaseline, compactJsonPropertyHash } from '../../src/modules/defi/coverage-tooling/baseline-adapter';
import { computeCoverage } from '../../src/modules/defi/coverage-tooling/calculator';
import { PRODUCTION_DEFI_MANIFEST } from '../../src/modules/defi/registry/production-registry';
import { functionAbiHash } from '../../src/modules/defi/registry/defi-manifest';

const ROOT = process.cwd();
const PATHS = {
  market: 'data/defi-coverage/market-snapshot.json',
  classification: 'data/defi-coverage/discovery-classification.json',
  workflows: 'data/defi-coverage/workflow-baseline.json',
  normalized: 'data/defi-coverage/normalized-baseline.json',
  report: 'data/defi-coverage/coverage-baseline-report.json',
  evidence: 'data/defi-coverage/normalization-evidence.json',
} as const;

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check')) throw new Error('Usage: normalize-baseline.ts [--check]');
  const checkMode = args.includes('--check');
  const sourcePaths = [PATHS.market, PATHS.classification, PATHS.workflows] as const;
  const [marketBytes, classificationBytes, workflowBytes] = await Promise.all(sourcePaths.map((path) => readFile(resolve(ROOT, path))));
  const digests = Object.fromEntries(sourcePaths.map((path, index) => [path, createHash('sha256').update([marketBytes, classificationBytes, workflowBytes][index]).digest('hex')]));
  const projection = adaptFrozenBaseline({
    market: JSON.parse(marketBytes.toString('utf8')),
    classification: JSON.parse(classificationBytes.toString('utf8')),
    workflows: JSON.parse(workflowBytes.toString('utf8')),
    manifestHash: PRODUCTION_DEFI_MANIFEST.manifestHash,
    sourceRosterCanonicalSha256: compactJsonPropertyHash(marketBytes.toString('utf8'), 'protocolUniverse'),
    manifest: PRODUCTION_DEFI_MANIFEST.capabilities.map((capability) => ({
      capabilityId: capability.capabilityId,
      status: capability.status,
      type: capability.type,
      chainId: capability.chainId,
      contract: capability.contract,
      signature: capability.signature,
      abiHash: functionAbiHash(capability),
      provenance: capability.provenance,
    })),
    sourceFileDigests: digests,
  });
  const report = computeCoverage(projection.input, PRODUCTION_DEFI_MANIFEST.capabilities.map((capability) => ({
    capabilityId: capability.capabilityId,
    status: capability.status,
    type: capability.type,
    chainId: capability.chainId,
    contract: capability.contract,
    signature: capability.signature,
    abiHash: functionAbiHash(capability),
    provenance: capability.provenance,
  })));
  const evidence: Record<string, any> = { ...projection.evidence, reportFingerprint: report.inputFingerprint };
  const outputs = [
    [PATHS.normalized, projection.input],
    [PATHS.report, report],
    [PATHS.evidence, evidence],
  ] as const;
  if (checkMode) {
    for (const [path, data] of outputs) {
      const expected = `${JSON.stringify(data, null, 2)}\n`;
      const actual = await readFile(resolve(ROOT, path), 'utf8');
      if (actual !== expected) throw new Error(`Stale baseline output: ${path}`);
    }
  } else {
    for (const [path, data] of outputs) await writeFile(resolve(ROOT, path), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify({
    mode: checkMode ? 'check' : 'normalize',
    outputs: [PATHS.normalized, PATHS.report, PATHS.evidence],
    rawRosterRecords: evidence.roster.sourceRecordCount,
    conservativeProxyRows: report.products.unresolvedUniverseRecords,
    unresolvedUniverseRecords: report.unresolvedUniverseRecordRows,
    unattributedUnresolvedUniverseRecords: report.unattributedUnresolvedUniverseRecords,
    activeProducts: report.products.activeProducts,
    observedCoverageBps: report.products.observedActiveCoverageBps,
    conservativeCoverageBps: report.products.conservativeCoverageBps,
    workflowDefinitions: report.workflowInventory.length,
    completeWorkflowRows: report.workflowCoverage.completeWorkflows,
    unresolvedWorkflowRows: report.workflowInventory.filter((row) => row.requirementStatus === 'unresolved').length,
    workflowSeedSourceCounts: {
      products: evidence.workflowProjection.sourceProductSeeds,
      definitions: evidence.workflowProjection.sourceWorkflowDefinitions,
      exactAddressTargets: evidence.workflowProjection.exactAddressTargets,
      unknownTargetRows: evidence.workflowProjection.unknownTargetRows,
      exactCatalogFunctionBindings: evidence.workflowProjection.exactCatalogFunctionBindingsInSeed,
      unassignedTargets: evidence.workflowProjection.unassignedTargetCount,
      unassignedExactBindings: evidence.workflowProjection.unassignedExactFunctionBindings,
    },
    objectiveEstablished: report.objectiveEstablished,
    identityEnumerationComplete: report.identityEnumerationComplete,
    enumerationComplete: report.enumerationComplete,
    fingerprint: report.inputFingerprint,
  }, null, 2));
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  if (error instanceof Error && 'errors' in error) console.error(JSON.stringify((error as Error & { errors: unknown }).errors, null, 2));
  process.exitCode = 1;
});
