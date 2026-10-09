import { dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { buildReviewedManifest } from '../defi-manifest';
import { validateCatalogDocument } from '../../catalog-tooling/catalog-generator';
import { validateUpdatePlan } from '../../catalog-tooling/catalog-update';
import { loadCurrentCatalogUpdate } from '../../../../../scripts/defi-catalog/update-cli-current';
import { assertUpdateRepositoryFile } from '../../../../../scripts/defi-catalog/update-cli-files';

const LEGACY_CATALOG = 'data/defi-catalog/v9/catalog.json';

/** Test-only expectations derived from the selected saved catalog, never from generated production output. */
export function loadCurrentProductionExpectations(root: string) {
  const planPath = loadCurrentCatalogUpdate(root);
  const catalogPath = planPath ? `${dirname(planPath)}/catalog.json` : LEGACY_CATALOG;
  const catalogFile = assertUpdateRepositoryFile(root, catalogPath);
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(catalogFile, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Unable to read current expected catalog: ${(error as Error).message}`);
  }
  const catalog = validateCatalogDocument(document);
  if (planPath) {
    const planFile = assertUpdateRepositoryFile(root, planPath);
    validateUpdatePlan(JSON.parse(readFileSync(planFile, 'utf8')) as unknown, planPath);
  }
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
