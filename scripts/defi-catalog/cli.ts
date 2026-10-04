import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { assembleCatalogFromSources, assertBaselinePreserved, catalogDiff, parseCatalogCliArgs, renderGeneratedModule, validateBaseline, validateCatalogDocument } from '../../src/modules/defi/catalog-tooling/catalog-generator';

const root = process.cwd();
const baselinePath = resolve(root, 'data/defi-catalog/v1/pre-migration-baseline.json');
const outputPath = resolve(root, 'src/modules/defi/registry/generated/production-catalog.ts');
const sourcePaths = ['data/defi-catalog/v2/sources/dex.json', 'data/defi-catalog/v2/sources/lending-yield.json'];
const admissionsPath = resolve(root, 'data/defi-catalog/v2/admissions.json');
const assembledCatalogPath = resolve(root, 'data/defi-catalog/v2/catalog.json');
const v3SourcePath = resolve(root, 'data/defi-catalog/v3/sources/workflow-extensions.json');
const v3AdmissionsPath = resolve(root, 'data/defi-catalog/v3/admissions.json');
const v3CatalogPath = resolve(root, 'data/defi-catalog/v3/catalog.json');
const v4SourcePaths = ['data/defi-catalog/v4/sources/ordinary-protocols.json', 'data/defi-catalog/v4/sources/yearn.json'];
const v4AdmissionsPath = resolve(root, 'data/defi-catalog/v4/admissions.json');
const v4CatalogPath = resolve(root, 'data/defi-catalog/v4/catalog.json');

function resolveSourceCatalogPath(rootPath: string, inputPath: string): string {
  const repositoryRoot = realpathSync(rootPath);
  const dataRoot = realpathSync(resolve(repositoryRoot, 'data/defi-catalog'));
  const sourcePath = realpathSync(resolve(repositoryRoot, inputPath));
  const sourceRelative = relative(dataRoot, sourcePath);
  const selectedRelative = inputPath.replace(/^data\/defi-catalog\//, '').replaceAll('/', sep);
  if (sourceRelative !== selectedRelative || sourceRelative.startsWith(`..${sep}`) || sourceRelative === '..' || !/^v[1-9][0-9]*[\\/]catalog\.json$/.test(sourceRelative)) {
    throw new Error('Catalog input must resolve inside data/defi-catalog/vN/catalog.json');
  }
  return sourcePath;
}

function assertFixedOutputPath(): void {
  const repositoryRoot = realpathSync(root);
  const expectedParent = resolve(repositoryRoot, 'src/modules/defi/registry/generated');
  const actualParent = realpathSync(dirname(outputPath));
  let outputIsSymlink = false;
  try { outputIsSymlink = lstatSync(outputPath).isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (actualParent !== expectedParent || outputIsSymlink) {
    throw new Error('Generated output path must be the repository-owned production catalog file');
  }
}

function assertFixedFilePath(path: string, relativePath: string): string {
  const repositoryRoot = realpathSync(root);
  const expected = resolve(repositoryRoot, relativePath);
  const actual = realpathSync(path);
  if (actual !== expected || lstatSync(path).isSymbolicLink()) throw new Error(`Input path must be the fixed repository-owned file ${relativePath}`);
  return actual;
}

function assertFixedDataOutputPath(path: string, relativePath: string): string {
  const repositoryRoot = realpathSync(root);
  const expected = resolve(repositoryRoot, relativePath);
  const actualParent = realpathSync(dirname(path));
  let isSymlink = false;
  try { isSymlink = lstatSync(path).isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (actualParent !== resolve(dirname(expected)) || resolve(path) !== expected || isSymlink) {
    throw new Error(`Output path must be the fixed repository-owned file ${relativePath}`);
  }
  return path;
}

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch (error) { throw new Error(`Unable to read valid JSON at ${path}: ${(error as Error).message}`); }
}

try {
  const options = parseCatalogCliArgs(process.argv.slice(2));
  if (options.mode === 'assemble') {
    const isV3 = options.inputPath === 'data/defi-catalog/v3/catalog.json';
    const isV4 = options.inputPath === 'data/defi-catalog/v4/catalog.json';
    const baseline = validateBaseline(readJson(assertFixedFilePath(baselinePath, 'data/defi-catalog/v1/pre-migration-baseline.json')));
    const basePath = isV4 ? 'data/defi-catalog/v3/catalog.json' : isV3 ? 'data/defi-catalog/v2/catalog.json' : 'data/defi-catalog/v1/catalog.json';
    const base = validateCatalogDocument(readJson(assertFixedFilePath(resolve(root, basePath), basePath)));
    const inputs = isV4
      ? v4SourcePaths.map((relativePath) => ({ sourcePath: relativePath, document: readJson(assertFixedFilePath(resolve(root, relativePath), relativePath)) }))
      : isV3
      ? [{ sourcePath: 'data/defi-catalog/v3/sources/workflow-extensions.json', document: readJson(assertFixedFilePath(v3SourcePath, 'data/defi-catalog/v3/sources/workflow-extensions.json')) }]
      : sourcePaths.map((relativePath) => ({ sourcePath: relativePath, document: readJson(assertFixedFilePath(resolve(root, relativePath), relativePath)) }));
    const admissionFile = isV4 ? v4AdmissionsPath : isV3 ? v3AdmissionsPath : admissionsPath;
    const admissionRelative = isV4 ? 'data/defi-catalog/v4/admissions.json' : isV3 ? 'data/defi-catalog/v3/admissions.json' : 'data/defi-catalog/v2/admissions.json';
    const admissions = readJson(assertFixedFilePath(admissionFile, admissionRelative));
    const assembled = assembleCatalogFromSources({ chains: base.chains }, inputs, admissions);
    const target = isV4
      ? assertFixedDataOutputPath(v4CatalogPath, 'data/defi-catalog/v4/catalog.json')
      : assertFixedFilePath(isV3 ? v3CatalogPath : assembledCatalogPath, isV3 ? 'data/defi-catalog/v3/catalog.json' : 'data/defi-catalog/v2/catalog.json');
    writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, chains: assembled.chains }, null, 2)}\n`, 'utf8');
    process.stdout.write(`Assembled ${assembled.chains.reduce((count, chain) => count + chain.contracts.reduce((sum, contract) => sum + contract.functions.length, 0), 0)} source-qualified definitions.\n`);
  } else {
  const inputPath = resolveSourceCatalogPath(root, options.inputPath);
  assertFixedOutputPath();
  const current = validateCatalogDocument(readJson(inputPath));
  const baseline = validateBaseline(readJson(baselinePath));
  const comparison = options.inputPath === 'data/defi-catalog/v4/catalog.json'
    ? validateCatalogDocument(readJson(assertFixedFilePath(resolve(root, 'data/defi-catalog/v3/catalog.json'), 'data/defi-catalog/v3/catalog.json')))
    : options.inputPath === 'data/defi-catalog/v3/catalog.json'
    ? validateCatalogDocument(readJson(assertFixedFilePath(resolve(root, 'data/defi-catalog/v2/catalog.json'), 'data/defi-catalog/v2/catalog.json')))
    : { chains: baseline.chains };
  const diff = catalogDiff(comparison, current);
  if (options.mode === 'diff') {
    process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
  } else if (options.mode === 'generate') {
    assertBaselinePreserved(current, baseline);
    writeFileSync(outputPath, renderGeneratedModule(current), 'utf8');
  } else if (options.mode === 'check') {
    assertBaselinePreserved(current, baseline);
    const expected = renderGeneratedModule(current);
    const actual = readFileSync(outputPath, 'utf8');
    if (actual !== expected) throw new Error(`Generated catalog is stale; run npm run defi:catalog:generate -- --input ${options.inputPath}`);
    process.stdout.write('Generated DeFi catalog is current.\n');
  }
  }
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
