import { buildReviewedManifest } from './defi-manifest';
import { GENERATED_DEFI_REGISTRY } from './generated/production-catalog';

export const PRODUCTION_DEFI_MANIFEST = buildReviewedManifest([GENERATED_DEFI_REGISTRY]);
export const PRODUCTION_DEFI_CATALOG = PRODUCTION_DEFI_MANIFEST.chains;
export const PRODUCTION_DEFI_APPROVALS = Object.freeze(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) =>
  fn.type === 'contract_call' && fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)',
));
