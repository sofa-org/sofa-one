import { buildReviewedManifest } from './defi-manifest';
import { buildApprovalFragment } from './approvals';
import { buildDexRegistry } from './dex';
import { buildLendingRegistry } from './lending';
import { buildVaultRegistry } from './vaults';

export const PRODUCTION_DEFI_MANIFEST = buildReviewedManifest([
  buildDexRegistry(),
  buildLendingRegistry(),
  buildVaultRegistry(),
  buildApprovalFragment(),
]);
export const PRODUCTION_DEFI_CATALOG = PRODUCTION_DEFI_MANIFEST.chains;
export const PRODUCTION_DEFI_APPROVALS = Object.freeze(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'ERC-20'));
