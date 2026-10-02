import { isAddress, keccak256, stringToHex, toFunctionSelector } from 'viem';
import type { DefiChainPolicy, DefiFunctionPolicy } from '../defi.types';
import type { DefiRegistryFragment, ReviewedDeployment, ReviewedManifest } from './defi-manifest.types';

export const DEFI_MANIFEST = Symbol('DEFI_MANIFEST');
/** Fixed ZeppelinOS implementation slot used by the source-verified Ethereum FiatTokenProxy pattern. */
export const REVIEWED_ZEPPELINOS_IMPLEMENTATION_SLOT = keccak256(stringToHex('org.zeppelinos.proxy.implementation'));
const EMPTY: DefiRegistryFragment = Object.freeze({ chains: Object.freeze([]), assets: Object.freeze([]), deployments: Object.freeze([]), priceFeeds: Object.freeze([]), pools: Object.freeze([]), activationEvidence: Object.freeze([]) });
const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
function canonical(value: unknown): string {
  if (typeof value === 'bigint') return `{"$bigint":${JSON.stringify(value.toString())}}`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>cmp(a,b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
/** ABI digest: Keccak-256(JSON.stringify(recursively key-sorted ABI JSON)); array order is retained. */
export function reviewedAbiHash(abi: readonly unknown[]): `0x${string}` { return keccak256(stringToHex(canonical(abi))) as `0x${string}`; }
function validIdentityCheck(check: ReviewedDeployment['identityChecks'][number]): boolean {
  const addressGetters=['factory()','WETH9()','token0()','token1()','aggregator()'];
  const uintGetters=['decimals()','fee()'];
  if(addressGetters.includes(check.getter)) return check.args===undefined&&isAddress(check.expected,{strict:false});
  if(uintGetters.includes(check.getter)) return check.args===undefined&&/^(0|[1-9]\d*)$/.test(check.expected);
  if(check.getter==='symbol()') return check.args===undefined&&typeof check.expected==='string'&&check.expected.length>0;
  if(check.getter!=='getPool(address,address,uint24)'||!Array.isArray(check.args)||check.args.length!==3) return false;
  const [a,b,fee]=check.args;
  return typeof a==='string'&&isAddress(a,{strict:false})&&typeof b==='string'&&isAddress(b,{strict:false})&&typeof fee==='number'&&Number.isInteger(fee)&&fee>=0&&fee<2**24&&isAddress(check.expected,{strict:false});
}
function functionIdentity(fn:DefiFunctionPolicy):string{return canonical({capabilityId:fn.capabilityId,type:fn.type,chainId:fn.chainId,contract:fn.contract,functionName:fn.functionName,signature:fn.signature,abi:fn.abi,policy:fn.policy,status:fn.status,protocol:fn.protocol,operation:fn.operation,inactiveReason:fn.inactiveReason,manifestRefs:fn.manifestRefs,dependencies:fn.dependencies,approval:fn.approval});}
const clone=<T>(v:T):T=>Array.isArray(v)?v.map(clone) as T:v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,clone(x)])) as T:v;
const freeze=<T>(v:T):T=>{ if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.freeze(v);Object.values(v as object).forEach(freeze);}return v; };
function mergeRecords<T extends {ref:string}>(lists: readonly (readonly T[])[]): T[] {
  const map=new Map<string,T>();
  for(const row of lists.flat()) { const prev=map.get(row.ref); if(!prev){map.set(row.ref,clone(row));continue;}
    for(const [k,v] of Object.entries(row)) { const old=(prev as Record<string,unknown>)[k]; if(old===undefined){(prev as Record<string,unknown>)[k]=clone(v);continue;} if(canonical(old)!==canonical(v)){if(row.ref.startsWith('asset:')&&k==='maxOperationRaw'&&typeof old==='bigint'&&typeof v==='bigint'){(prev as Record<string,unknown>)[k]=old<v?old:v;continue;}throw new Error(`Conflicting reviewed manifest ref: ${row.ref}`);} }
  }
  return [...map.values()].sort((a,b)=>cmp(a.ref,b.ref));
}
export function buildReviewedManifest(fragments: readonly DefiRegistryFragment[] = [EMPTY]): ReviewedManifest {
  const assets=mergeRecords(fragments.map(f=>f.assets)), deployments=mergeRecords(fragments.map(f=>f.deployments)), priceFeeds=mergeRecords(fragments.map(f=>f.priceFeeds)), pools=mergeRecords(fragments.map(f=>f.pools));
  const markets=mergeRecords(fragments.map(f=>('markets' in f ? (f as DefiRegistryFragment & {markets: readonly import('./defi-manifest.types').ReviewedMarket[]}).markets : []) ?? []));
  const chainsMap=new Map<number,{chainId:number;status:'active'|'inactive';contracts:Map<string,{address:string;status:'active'|'inactive';functions:DefiFunctionPolicy[]}>}>();
  for(const f of fragments) for(const ch of f.chains){let dst=chainsMap.get(ch.chainId);if(!dst){dst={chainId:ch.chainId,status:'inactive',contracts:new Map()};chainsMap.set(ch.chainId,dst);}
    for(const ct of ch.contracts){const addr=ct.address.toLowerCase();let dct=dst.contracts.get(addr);if(!dct){dct={address:ct.address,status:'inactive',functions:[]};dst.contracts.set(addr,dct);}
      for(const fn of ct.functions){const duplicate=dct.functions.find(x=>toFunctionSelector(x.signature).toLowerCase()===toFunctionSelector(fn.signature).toLowerCase());if(duplicate){if(functionIdentity(duplicate)!==functionIdentity(fn))throw new Error('Ambiguous DeFi selector within merged contract');continue;}dct.functions.push(clone(fn));}
    }
  }
  const chains:DefiChainPolicy[]=[...chainsMap.values()].sort((a,b)=>a.chainId-b.chainId).map(c=>{const contracts=[...c.contracts.values()].sort((a,b)=>cmp(a.address.toLowerCase(),b.address.toLowerCase())).map(k=>{const functions=k.functions.sort((a,b)=>cmp(a.capabilityId,b.capabilityId));return {...k,functions,status:functions.some(fn=>fn.status==='active')?'active' as const:'inactive' as const};});return {chainId:c.chainId,status:contracts.some(k=>k.status==='active')?'active' as const:'inactive' as const,contracts};});
  const capabilities=chains.flatMap(c=>c.contracts.flatMap(k=>k.functions));
  const evidence=fragments.flatMap(f=>f.activationEvidence);
  const assetRefs=new Set(assets.map(a=>a.ref)), deploymentRefs=new Set(deployments.map(d=>d.ref)), feedRefs=new Set(priceFeeds.map(p=>p.ref)), poolRefs=new Set(pools.map(p=>p.ref));
  for(const a of assets){if(!/^asset:\d+:0x[0-9a-f]{40}$/.test(a.ref)||!Number.isSafeInteger(a.chainId)||!isAddress(a.address,{strict:false})||a.ref!==`asset:${a.chainId}:${a.address.toLowerCase()}`||!Number.isInteger(a.decimals)||a.decimals<0||a.decimals>36||a.maxOperationRaw<=0n||!deploymentRefs.has(a.deploymentRef))throw new Error('Invalid reviewed asset');}
  const deploymentAddresses=new Set<string>();
  for(const d of deployments) {
    const key=`${d.chainId}:${d.address.toLowerCase()}`;
    const proxy=d.proxy;
    const proxyKindValid=!proxy||proxy.kind==='eip1967'||proxy.kind==='beacon'||proxy.kind==='zeppelinos';
    const proxyAddressesValid=!proxy||(isAddress(proxy.implementation,{strict:false})&&(!proxy.beacon||isAddress(proxy.beacon,{strict:false}))&&(proxy.kind!=='beacon'||!!proxy.beacon));
    const implHashValid=!proxy?.implementationCodeHash||/^0x[0-9a-f]{64}$/i.test(proxy.implementationCodeHash);
    const verifiedProxyComplete=d.status==='candidate'||!proxy||!!proxy.implementationCodeHash;
    const identityValid=Array.isArray(d.identityChecks)&&(d.status==='candidate'||d.identityChecks.every(validIdentityCheck));
    const abiValid=!!d.abi&&!!d.abiHash&&reviewedAbiHash(d.abi)===d.abiHash;
    if(!Number.isSafeInteger(d.chainId)||!isAddress(d.address,{strict:false})||deploymentAddresses.has(key)||!proxyKindValid||!proxyAddressesValid||!implHashValid||!verifiedProxyComplete||!identityValid||(d.status!=='candidate'&&(!abiValid||!d.runtimeCodeHash||!/^0x[0-9a-f]{64}$/i.test(d.runtimeCodeHash)||!d.verificationRef?.trim()||!d.sourceRef?.trim()||d.identityChecks.length===0))) throw new Error('Invalid reviewed deployment');
    deploymentAddresses.add(key);
  }
  for(const p of priceFeeds) if(!deploymentRefs.has(p.deploymentRef)||!assetRefs.has(p.asset)||!Number.isSafeInteger(p.maxAgeSeconds)||p.maxAgeSeconds<=0) throw new Error('Invalid reviewed price feed');
  for(const fn of capabilities) {
    const refs=fn.manifestRefs;
    for(const r of refs?.assets??[])if(!assetRefs.has(r))throw new Error(`Unknown asset ref ${r}`);
    for(const r of refs?.deployments??[])if(!deploymentRefs.has(r))throw new Error(`Unknown deployment ref ${r}`);
    for(const r of refs?.priceFeeds??[])if(!feedRefs.has(r))throw new Error(`Unknown feed ref ${r}`);
    for(const r of refs?.pools??[])if(!poolRefs.has(r))throw new Error(`Unknown pool ref ${r}`);
    if(fn.status==='active'){const ev=evidence.find(e=>e.capabilityId===fn.capabilityId);if(!ev?.executionProofRef?.trim()||!ev.sourceIdentityRef?.trim()||!refs?.deployments?.length||[...(refs.assets??[]),...(refs.deployments??[]),...(refs.priceFeeds??[]),...(refs.pools??[])].some(r=>!r))throw new Error('Active DeFi capability lacks activation evidence or manifest dependencies');
      if((refs.deployments??[]).some(r=>{const d=deployments.find(x=>x.ref===r);return !d||d.status==='candidate'||!d.abiHash||!d.runtimeCodeHash||!d.verificationRef;}))throw new Error('Active DeFi capability references unverified deployment');
    }
  }
  const policyData=capabilities.map(fn=>({capabilityId:fn.capabilityId,type:fn.type,chainId:fn.chainId,contract:fn.contract,functionName:fn.functionName,signature:fn.signature,abi:fn.abi,policy:fn.policy,status:fn.status,protocol:fn.protocol,operation:fn.operation,inactiveReason:fn.inactiveReason,manifestRefs:fn.manifestRefs,dependencies:fn.dependencies,approval:fn.approval}));
   const body={assets,deployments,priceFeeds,pools,markets,capabilities,chains,activationEvidence:evidence};
  const activationData=evidence.map(e=>({capabilityId:e.capabilityId,executionProofRef:e.executionProofRef,sourceIdentityRef:e.sourceIdentityRef})).sort((a,b)=>cmp(a.capabilityId,b.capabilityId));
  const manifestHash=keccak256(stringToHex(canonical({assets,deployments,priceFeeds,pools,markets,policyData,activationData})));
  return freeze(clone({...body,manifestHash}));
}
