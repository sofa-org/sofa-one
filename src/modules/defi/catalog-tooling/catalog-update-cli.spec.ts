import { parseUpdateArgs } from '../../../../scripts/defi-catalog/update-cli-args';
import { assertSavedUpdateCatalogParity, assertUpdateRepositoryFile } from '../../../../scripts/defi-catalog/update-cli-files';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

describe('generic catalog update CLI arguments', () => {
  const plan = 'data/defi-catalog/updates/comet-usdc-direct/plan.json';

  it('accepts the fixed plan path and only permits write for update-build', () => {
    expect(parseUpdateArgs('update-preview', ['--plan', plan])).toEqual({ planPath: plan, write: false });
    expect(parseUpdateArgs('update-build', ['--plan', plan, '--write'])).toEqual({ planPath: plan, write: true });
    expect(parseUpdateArgs('generate', ['--plan', plan])).toEqual({ planPath: plan, write: false });
  });

  it.each([
    ['update-preview', ['--plan', plan, '--write']],
    ['update-build', ['--plan', plan, '--write', '--write']],
    ['check', ['--plan', plan, '--output', '/tmp/catalog.json']],
    ['diff', ['--plan', '../outside/plan.json']],
    ['update-build', ['--plan', 'https://example.invalid/plan.json']],
    ['update-build', ['--plan', plan, '--plan', plan]],
    ['update-build', ['--plan', '--write']],
  ] as const)('rejects unsafe/unknown args for %s', (mode, args) => {
    expect(() => parseUpdateArgs(mode, args)).toThrow();
  });
});

describe('generic catalog update CLI filesystem guards', () => {
  const tempParent = '/private/var/folders/d5/bq_4hlms3xb3f03m4w9y582h0000gp/T/opencode';
  let root: string;
  const plan = 'data/defi-catalog/updates/demo/plan.json';
  const catalog = 'data/defi-catalog/updates/demo/catalog.json';
  const module = 'src/modules/defi/registry/generated/production-catalog.ts';
  const document = { schemaVersion: 1, chains: [{ chainId: 1, contracts: [{ functions: [{ capabilityId: 'sample', label: 'original' }] }] }] };
  const canonicalize = (value: unknown) => JSON.stringify(value);

  beforeEach(() => {
    root = mkdtempSync(join(tempParent, 'defi-update-cli-'));
    mkdirSync(join(root, 'data/defi-catalog/updates/demo/sources'), { recursive: true });
    mkdirSync(join(root, 'data/defi-catalog/v9'), { recursive: true });
    mkdirSync(join(root, 'src/modules/defi/registry/generated'), { recursive: true });
    writeFileSync(join(root, plan), '{}');
    writeFileSync(join(root, 'data/defi-catalog/updates/demo/sources/a.json'), '{}');
    writeFileSync(join(root, 'data/defi-catalog/v9/catalog.json'), '{}');
    writeFileSync(join(root, catalog), JSON.stringify(document));
    writeFileSync(join(root, module), 'sentinel module bytes');
  });

  afterEach(() => {
    if (!root.startsWith(join(tempParent, 'defi-update-cli-'))) throw new Error('Refusing to remove non-fixture path');
    rmSync(root, { recursive: true, force: true });
  });

  it('allows fixed repository files and a missing leaf output without writing during validation', () => {
    const before = createHash('sha256').update(readFileSync(join(root, module))).digest('hex');
    expect(assertUpdateRepositoryFile(root, plan)).toBe(join(root, plan));
    expect(assertUpdateRepositoryFile(root, 'data/defi-catalog/updates/demo/new-catalog.json', true)).toBe(join(root, 'data/defi-catalog/updates/demo/new-catalog.json'));
    assertSavedUpdateCatalogParity(root, catalog, canonicalize(document), canonicalize);
    const after = createHash('sha256').update(readFileSync(join(root, module))).digest('hex');
    expect(after).toBe(before);
    expect(() => assertUpdateRepositoryFile(root, 'data/defi-catalog/updates/demo/new/sub/catalog.json', true)).toThrow();
  });

  it.each([
    ['/absolute/plan.json'],
    ['../outside/plan.json'],
    ['data/defi-catalog/updates/demo/../../v9/catalog.json'],
    ['https://example.invalid/plan.json'],
    ['data\\defi-catalog\\updates\\demo\\plan.json'],
  ])('rejects absolute, traversal, URL, or malformed path %s', (path) => {
    expect(() => assertUpdateRepositoryFile(root, path)).toThrow();
  });

  it('rejects symlink files and parent directories, including links that stay inside the root', () => {
    const inside = join(root, 'data/defi-catalog/updates/demo/inside.json');
    symlinkSync(join(root, plan), inside);
    expect(() => assertUpdateRepositoryFile(root, 'data/defi-catalog/updates/demo/inside.json')).toThrow();
    const outside = join(root, 'outside.json');
    writeFileSync(outside, '{}');
    symlinkSync(outside, join(root, 'data/defi-catalog/updates/demo/outside.json'));
    expect(() => assertUpdateRepositoryFile(root, 'data/defi-catalog/updates/demo/outside.json')).toThrow();

    symlinkSync(join(root, 'data/defi-catalog/updates/demo'), join(root, 'data/defi-catalog/updates/alias'));
    expect(() => assertUpdateRepositoryFile(root, 'data/defi-catalog/updates/alias/plan.json')).toThrow();
    symlinkSync(join(root, 'data/defi-catalog/v9'), join(root, 'data/defi-catalog/updates/demo/parent-link'));
    expect(() => assertUpdateRepositoryFile(root, 'data/defi-catalog/updates/demo/parent-link/catalog.json')).toThrow();
    mkdirSync(join(root, 'outside-dir'));
    writeFileSync(join(root, 'outside-dir/plan.json'), '{}');
    symlinkSync(join(root, 'outside-dir'), join(root, 'data/defi-catalog/updates/outside-parent'));
    expect(() => assertUpdateRepositoryFile(root, 'data/defi-catalog/updates/outside-parent/plan.json')).toThrow();
  });

  it('rejects selected-catalog and fixed-module symlink leaves and parents', () => {
    const catalogBackup = join(root, 'catalog-backup.json');
    writeFileSync(catalogBackup, JSON.stringify(document));
    rmSync(join(root, catalog));
    symlinkSync(catalogBackup, join(root, catalog));
    expect(() => assertUpdateRepositoryFile(root, catalog, true)).toThrow();

    const moduleBackup = join(root, 'module-backup.ts');
    writeFileSync(moduleBackup, 'sentinel module bytes');
    rmSync(join(root, module));
    symlinkSync(moduleBackup, join(root, module));
    expect(() => assertUpdateRepositoryFile(root, module, true)).toThrow();

    symlinkSync(join(root, 'data/defi-catalog/updates/demo'), join(root, 'data/defi-catalog/updates/catalog-parent'));
    expect(() => assertUpdateRepositoryFile(root, 'data/defi-catalog/updates/catalog-parent/catalog.json', true)).toThrow();

    const generated = join(root, 'src/modules/defi/registry/generated');
    rmSync(generated, { recursive: true, force: true });
    symlinkSync(join(root, 'outside-dir'), generated);
    expect(() => assertUpdateRepositoryFile(root, module, true)).toThrow();
  });

  it('rejects malformed or metadata-modified saved catalogs before a module write', () => {
    const modulePath = join(root, module);
    const originalModule = readFileSync(modulePath, 'utf8');
    const writeModuleAfterParity = jest.fn(() => writeFileSync(modulePath, 'generated module'));
    const guardedWrite = () => {
      assertSavedUpdateCatalogParity(root, catalog, canonicalize(document), canonicalize);
      writeModuleAfterParity();
    };

    const mutated = { ...document, chains: [{ ...document.chains[0], contracts: [{ functions: [{ capabilityId: 'sample', label: 'tampered' }] }] }] };
    writeFileSync(join(root, catalog), JSON.stringify(mutated));
    expect(guardedWrite).toThrow('Saved update catalog differs');
    expect(writeModuleAfterParity).not.toHaveBeenCalled();
    expect(readFileSync(modulePath, 'utf8')).toBe(originalModule);

    writeFileSync(join(root, catalog), '{invalid');
    expect(guardedWrite).toThrow('Unable to read valid saved update catalog');
    expect(writeModuleAfterParity).not.toHaveBeenCalled();
    expect(readFileSync(modulePath, 'utf8')).toBe(originalModule);
  });
});
