import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { POLYMARKET_PUSD_WRAP_IDENTITY, POLYMARKET_PUSD_WRAP_SCOPE } from '../execution/pusd-identity';
import { canonicalSourceSha256, compileSourceSnapshotBindings, validateCatalogDocument } from './catalog-generator';
import { prepareCatalogUpdate, validateUpdatePlan } from './catalog-update';
import { executionScopeHash } from '../execution/scope';

const ROOT = process.cwd();
const UPDATE = 'data/defi-catalog/updates/polymarket-pusd';
const sourcePath = `${UPDATE}/sources/polymarket-pusd.json`;
const readJson = (path: string) => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) as any;
const source = readJson(sourcePath);
const plan = readJson(`${UPDATE}/plan.json`);
const baselinePath = plan.baseline.path as string;
const baselineRaw = readFileSync(resolve(ROOT, baselinePath));
const baseline = validateCatalogDocument(JSON.parse(baselineRaw.toString('utf8')));
const rawPin = plan.baseline.rawSha256 as string;
const input = [{ sourcePath, document: source }];

describe('closed exact Polymarket pUSD admission helper', () => {
  it('binds the single inactive source candidate to the pinned fixed USDC.e asset and recipient-policy scope', () => {
    const [candidate] = compileSourceSnapshotBindings(source, sourcePath);
    expect(candidate.fn.status).toBe('inactive');
    expect(candidate).toMatchObject({
      familyId: 'polymarket-pusd', familyVersion: 'collateral-onramp@27700089', chainId: 137,
      contract: POLYMARKET_PUSD_WRAP_IDENTITY.contract, signature: POLYMARKET_PUSD_WRAP_IDENTITY.signature,
      selector: '0x62355638', abiHash: '0x81dc7d5ac39b2555f3745adaf504e4a36d889896f2ce7ea8f38eb85f91596109',
    });
    expect(source.families[0].contracts).toHaveLength(1);
    expect(source.families[0].contracts[0].abiFunctions.map((fn: any) => fn.name)).toEqual(['wrap']);
    expect(plan.admissions[0].executionScope).toEqual(POLYMARKET_PUSD_WRAP_SCOPE);
    expect(plan.admissions[0].executionScopeHash).toBe(executionScopeHash(POLYMARKET_PUSD_WRAP_SCOPE));
    expect(plan.admissions[0].executionScope.asset).toBe('0x2791bca1f2de4661ed88a30c99a7a9449aa84174');
    expect(canonicalSourceSha256(source)).toBe(plan.sources[0].canonicalSha256);
  });

  it('rejects scope downgrade, scope alteration, mismatched identity pins, and generic ordinary scope use', () => {
    const mismatches: Array<(p: any) => void> = [
      (p) => { p.admissions[0].executionScope.recipientPolicy = 'any-recipient'; },
      (p) => { p.admissions[0].executionScope.asset = '0x0000000000000000000000000000000000000001'; },
      (p) => { p.admissions[0].executionScopeHash = `0x${'00'.repeat(32)}`; },
      (p) => { p.admissions[0].selector = '0x3d0a2f5e'; },
      (p) => { p.admissions[0].abiHash = `0x${'00'.repeat(32)}`; },
      (p) => { p.admissions[0].chainId = 1; },
      (p) => { p.admissions[0].contract = '0x1111111111111111111111111111111111111111'; },
      (p) => { p.admissions[0].signature = 'unwrap(address,address,uint256)'; },
      (p) => { p.admissions[0].capabilityId = 'wrong:capability'; },
    ];
    for (const mutate of mismatches) {
      const changed = JSON.parse(JSON.stringify(plan));
      mutate(changed);
      expect(() => prepareCatalogUpdate({ chains: baseline.chains }, changed, input, rawPin)).toThrow();
    }

    const downgraded = JSON.parse(JSON.stringify(plan));
    downgraded.admissions[0].executionScope = null;
    downgraded.admissions[0].executionScopeHash = null;
    downgraded.admissions[0].authorityReview.classification = 'ordinary-direct';
    expect(() => prepareCatalogUpdate({ chains: baseline.chains }, downgraded, input, rawPin)).toThrow(/exact restricted scoped admission/);

    const ordinaryScoped = JSON.parse(JSON.stringify(plan));
    ordinaryScoped.admissions[0].authorityReview.classification = 'ordinary-direct';
    expect(() => validateUpdatePlan(ordinaryScoped, `${UPDATE}/plan.json`)).toThrow(/ordinary admissions must remain scope-free/);
  });

  it('rejects source and baseline pin drift and does not change ordinary admission semantics', () => {
    const changedSource = JSON.parse(JSON.stringify(source));
    changedSource.sources[0].evidence += ' attacker-added source observation';
    expect(() => prepareCatalogUpdate({ chains: baseline.chains }, plan, [{ sourcePath, document: changedSource }], rawPin)).toThrow(/Source digest mismatch/);
    const repinnedSource = JSON.parse(JSON.stringify(changedSource));
    const repinnedPlan = JSON.parse(JSON.stringify(plan));
    repinnedPlan.sources[0].canonicalSha256 = canonicalSourceSha256(repinnedSource);
    expect(() => prepareCatalogUpdate({ chains: baseline.chains }, repinnedPlan, [{ sourcePath, document: repinnedSource }], rawPin)).toThrow(/reviewed source evidence/);
    expect(() => prepareCatalogUpdate({ chains: baseline.chains }, plan, input, '0'.repeat(64))).toThrow(/Baseline raw bytes pin mismatch/);
    const ordinary = JSON.parse(JSON.stringify(plan));
    ordinary.admissions[0].authorityReview.classification = 'ordinary-direct';
    ordinary.admissions[0].executionScope = null;
    ordinary.admissions[0].executionScopeHash = null;
    expect(() => prepareCatalogUpdate({ chains: baseline.chains }, ordinary, input, rawPin)).toThrow(/exact restricted scoped admission/);
  });
});
