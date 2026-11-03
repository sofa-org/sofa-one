import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildReviewedManifest } from '../defi-manifest';
import { validateCatalogDocument } from '../../catalog-tooling/catalog-generator';

/** Test expectations come from the single committed catalog input, never runtime assembly. */
export function loadCatalogExpectations(root: string) {
  const path = resolve(root, 'data/defi-catalog/catalog.json');
  const catalog = validateCatalogDocument(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  const capabilities = buildReviewedManifest([catalog]).capabilities;
  const approvals = capabilities.filter((fn) => fn.type === 'contract_call' && fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)');
  return Object.freeze({
    catalog,
    capabilities,
    definitions: capabilities.length,
    actions: capabilities.filter((fn) => fn.type === 'contract_call' && !approvals.some((approval) => approval.capabilityId === fn.capabilityId)).length,
    approvals: approvals.length,
    scopes: capabilities.filter((fn) => fn.executionScope).length,
  });
}
