import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertBaselinePreserved, catalogDiff, renderGeneratedModule, validateBaseline, validateCatalogDocument } from '../../src/modules/defi/catalog-tooling/catalog-generator';

const root = process.cwd();
const inputPath = resolve(root, process.env.DEFI_CATALOG_INPUT ?? 'data/defi-catalog/v1/catalog.json');
const baselinePath = resolve(root, 'data/defi-catalog/v1/pre-migration-baseline.json');
const outputPath = resolve(root, process.env.DEFI_CATALOG_OUTPUT ?? 'src/modules/defi/registry/generated/production-catalog.ts');
const mode = process.argv[2];

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch (error) { throw new Error(`Unable to read valid JSON at ${path}: ${(error as Error).message}`); }
}

try {
  const current = validateCatalogDocument(readJson(inputPath));
  const baseline = validateBaseline(readJson(baselinePath));
  const diff = catalogDiff({ chains: baseline.chains }, current);
  if (mode === 'diff') {
    process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
  } else if (mode === 'generate') {
    assertBaselinePreserved(current, baseline);
    writeFileSync(outputPath, renderGeneratedModule(current), 'utf8');
  } else if (mode === 'check') {
    assertBaselinePreserved(current, baseline);
    const expected = renderGeneratedModule(current);
    const actual = readFileSync(outputPath, 'utf8');
    if (actual !== expected) throw new Error('Generated catalog is stale; run npm run defi:catalog:generate');
    process.stdout.write('Generated DeFi catalog is current.\n');
  } else {
    throw new Error('Usage: cli.ts <generate|check|diff>');
  }
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
