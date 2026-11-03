import { buildReviewedManifest } from '../defi-manifest';
import { PRODUCTION_DEFI_MANIFEST } from '../production-registry';

/** Build a manifest fixture without selected capabilities or the scoped pUSD route. */
export function manifestWithoutCapabilities(capabilityIds: readonly string[]) {
  const excluded = new Set([...capabilityIds, 'polymarket-pusd:v1:137:0x93070a847efef7f70739046a929d47a521f5b8ee:wrap']);
  const chains = PRODUCTION_DEFI_MANIFEST.chains.map((chain) => ({
    ...chain,
    contracts: chain.contracts.map((contract) => ({
      ...contract,
      functions: contract.functions.filter((fn) => !excluded.has(fn.capabilityId)),
    })).filter((contract) => contract.functions.length > 0),
  })).filter((chain) => chain.contracts.length > 0);
  return buildReviewedManifest([{ chains }]);
}
