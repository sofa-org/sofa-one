import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiExecutionContext, DefiFunctionPolicy } from '../defi.types';
import type { DefiRegistryFragment, ReviewedManifest } from './defi-manifest.types';

export type ReviewedApproval = Readonly<{ capabilityId:string; chainId:number; tokenRef:string; token:string; spenderRefs:readonly string[]; spenders:readonly string[]; actions:readonly string[]; status:'active'|'inactive' }>;
const address=(v:unknown):v is string=>typeof v==='string'&&/^0x[0-9a-fA-F]{40}$/.test(v);
function isFundedPolicy(fn:DefiFunctionPolicy):boolean {
  if(fn.type!=='contract_call')return false;
  return (fn.protocol==='Aave V3'&&(fn.functionName==='supply'||fn.functionName==='repay'))
    ||(fn.protocol==='Compound III'&&fn.functionName==='supply')
    ||((fn.protocol==='uniswap-v3'||fn.protocol==='pancakeswap-v3')&&fn.functionName==='exactInputSingle'&&fn.signature.startsWith('exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))'))
    ||(fn.protocol==='Morpho Vault V2'&&fn.functionName==='deposit');
}
/** Exact finite ERC-20 approval authorities derived only from the fixed funded-action allowlist. */
export function buildApprovalRegistry(manifest:ReviewedManifest, eligibleActionIds?:readonly string[]):readonly ReviewedApproval[] {
  const assets=new Map(manifest.assets.map(a=>[a.ref,a]));const deployments=new Map(manifest.deployments.map(d=>[d.ref,d]));
  const pools=new Map(manifest.pools.map(p=>[p.ref,p]));
  const refs=new Map<string,{asset:NonNullable<ReturnType<typeof assets.get>>;spenders:Set<string>;actions:Set<string>}>();
  for(const fn of manifest.capabilities){if(!isFundedPolicy(fn)||(eligibleActionIds&&!eligibleActionIds.includes(fn.capabilityId)))continue;
    const spenderRef=(fn.manifestRefs?.deployments??[]).find(ref=>deployments.get(ref)?.chainId===fn.chainId&&deployments.get(ref)?.address.toLowerCase()===fn.contract.toLowerCase());
    if(!spenderRef)continue;
    const tokenRefs=fn.protocol==='uniswap-v3'||fn.protocol==='pancakeswap-v3'
      ?(fn.manifestRefs?.pools??[]).map(ref=>pools.get(ref)?.tokenInRef).filter((ref):ref is string=>!!ref)
      :(fn.manifestRefs?.assets??[]).filter(ref=>assets.get(ref)?.chainId===fn.chainId);
    // Lending/vault contracts bind assets in their fixed ABI; the router parser enforces the concrete pair.
    for(const tokenRef of tokenRefs){const asset=assets.get(tokenRef)!;const key=`${fn.chainId}:${asset.address.toLowerCase()}`;let row=refs.get(key);if(!row){row={asset,spenders:new Set(),actions:new Set()};refs.set(key,row);}row.spenders.add(spenderRef);row.actions.add(fn.capabilityId);}
  }
  const result:ReviewedApproval[]= [...refs.values()].map(({asset,spenders,actions})=>{
    const spenderRefs=[...spenders].sort();const spenderAddresses=spenderRefs.map(ref=>deployments.get(ref)!.address);
    const active=manifest.capabilities.some(fn=>actions.has(fn.capabilityId)&&fn.status==='active');
    return Object.freeze({capabilityId:`erc20:${asset.chainId}:${asset.address.toLowerCase()}:approve`,chainId:asset.chainId,tokenRef:asset.ref,token:asset.address,spenderRefs:Object.freeze(spenderRefs),spenders:Object.freeze(spenderAddresses),status:active?'active' as const:'inactive' as const,actions:Object.freeze([...actions].sort())} as ReviewedApproval);
  }).sort((a,b)=>a.chainId-b.chainId||a.token.toLowerCase().localeCompare(b.token.toLowerCase()));
  return Object.freeze(result);
}

export function buildApprovalFragment(manifest:ReviewedManifest, eligibleActionIds?:readonly string[]):DefiRegistryFragment {
 const approvals=buildApprovalRegistry(manifest,eligibleActionIds);const deployments=new Map(manifest.deployments.map(d=>[d.ref,d]));const assets=new Map(manifest.assets.map(a=>[a.ref,a]));
 const policies:DefiFunctionPolicy[]=approvals.map(row=>{const asset=assets.get(row.tokenRef)!;const tokenDeployment=deployments.get(asset.deploymentRef)!;const abi:AbiFunction={type:'function',name:'approve',stateMutability:'nonpayable',inputs:[{name:'spender',type:'address'},{name:'amount',type:'uint256'}],outputs:[{name:'',type:'bool'}]};
   const validate=(args:readonly unknown[],ctx:DefiExecutionContext)=>args.length===2&&ctx.chainId===row.chainId&&address(args[0])&&row.spenders.some(s=>s.toLowerCase()===String(args[0]).toLowerCase())&&typeof args[1]==='bigint'&&(args[1] as bigint)>=0n&&(args[1] as bigint)<=asset.maxOperationRaw;
    const actions=manifest.capabilities.filter(candidate=>row.actions.includes(candidate.capabilityId));
    const refs={assets:[...new Set([asset.ref,...actions.flatMap(candidate=>candidate.manifestRefs?.assets??[])])],deployments:[...new Set([asset.deploymentRef,...row.spenderRefs,...actions.flatMap(candidate=>candidate.manifestRefs?.deployments??[])])],priceFeeds:[...new Set(actions.flatMap(candidate=>candidate.manifestRefs?.priceFeeds??[]))],pools:[...new Set(actions.flatMap(candidate=>candidate.manifestRefs?.pools??[]))]};
    return {capabilityId:row.capabilityId,type:'contract_call',chainId:row.chainId,contract:row.token,functionName:'approve',signature:'approve(address,uint256)',abi,policy:{ref:'erc20-exact-spender-finite-approval',version:1},status:row.status,protocol:'ERC-20',operation:'approve',label:`Approve reviewed DeFi spender for ${asset.symbol}`,description:'Zero reset or exact finite amount only; batch policy pairs positive approval with its funded action and zero cleanup.',inactiveReason:row.status==='active'?undefined:'Inactive until a matching funded action has accepted source identity and execution proof.',dependencies:[...row.actions],manifestRefs:refs,approval:{tokenRef:asset.ref,spenderRefs:row.spenderRefs},validate,describe:(args,_ctx,index)=>{if(!validate(args,_ctx))throw new Error('Invalid ERC-20 approval');return {kind:'approval',index,token:row.token,spender:String(args[0]),amount:args[1] as bigint};}};
 });
 const chains:DefiChainPolicy[]=[...new Set(policies.map(p=>p.chainId))].sort((a,b)=>a-b).map(chainId=>({chainId,status:'inactive',contracts:[...new Set(policies.filter(p=>p.chainId===chainId).map(p=>p.contract))].map(contract=>({address:contract,status:'inactive',functions:policies.filter(p=>p.chainId===chainId&&p.contract.toLowerCase()===contract.toLowerCase())}))}));
  const activationEvidence=policies.filter(fn=>fn.status==='active').flatMap(fn=>fn.dependencies!.flatMap(actionId=>manifest.activationEvidence.filter(e=>e.capabilityId===actionId).map(e=>({capabilityId:fn.capabilityId,executionProofRef:e.executionProofRef,sourceIdentityRef:e.sourceIdentityRef}))));
  return {chains,assets:[],deployments:[],priceFeeds:[],pools:[],activationEvidence};
}
