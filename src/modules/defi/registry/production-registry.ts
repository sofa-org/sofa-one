import { buildReviewedManifest } from './defi-manifest';
import { buildApprovalFragment } from './approvals';
import { buildDexRegistry, buildProspectiveEthereumUsdcWeth500Dex } from './dex';
import { buildLendingRegistry } from './lending';
import { buildVaultRegistry } from './vaults';
import type { ReviewedDeployment } from './defi-manifest.types';

const families = Object.freeze([buildDexRegistry(), buildLendingRegistry(), buildVaultRegistry()]);
/** Narrow prospective assembly; activation is deliberately exact and remains subject to final Oracle approval. */
export function buildProspectiveEthereumUsdcWeth500(options: { activate?: boolean; dependencyOverrides?: readonly ReviewedDeployment[] } = {}) {
  const prospectiveDex = buildProspectiveEthereumUsdcWeth500Dex(!!options.activate,options.dependencyOverrides);
  const replacements=new Set(['token:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','token:1:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']);
  const preserveOtherCandidates=(fragment:ReturnType<typeof buildLendingRegistry>)=>({...fragment,assets:fragment.assets.filter(a=>!replacements.has(a.deploymentRef)),deployments:fragment.deployments.filter(d=>!replacements.has(d.ref))});
  const fragments = [prospectiveDex, preserveOtherCandidates(buildLendingRegistry()), preserveOtherCandidates(buildVaultRegistry())];
  const actionManifest = buildReviewedManifest(fragments);
  const action = actionManifest.capabilities.find(fn=>fn.chainId===1&&fn.protocol==='uniswap-v3'&&fn.contract.toLowerCase()==='0xe592427a0aece92de3edee1f18e0157c05861564')!;
  if(options.activate){
    const required=action.manifestRefs?.deployments??[];
    const absent=required.filter(ref=>{const d=actionManifest.deployments.find(row=>row.ref===ref);return !d||d.status!=='verified'||!d.abiHash||!d.abi||!d.runtimeCodeHash||!d.verificationRef||!d.identityChecks.length;});
    if(absent.length)throw new Error(`Activation unavailable: incomplete verified dependency closure: ${absent.join(', ')}`);
    const expected=new Map<string,readonly [string,string]>([
      ['dex:uniswap-v3:1:0xe592427a0aece92de3edee1f18e0157c05861564',['0xe592427a0aece92de3edee1f18e0157c05861564','0xbb90113d2f9a5e9b7feb15a1d1fff06c1ee1575b3f9b1181778ffd0cf633e7ea']],
      ['token:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','0xd80d4b7c890cb9d6a4893e6b52bc34b56b25335cb13716e0d1d31383e6b41505']],
      ['token:1:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2','0xd0a06b12ac47863b5c7be4185c2deaad1c61557033f56c7d4ea74429cbb25e23']],
      ['factory:uniswap-v3:1:0x1f98431c8ad98523631ae4a59f267346ea31f984',['0x1f98431c8ad98523631ae4a59f267346ea31f984','0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69']],
      ['pool-deployment:1:0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',['0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640','0xa981b66c747a3d9fa29d7e200d5faaa2826960523d0e5a0df8148e8868c480b4']],
      ['feed-proxy:1:0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419',['0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419','0x4b79b5c8aee6da0f7b393e8b53e6265ef7320a1d16184c65bd3841b5aa3d700d']],
      ['feed-aggregator:1:0x7d4e742018fb52e48b08be73d041c18b21de6fb5',['0x7d4e742018fb52e48b08be73d041c18b21de6fb5','0x16f41184f797cb8f8918680df0ebf2a97cc3192aa6b104615f61096fc674f2aa']],
      ['feed-proxy:1:0x8fffffd4afb6115b954bd326cbe7b4ba576818f6',['0x8fffffd4afb6115b954bd326cbe7b4ba576818f6','0xbd6f524cdc4268b6bd1bb6f77a8821faeea9c52ee9e0afa0b6d948ce82c966c2']],
      ['feed-aggregator:1:0x54bcc589d9743e521c64233706fc8cb36d275b07',['0x54bcc589d9743e521c64233706fc8cb36d275b07','0xec635dff6a4204a0de141a9a6728b9c84995894680d703e44ac0057ffb38c412']],
      ['token-implementation:1:0x43506849d7c04f9138d1a2050bbf3a0c054402dd',['0x43506849d7c04f9138d1a2050bbf3a0c054402dd','0xcdfb7d322961af3acae7a8f7ee8b69c205b36f576cc5b077f170c7eb8ecbe3ea']],
    ]);
    const selected=actionManifest.deployments.filter(d=>expected.has(d.ref));
    const drift=selected.filter(d=>{const pin=expected.get(d.ref)!;return d.status!=='verified'||d.address.toLowerCase()!==pin[0]||d.runtimeCodeHash?.toLowerCase()!==pin[1]||!d.verificationRef?.includes('26102396')&&!d.verificationRef?.includes('Sourcify')||!d.abiHash||!d.identityChecks.length;});
    if(selected.length!==expected.size||drift.length)throw new Error(`Activation unavailable: source/RPC pin drift in ${drift.map(d=>d.ref).join(', ')||'dependency set'}`);
    const factory=selected.find(d=>d.ref.startsWith('factory:'))!;
    if(factory.identityChecks.filter(c=>c.getter==='getPool(address,address,uint24)').length!==2||factory.identityChecks.some(c=>c.getter==='WETH9()'))throw new Error('Activation unavailable: invalid factory getPool identity closure');
    const expectedPool='0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640',usdc='0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',weth='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
    const relations=factory.identityChecks.filter(c=>c.getter==='getPool(address,address,uint24)');
    const relationKeys=relations.map(c=>`${String(c.args?.[0]).toLowerCase()}:${String(c.args?.[1]).toLowerCase()}:${String(c.args?.[2])}:${c.expected.toLowerCase()}`).sort();
    if(relationKeys.join('|')!==[`${usdc}:${weth}:500:${expectedPool}`,`${weth}:${usdc}:500:${expectedPool}`].sort().join('|'))throw new Error('Activation unavailable: factory pool relation drift');
    const usdcProxy=selected.find(d=>d.ref==='token:1:'+usdc)!;
    if(usdcProxy.proxy?.kind!=='zeppelinos'||usdcProxy.proxy.implementation.toLowerCase()!=='0x43506849d7c04f9138d1a2050bbf3a0c054402dd'||usdcProxy.proxy.implementationCodeHash?.toLowerCase()!=='0xcdfb7d322961af3acae7a8f7ee8b69c205b36f576cc5b077f170c7eb8ecbe3ea')throw new Error('Activation unavailable: USDC ZeppelinOS implementation pin drift');
  }
  // Keep the complete approval inventory, but derive the active two approvals from only the
  // selected action so their active dependency closure cannot inherit unrelated candidate spenders.
  const completeApprovals=buildApprovalFragment(actionManifest);
  const selectedApprovals=buildApprovalFragment(actionManifest,[action.capabilityId]);
  const selectedApprovalPolicies=new Map(selectedApprovals.chains.flatMap(chain=>chain.contracts.flatMap(contract=>contract.functions.map(fn=>[fn.capabilityId,fn] as const))));
  const approvalFragment={...completeApprovals,chains:completeApprovals.chains.map(chain=>({...chain,contracts:chain.contracts.map(contract=>({...contract,functions:contract.functions.map(fn=>selectedApprovalPolicies.get(fn.capabilityId)??fn)}))})),activationEvidence:selectedApprovals.activationEvidence};
  return buildReviewedManifest([...fragments,approvalFragment]);
}

/** Narrow ETH USDC/WETH fee-500 assembly selected for production pending final Oracle review. */
export const PRODUCTION_DEFI_MANIFEST = buildProspectiveEthereumUsdcWeth500({ activate: true });
export const PRODUCTION_DEFI_CATALOG = PRODUCTION_DEFI_MANIFEST.chains;
export const PRODUCTION_DEFI_APPROVALS = Object.freeze(PRODUCTION_DEFI_MANIFEST.capabilities.filter(fn => fn.protocol === 'ERC-20'));
export const PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS = Object.freeze([
  'uniswap-v3:v3:1:0xe592427a0aece92de3edee1f18e0157c05861564:exact-input-single',
  'erc20:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:approve',
  'erc20:1:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2:approve',
]);
export const PROSPECTIVE_ETH_USDC_WETH_500_GAP = Object.freeze([
  'Existing fork evidence covers local-root Calibur atomic swap/rollback semantics only; it does not establish production Openfort/EntryPoint/bundler UserOperation success.',
]);
