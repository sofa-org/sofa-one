import { readFileSync } from 'node:fs';
import { inventoryAbi } from '../../src/modules/defi/catalog-tooling/abi-inventory';

try {
  if (process.argv.length !== 3) throw new Error('Usage: npm run defi:catalog:inventory -- <input.json>');
  const input = JSON.parse(readFileSync(process.argv[2], 'utf8')) as unknown;
  process.stdout.write(`${JSON.stringify(inventoryAbi(input), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
