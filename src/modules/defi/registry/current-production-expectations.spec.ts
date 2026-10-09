import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { loadCurrentProductionExpectations } from './__fixtures__/current-production-expectations';
import { loadCurrentCatalogUpdate } from '../../../../scripts/defi-catalog/update-cli-current';

const ROOT = process.cwd();
const UPDATE = 'data/defi-catalog/updates/comet-usdc-direct';

describe('current production test expectations', () => {
  it('derives the live batch counts from the selected saved catalog, not the generated module', () => {
    const expected = loadCurrentProductionExpectations(ROOT);
    const selectedPlan = loadCurrentCatalogUpdate(ROOT);
    expect(selectedPlan).toBeDefined();
    const actual = readFileSync(resolve(ROOT, `${dirname(selectedPlan!)}/catalog.json`), 'utf8');
    const actualFunctions = JSON.parse(actual).chains.flatMap((chain: any) => chain.contracts.flatMap((contract: any) => contract.functions));
    expect(expected.definitions).toBe(actualFunctions.length);
    expect(expected.actions).toBe(actualFunctions.filter((fn: any) => fn.type === 'contract_call' && !(fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)')).length);
    expect(expected.approvals).toBe(actualFunctions.filter((fn: any) => fn.type === 'contract_call' && fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)').length);
    expect(expected.scopes).toBe(actualFunctions.filter((fn: any) => fn.executionScope).length);
  });

  it('tracks a different selected saved-catalog count and falls back to pinned v9 only without a pointer', () => {
    const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'current-catalog-expectations-'));
    try {
      const v9 = JSON.parse(readFileSync(resolve(ROOT, 'data/defi-catalog/v9/catalog.json'), 'utf8'));
      mkdirSync(resolve(temporaryRoot, 'data/defi-catalog/v9'), { recursive: true });
      mkdirSync(resolve(temporaryRoot, 'data/defi-catalog/updates'), { recursive: true });
      writeFileSync(resolve(temporaryRoot, 'data/defi-catalog/v9/catalog.json'), JSON.stringify(v9));
      expect(loadCurrentProductionExpectations(temporaryRoot).definitions).toBe(673);

      const updateDir = resolve(temporaryRoot, 'data/defi-catalog/updates/test-batch');
      mkdirSync(updateDir, { recursive: true });
      const plan = JSON.parse(readFileSync(resolve(ROOT, `${UPDATE}/plan.json`), 'utf8'));
      plan.sources[0].path = 'data/defi-catalog/updates/test-batch/sources/compound-comet.json';
      for (const admission of plan.admissions) admission.sourcePath = plan.sources[0].path;
      const planBytes = Buffer.from(JSON.stringify(plan));
      writeFileSync(resolve(updateDir, 'plan.json'), planBytes);
      const current = JSON.parse(readFileSync(resolve(ROOT, `${UPDATE}/catalog.json`), 'utf8'));
      const contract = current.chains.flatMap((chain: any) => chain.contracts).find((item: any) => item.address.toLowerCase() === '0xc3d688b66703497daa19211eedff47f25384cdc3');
      contract.functions = contract.functions.filter((fn: any) => !fn.capabilityId.endsWith(':withdraw-to'));
      writeFileSync(resolve(updateDir, 'catalog.json'), JSON.stringify(current));
      mkdirSync(resolve(temporaryRoot, 'data/defi-catalog/updates'), { recursive: true });
      writeFileSync(resolve(temporaryRoot, 'data/defi-catalog/updates/current.json'), JSON.stringify({
        schemaVersion: 1,
        planPath: 'data/defi-catalog/updates/test-batch/plan.json',
        planRawSha256: createHash('sha256').update(planBytes).digest('hex'),
      }));
      expect(loadCurrentProductionExpectations(temporaryRoot)).toMatchObject({ definitions: 674, actions: 651, approvals: 23, scopes: 16 });
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
