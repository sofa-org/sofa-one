import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { catalogDiff, parseCatalogCliArgs, renderGeneratedModule, validateCatalogDocument } from '../../src/modules/defi/catalog-tooling/catalog-generator';
import { GENERATED_DEFI_REGISTRY } from '../../src/modules/defi/registry/generated/production-catalog';

const root = realpathSync(process.cwd());
const catalogRelativePath = 'data/defi-catalog/catalog.json';
const outputRelativePath = 'src/modules/defi/registry/generated/production-catalog.ts';
const catalogPath = resolve(root, catalogRelativePath);
const outputPath = resolve(root, outputRelativePath);

function assertFixedFile(path: string, relativePath: string): string {
  const expected = resolve(root, relativePath);
  const actual = realpathSync(path);
  if (actual !== expected || lstatSync(path).isSymbolicLink()) {
    throw new Error(`Path must be the fixed repository-owned file ${relativePath}`);
  }
  return actual;
}

try {
  const { mode } = parseCatalogCliArgs(process.argv.slice(2));
  const input = JSON.parse(readFileSync(assertFixedFile(catalogPath, catalogRelativePath), 'utf8')) as unknown;
  const catalog = validateCatalogDocument(input);
  const expectedModule = renderGeneratedModule(catalog);
  const modulePath = assertFixedFile(outputPath, outputRelativePath);

  if (mode === 'generate') {
    writeFileSync(modulePath, expectedModule, 'utf8');
    process.stdout.write('Generated static DeFi catalog module.\n');
  } else if (mode === 'check') {
    const actualModule = readFileSync(modulePath, 'utf8');
    if (actualModule !== expectedModule) {
      throw new Error('Generated DeFi catalog module does not match data/defi-catalog/catalog.json; run npm run defi:catalog:generate');
    }
    process.stdout.write('Catalog input and generated runtime module match.\n');
  } else {
    const diff = catalogDiff(GENERATED_DEFI_REGISTRY, catalog);
    process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
