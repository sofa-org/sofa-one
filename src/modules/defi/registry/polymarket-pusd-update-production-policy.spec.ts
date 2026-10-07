import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { executionScopeHash } from '../execution/scope';
import { POLYMARKET_PUSD_WRAP_IDENTITY, POLYMARKET_PUSD_WRAP_SCOPE } from '../execution/pusd-identity';
import { assembleCatalogUpdate, prepareCatalogUpdate, validateUpdatePlan } from '../catalog-tooling/catalog-update';
import { canonicalSourceSha256, validateCatalogDocument } from '../catalog-tooling/catalog-generator';
import { buildReviewedManifest } from './defi-manifest';
import { PRODUCTION_DEFI_MANIFEST } from './production-registry';
import { PRODUCTION_DEFI_CAPABILITY_BUNDLES } from '../bundles/production-bundles';

const ROOT = 'data/defi-catalog/updates/polymarket-pusd';
const PLAN_PATH = `${ROOT}/plan.json`;
const SOURCE_PATH = `${ROOT}/sources/polymarket-pusd.json`;
const BASELINE_PATH = 'data/defi-catalog/updates/origin-wousd/catalog.json';
const readJson = (path: string) => JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as any;
const rawBaseline = readFileSync(resolve(process.cwd(), BASELINE_PATH));
const baselineDoc = validateCatalogDocument(JSON.parse(rawBaseline.toString('utf8')));
const baseline = { chains: baselineDoc.chains };
const sourceDoc = readJson(SOURCE_PATH);
const plan = readJson(PLAN_PATH);
const inputs = [{ sourcePath: SOURCE_PATH, document: sourceDoc }];
const prepared = () => prepareCatalogUpdate(baseline, plan, inputs, createHash('sha256').update(rawBaseline).digest('hex'));

describe('Polymarket pUSD restricted catalog admission', () => {
  it('requires exact pinned action, ABI, and non-downgradable closed scope', () => {
    const validated = validateUpdatePlan(plan, PLAN_PATH);
    expect(validated.admissions).toHaveLength(1);
    expect(validated.admissions[0]).toMatchObject({
      familyId: 'polymarket-pusd', familyVersion: 'collateral-onramp@27700089',
      chainId: POLYMARKET_PUSD_WRAP_IDENTITY.chainId, contract: POLYMARKET_PUSD_WRAP_IDENTITY.contract,
      signature: POLYMARKET_PUSD_WRAP_IDENTITY.signature, selector: '0x62355638',
      abiHash: POLYMARKET_PUSD_WRAP_IDENTITY.abiHash, capabilityId: POLYMARKET_PUSD_WRAP_IDENTITY.capabilityId,
      executionScope: POLYMARKET_PUSD_WRAP_SCOPE, executionScopeHash: executionScopeHash(POLYMARKET_PUSD_WRAP_SCOPE),
      authorityReview: { classification: 'polymarket-pusd-restricted' },
    });

    const weakened = JSON.parse(JSON.stringify(plan));
    weakened.admissions[0].executionScope = null;
    weakened.admissions[0].executionScopeHash = null;
    weakened.admissions[0].authorityReview.classification = 'ordinary-direct';
    expect(() => prepareCatalogUpdate(baseline, weakened, inputs, createHash('sha256').update(rawBaseline).digest('hex'))).toThrow(/requires its exact restricted scoped admission/);

    const wrongScope = JSON.parse(JSON.stringify(plan));
    wrongScope.admissions[0].executionScope.asset = '0x0000000000000000000000000000000000000001';
    expect(() => validateUpdatePlan(wrongScope, PLAN_PATH)).toThrow(/Invalid DeFi execution scope/);
    const missingHash = JSON.parse(JSON.stringify(plan));
    missingHash.admissions[0].executionScopeHash = null;
    expect(() => validateUpdatePlan(missingHash, PLAN_PATH)).toThrow(/mandatory scope/);
  });

  it('fails closed for wrong target, chain, selector, ABI, capability, source digest, and signature', () => {
    const changes: Array<(p: any) => void> = [
      (p) => { p.admissions[0].contract = '0x1111111111111111111111111111111111111111'; },
      (p) => { p.admissions[0].chainId = 1; },
      (p) => { p.admissions[0].selector = '0x3d0a2f5e'; },
      (p) => { p.admissions[0].abiHash = `0x${'00'.repeat(32)}`; },
      (p) => { p.admissions[0].capabilityId = 'polymarket-pusd:other'; },
      (p) => { p.admissions[0].signature = 'unwrap(address,address,uint256)'; },
      (p) => { p.sources[0].canonicalSha256 = '0'.repeat(64); },
    ];
    for (const mutate of changes) {
      const changed = JSON.parse(JSON.stringify(plan));
      mutate(changed);
      expect(() => prepareCatalogUpdate(baseline, changed, inputs, createHash('sha256').update(rawBaseline).digest('hex'))).toThrow();
    }
  });

  it('builds deterministically over the exact baseline, adding only the scoped wrap action', () => {
    const projection = prepared().projectedCatalog;
    const first = assembleCatalogUpdate(baseline, plan, inputs, createHash('sha256').update(rawBaseline).digest('hex'));
    const second = assembleCatalogUpdate(baseline, plan, inputs, createHash('sha256').update(rawBaseline).digest('hex'));
    const saved = validateCatalogDocument(readJson(`${ROOT}/catalog.json`));
    expect(first).toEqual(second);
    expect(first).toEqual(saved);
    const oldManifest = buildReviewedManifest([baselineDoc]);
    const newManifest = buildReviewedManifest([saved]);
    expect(oldManifest.capabilities).toHaveLength(747);
    expect(newManifest.capabilities).toHaveLength(748);
    expect(PRODUCTION_DEFI_MANIFEST.capabilities).toHaveLength(748);
    const newIds = newManifest.capabilities.filter((fn) => !oldManifest.capabilities.some((old) => old.capabilityId === fn.capabilityId));
    expect(newIds).toHaveLength(1);
    expect(newIds[0]).toMatchObject({ capabilityId: POLYMARKET_PUSD_WRAP_IDENTITY.capabilityId, signature: POLYMARKET_PUSD_WRAP_IDENTITY.signature, executionScope: POLYMARKET_PUSD_WRAP_SCOPE });
    expect(newIds.map((fn) => fn.functionName)).toEqual(['wrap']);
    expect(newManifest.capabilities.filter((fn) => fn.operation === 'approve')).toHaveLength(oldManifest.capabilities.filter((fn) => fn.operation === 'approve').length);
    expect(newManifest.capabilities.filter((fn) => fn.executionScope)).toHaveLength(oldManifest.capabilities.filter((fn) => fn.executionScope).length + 1);
    expect(PRODUCTION_DEFI_CAPABILITY_BUNDLES).toHaveLength(69);
    const profileIds = PRODUCTION_DEFI_CAPABILITY_BUNDLES.flatMap((bundle) => bundle.capabilityIds);
    expect(new Set(profileIds).size).toBe(399);
    expect(profileIds).not.toContain(POLYMARKET_PUSD_WRAP_IDENTITY.capabilityId);
    expect(sourceDoc.families[0].contracts[0].abiFunctions.map((fn: any) => fn.name)).toEqual(['wrap']);
    expect(prepared().candidates).toEqual(expect.arrayContaining([expect.objectContaining({ admitted: true, fn: expect.objectContaining({ status: 'inactive' }) })]));
    expect(prepared().projectedDiff.added).toEqual([POLYMARKET_PUSD_WRAP_IDENTITY.capabilityId]);
    expect(projection.chains).toEqual(first.chains);
    for (const old of oldManifest.capabilities) expect(newManifest.capabilities.find((fn) => fn.capabilityId === old.capabilityId)).toEqual(old);
    for (const currentFunction of PRODUCTION_DEFI_MANIFEST.capabilities) {
      expect(newManifest.capabilities.find((fn) => fn.capabilityId === currentFunction.capabilityId)).toEqual(currentFunction);
    }
    const productionWrap = PRODUCTION_DEFI_MANIFEST.capabilities.find((fn) => fn.capabilityId === POLYMARKET_PUSD_WRAP_IDENTITY.capabilityId);
    expect(productionWrap).toMatchObject({
      status: 'active', provenance: { status: 'verified' }, executionScope: POLYMARKET_PUSD_WRAP_SCOPE,
      capabilityId: POLYMARKET_PUSD_WRAP_IDENTITY.capabilityId, chainId: 137,
      contract: POLYMARKET_PUSD_WRAP_IDENTITY.contract, signature: POLYMARKET_PUSD_WRAP_IDENTITY.signature,
      abiHash: POLYMARKET_PUSD_WRAP_IDENTITY.abiHash,
    });
    expect(canonicalSourceSha256(sourceDoc)).toBe(plan.sources[0].canonicalSha256);
    const current = readJson('data/defi-catalog/updates/current.json');
    expect(current.planPath).toBe(PLAN_PATH);
    expect(createHash('sha256').update(readFileSync(resolve(process.cwd(), PLAN_PATH))).digest('hex')).toBe(current.planRawSha256);
  });
});
