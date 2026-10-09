import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { auditCatalogRefresh } from '../../src/modules/defi/catalog-tooling/refresh-audit';
import { PRODUCTION_DEFI_CAPABILITY_BUNDLES } from '../../src/modules/defi/bundles/production-bundles';
import { loadReviewedV3ProfileBaseline } from '../../src/modules/defi/catalog-tooling/refresh-audit';

type CliOptions = { current: string; proposed: string; checkCurrent: boolean };

function selectedProductionCatalog(root: string): string {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
  const command = pkg.scripts?.['defi:catalog:check'];
  const match = typeof command === 'string' && command.match(/^ts-node --transpile-only scripts\/defi-catalog\/cli\.ts check --input data\/defi-catalog\/(v[1-4])\/catalog\.json$/);
  if (!match) throw new Error('package.json defi:catalog:check must select one fixed v1-v4 catalog path');
  return `data/defi-catalog/${match[1]}/catalog.json`;
}

function parseArgs(args: readonly string[]): CliOptions {
  if (args.length === 1 && args[0] === '--check-current') {
    const proposed = selectedProductionCatalog(process.cwd());
    const current = proposed === 'data/defi-catalog/v4/catalog.json' ? 'data/defi-catalog/v3/catalog.json' : proposed;
    return { current, proposed, checkCurrent: true };
  }
  let current: string | undefined;
  let proposed: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[++i];
    if (!value || !['--current', '--proposed'].includes(flag)) throw new Error('Usage: refresh-audit-cli.ts (--check-current | --current data/defi-catalog/v1..v4/catalog.json --proposed data/defi-catalog/v1..v4/catalog.json)');
    if (flag === '--current' && !current) current = value;
    else if (flag === '--proposed' && !proposed) proposed = value;
    else throw new Error('Duplicate or unsupported refresh-audit option');
  }
  if (!current || !proposed) throw new Error('Both --current and --proposed fixed catalog paths are required');
  return { current, proposed, checkCurrent: false };
}

function fixedCatalogPath(repositoryRoot: string, selected: string): string {
  if (!/^data\/defi-catalog\/v[1-4]\/catalog\.json$/.test(selected)) throw new Error('Catalog paths must be one of the fixed data/defi-catalog/v1-v4/catalog.json files');
  const root = realpathSync(repositoryRoot);
  const dataRoot = realpathSync(resolve(root, 'data/defi-catalog'));
  const path = resolve(root, selected);
  const actual = realpathSync(path);
  const relativeActual = relative(dataRoot, actual);
  const expectedRelative = selected.slice('data/defi-catalog/'.length).replaceAll('/', sep);
  if (actual !== path || relativeActual !== expectedRelative || relativeActual.startsWith(`..${sep}`) || relativeActual === '..' || lstatSync(path).isSymbolicLink()) {
    throw new Error('Catalog path must resolve to a repository-owned data/defi-catalog/vN/catalog.json file');
  }
  return actual;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const currentPath = fixedCatalogPath(root, options.current);
  const proposedPath = fixedCatalogPath(root, options.proposed);
  const currentProfiles = options.current === 'data/defi-catalog/v3/catalog.json' ? loadReviewedV3ProfileBaseline()
    : options.current === 'data/defi-catalog/v4/catalog.json' ? PRODUCTION_DEFI_CAPABILITY_BUNDLES : [];
  const proposedProfiles = options.proposed === 'data/defi-catalog/v3/catalog.json' ? loadReviewedV3ProfileBaseline()
    : options.proposed === 'data/defi-catalog/v4/catalog.json' ? PRODUCTION_DEFI_CAPABILITY_BUNDLES : [];
  const result = auditCatalogRefresh(readJson(currentPath), readJson(proposedPath), { currentProfiles, proposedProfiles });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (options.checkCurrent && result.status === 'BLOCKED') throw new Error(`Current catalog audit returned ${result.status}`);
  if (!options.checkCurrent && result.status !== 'VALID_NO_CHANGE') process.exitCode = 2;
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
