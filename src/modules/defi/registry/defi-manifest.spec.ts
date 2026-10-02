import { parseAbi } from 'viem';
import { buildReviewedManifest, REVIEWED_ZEPPELINOS_IMPLEMENTATION_SLOT, reviewedAbiHash } from './defi-manifest';
import type { DefiRegistryFragment } from './defi-manifest.types';
const fn=(capabilityId:string)=>({capabilityId,type:'contract_call' as const,chainId:1,contract:'0x0000000000000000000000000000000000000001',functionName:'x',signature:'x()',abi:parseAbi(['function x()'])[0],policy:{ref:'p',version:1},status:'inactive' as const,validate:()=>true,describe:()=>({kind:'action' as const,index:0,operation:'supply' as const,deploymentRef:'d',token:'0x0000000000000000000000000000000000000002',amount:1n})});
const fragment=(capabilityId:string):DefiRegistryFragment=>({chains:[{chainId:1,status:'inactive',contracts:[{address:'0x0000000000000000000000000000000000000001',status:'inactive',functions:[fn(capabilityId)]}]}],assets:[],deployments:[],priceFeeds:[],pools:[],activationEvidence:[]});
describe('reviewed manifest assembler',()=>{
 it('hashes stable explicit policy data, merges family chains, and clones/freezes inputs',()=>{const a=fragment('a'),b=fragment('b');const different={...b,chains:[{...b.chains[0],contracts:[{...b.chains[0].contracts[0],address:'0x0000000000000000000000000000000000000004'}]}]};const manifest=buildReviewedManifest([a,different]);expect(manifest.chains[0].contracts).toHaveLength(2);expect(Object.isFrozen(a.chains[0].contracts[0].functions[0])).toBe(false);expect(Object.isFrozen(manifest.chains[0].contracts[0].functions[0])).toBe(true);expect(buildReviewedManifest([different,a]).manifestHash).toBe(manifest.manifestHash);});
 it('rejects selector collisions and conflicting duplicate refs',()=>{const other=fragment('b');expect(()=>buildReviewedManifest([fragment('a'),{...other,chains:[{...other.chains[0],contracts:[{...other.chains[0].contracts[0],functions:[fn('different')]}]}]}])).toThrow(/selector/i);
  const base=fragment('a');const ref='asset:1:0x0000000000000000000000000000000000000002';const dep={ref:'assetdep',chainId:1,address:'0x0000000000000000000000000000000000000003',status:'candidate' as const,sourceRef:'s',identityChecks:[]};
  const withAsset={...base,deployments:[dep],assets:[{ref,chainId:1,address:'0x0000000000000000000000000000000000000002',symbol:'USDC' as const,decimals:6,maxOperationRaw:5n,deploymentRef:'assetdep'}]};
  expect(()=>buildReviewedManifest([withAsset,{...base,deployments:[{...dep,sourceRef:'conflict'}]}])).toThrow(/Conflicting reviewed manifest ref/);
 });
 it('requires proof and verified deployment references for active capabilities',()=>{const a=fragment('active');const f={...a.chains[0].contracts[0].functions[0],status:'active' as const,manifestRefs:{deployments:['d']}};const active={...a,chains:[{chainId:1,status:'active' as const,contracts:[{address:a.chains[0].contracts[0].address,status:'active' as const,functions:[f]}]}]};expect(()=>buildReviewedManifest([active])).toThrow(/Unknown deployment ref/);});
 it('pins ZeppelinOS to its known source-reviewed implementation slot',()=>{
  expect(REVIEWED_ZEPPELINOS_IMPLEMENTATION_SLOT).toBe('0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3');
  expect(REVIEWED_ZEPPELINOS_IMPLEMENTATION_SLOT).not.toBe('0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc');
 });
 it('accepts ZeppelinOS candidate metadata without fabricated hashes, but requires implementation code identity when verified',()=>{
  const base=fragment('a');const proxy={kind:'zeppelinos' as const,implementation:'0x0000000000000000000000000000000000000004'};
  const candidate={...base,deployments:[{ref:'proxy',chainId:1,address:'0x0000000000000000000000000000000000000003',status:'candidate' as const,sourceRef:'source-evidence',identityChecks:[],proxy}]};
  expect(buildReviewedManifest([candidate]).deployments[0].proxy?.implementationCodeHash).toBeUndefined();
  expect(()=>buildReviewedManifest([{...candidate,deployments:[{...candidate.deployments[0],proxy:{...proxy,kind:'unknown'} as never}]}])).toThrow(/Invalid reviewed deployment/);
  expect(()=>buildReviewedManifest([{...candidate,deployments:[{...candidate.deployments[0],status:'verified' as const,abiHash:`0x${'1'.repeat(64)}`,runtimeCodeHash:`0x${'2'.repeat(64)}`,verificationRef:'verified',identityChecks:[{getter:'implementation',expected:proxy.implementation}]}]}])).toThrow(/Invalid reviewed deployment/);
 });
 it('requires active proxy deployments to have implementation code hash and includes proxy identity in manifest hash',()=>{
   const base=fragment('a');const abi=[{type:'function',name:'decimals',stateMutability:'view',inputs:[],outputs:[{name:'out0',type:'uint8'}]}] as const;const deployment={ref:'proxy',chainId:1,address:'0x0000000000000000000000000000000000000003',status:'verified' as const,sourceRef:'source',abi,abiHash:reviewedAbiHash(abi),runtimeCodeHash:`0x${'2'.repeat(64)}` as `0x${string}`,verificationRef:'proof',identityChecks:[{getter:'decimals()',expected:'6'}],proxy:{kind:'zeppelinos' as const,implementation:'0x0000000000000000000000000000000000000004',implementationCodeHash:`0x${'3'.repeat(64)}` as `0x${string}`}};
  const withProxy={...base,deployments:[deployment]};const first=buildReviewedManifest([withProxy]);
  const changed=buildReviewedManifest([{...withProxy,deployments:[{...deployment,proxy:{...deployment.proxy,implementationCodeHash:`0x${'4'.repeat(64)}` as `0x${string}`}}]}]);
  expect(first.manifestHash).not.toBe(changed.manifestHash);
  const activeFn={...base.chains[0].contracts[0].functions[0],status:'active' as const,manifestRefs:{deployments:['proxy']}};
  const active={...withProxy,activationEvidence:[{capabilityId:'a',executionProofRef:'fork-proof',sourceIdentityRef:'source-identity'}],chains:[{chainId:1,status:'active' as const,contracts:[{address:activeFn.contract,status:'active' as const,functions:[activeFn]}]}]};
   expect(buildReviewedManifest([active]).capabilities[0].status).toBe('active');
   expect(()=>buildReviewedManifest([{...withProxy,deployments:[{...deployment,abiHash:`0x${'4'.repeat(64)}` as `0x${string}`}]}])).toThrow(/Invalid reviewed deployment/);
 });
});
