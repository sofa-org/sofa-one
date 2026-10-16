import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SUPPORTED_PROTOCOLS } from './supported-protocols';

interface CatalogFunction {
  protocol: string;
  status: string;
}

interface Catalog {
  chains: Array<{
    contracts: Array<{
      functions: CatalogFunction[];
    }>;
  }>;
}

const catalogPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data/defi-catalog/catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as Catalog;

describe('supported protocol directory', () => {
  it('lists the newly admitted families once with their official websites', () => {
    for (const expected of [
      { name: 'GMX', website: 'https://gmx.io' },
      { name: 'SmarDex', website: 'https://smardex.io' },
    ]) {
      expect(SUPPORTED_PROTOCOLS.filter((protocol) => protocol.name === expected.name)).toEqual([
        expected,
      ]);
    }

    expect(SUPPORTED_PROTOCOLS.filter((protocol) => protocol.name === 'Liquity')).toHaveLength(1);
  });

  it('keeps canonical names unique and all directory links HTTPS', () => {
    const names = SUPPORTED_PROTOCOLS.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    expect(SUPPORTED_PROTOCOLS.every(({ website }) => website.startsWith('https://'))).toBe(true);
  });

  it('keeps the new family listings backed by active catalog entries', () => {
    const functions = catalog.chains.flatMap((chain) =>
      chain.contracts.flatMap((contract) => contract.functions),
    );

    for (const protocol of ['GMX', 'SmarDex']) {
      expect(functions.some((entry) => entry.protocol === protocol && entry.status === 'active')).toBe(
        true,
      );
    }
  });
});
