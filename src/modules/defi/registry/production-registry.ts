import { buildReviewedManifest } from './defi-manifest';
import { buildApprovalFragment } from './approvals';
import { buildDexRegistry } from './dex';
import { buildLendingRegistry } from './lending';
import { buildVaultRegistry } from './vaults';
import { buildClassicDexRegistry } from './classic-dex';
import { buildStakingRegistry } from './staking';
import { buildMorphoBlueRegistry } from './morpho-blue';
import { buildPancakeV2Registry } from './pancake-v2';
import { buildStakingExitRegistry } from './staking-exit';
import { buildSparkLendRegistry } from './spark-lend';
import { buildVenusRegistry } from './venus';
import { buildSushiV2Registry } from './sushi-v2';
import { buildExpansionTokenApprovalRegistry } from './expansion-token-approvals';

export const PRODUCTION_DEFI_MANIFEST = buildReviewedManifest([
  buildDexRegistry(),
  buildLendingRegistry(),
  buildVaultRegistry(),
  buildClassicDexRegistry(),
  buildStakingRegistry(),
  buildStakingExitRegistry(),
  buildMorphoBlueRegistry(),
  buildPancakeV2Registry(),
  buildApprovalFragment(),
  buildSparkLendRegistry(),
  buildVenusRegistry(),
  buildSushiV2Registry(),
  buildExpansionTokenApprovalRegistry(),
]);
export const PRODUCTION_DEFI_CATALOG = PRODUCTION_DEFI_MANIFEST.chains;
export const PRODUCTION_DEFI_APPROVALS = Object.freeze(PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) =>
  fn.type === 'contract_call' && fn.functionName === 'approve' && fn.signature === 'approve(address,uint256)',
));
