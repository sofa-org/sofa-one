import { buildProspectiveEthereumUsdcWeth500, PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS } from './production-registry';
import { buildDefiBatchPlan } from '../defi-batch.policy';
import { buildReviewedManifest } from './defi-manifest';
import { DefiCatalogService } from '../defi-catalog.service';

const owner='0x1111111111111111111111111111111111111111';
const usdc='0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const usdt='0xdAC17F958D2ee523a2206206994597C13D831ec7';
const weth='0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const router='0xE592427A0AEce92De3Edee1F18E0157C05861564';
const ctx={userId:'u',apiKeyId:'k',walletId:'w',chainId:1,executionMode:'session_key',executionOwner:owner,allowedCapabilityIds:[...PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS]};
describe('prospective and production Ethereum USDC/WETH V3 authority',()=>{
 beforeEach(()=>jest.useFakeTimers().setSystemTime(new Date('2026-10-02T00:00:00Z')));afterEach(()=>jest.useRealTimers());
 const manifest=()=>buildProspectiveEthereumUsdcWeth500();
 const action=()=>manifest().capabilities.find(fn=>fn.capabilityId===PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS[0])!;
 const make=(a:string,b:string,fee=500,amount=1_000_000n,recipient=owner)=>[[a,b,fee,recipient,BigInt(Math.floor(Date.now()/1000))+60n,amount,1n,0n]] as const;
 it('assembles exactly three inactive prospective grants while preserving other inventory inactive',()=>{
   const m=manifest();expect(m.capabilities.filter(f=>PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS.includes(f.capabilityId))).toHaveLength(3);
   expect(m.capabilities).toHaveLength(70);
  expect(m.capabilities.every(f=>f.status==='inactive')).toBe(true);
  expect(m.capabilities.filter(f=>f.protocol==='Aave V3'||f.protocol==='Morpho Vault V2'||f.protocol==='Compound III').every(f=>f.status==='inactive')).toBe(true);
  expect(m.pools.find(p=>p.poolRef?.toLowerCase()==='0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640')).toMatchObject({factoryRef:'factory:uniswap-v3:1:0x1f98431c8ad98523631ae4a59f267346ea31f984',deploymentRef:'pool-deployment:1:0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'});
  expect(m.assets.find(a=>a.address.toLowerCase()===weth.toLowerCase())?.priceFeedRef).toBeDefined();
 });
 it('narrows real router policy to only USDC/WETH fee500 with bounded owner/deadline/native fields',()=>{
  const fn=action();expect(fn.validate(make(usdc,weth),ctx)).toBe(true);expect(fn.validate(make(weth,usdc,500,250_000_000_000_000_000n),ctx)).toBe(true);
  expect(fn.validate(make(usdc,usdt),ctx)).toBe(false);expect(fn.validate(make(usdc,weth,3000),ctx)).toBe(false);
  expect(fn.validate(make(usdc,weth,500,1_000_000_001n),ctx)).toBe(false);expect(fn.validate(make(weth,usdc,500,250_000_000_000_000_001n),ctx)).toBe(false);
  expect(fn.validate(make(usdc,weth,500,1_000_000n,'0x2222222222222222222222222222222222222222'),ctx)).toBe(false);
  expect(fn.validate([ [usdc,weth,500,owner,BigInt(Math.floor(Date.now()/1000))+121n,1n,1n,0n] ],ctx)).toBe(false);
  expect(fn.validate([ [usdc,weth,500,owner,BigInt(Math.floor(Date.now()/1000))+60n,1n,1n,1n] ],ctx)).toBe(false);
  expect(fn.validate(make(usdc,weth),{...ctx,chainId:10})).toBe(false);
 });
 it('derives only USDC/WETH approvals for the original router and rejects other spenders/chains',()=>{
   const m=manifest();const rows=m.capabilities.filter(f=>f.protocol==='ERC-20');expect(rows).toHaveLength(18);
   const selectedRows=rows.filter(f=>PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS.includes(f.capabilityId));expect(selectedRows).toHaveLength(2);
   for(const fn of selectedRows){const ceiling=fn.contract.toLowerCase()===usdc.toLowerCase()?1_000_000_000n:250_000_000_000_000_000n;expect(fn.approval?.spenderRefs).toHaveLength(1);expect(fn.approval?.spenderRefs?.map(ref=>m.deployments.find(d=>d.ref===ref)?.address)).toEqual([router]);expect(fn.validate([router,0n],ctx)).toBe(true);expect(fn.validate(['0x1111111111111111111111111111111111111111',1n],ctx)).toBe(false);expect(fn.validate([router,ceiling+1n],ctx)).toBe(false);expect(fn.validate([router,1n],{...ctx,chainId:10})).toBe(false);}
   const activated=buildProspectiveEthereumUsdcWeth500({activate:true});
   expect(activated.capabilities.filter(f=>PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS.includes(f.capabilityId)&&f.status==='active')).toHaveLength(3);
   expect(activated.capabilities).toHaveLength(70);
   expect(activated.capabilities.filter(f=>!PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS.includes(f.capabilityId)).every(f=>f.status==='inactive')).toBe(true);
  expect(activated.chains.filter(c=>c.status==='active')).toHaveLength(1);
  expect(activated.chains.find(c=>c.chainId===1)?.contracts.filter(c=>c.status==='active').every(c=>c.functions.every(f=>PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS.includes(f.capabilityId)))).toBe(true);
   expect(new DefiCatalogService(activated.chains,{} as never,activated).functionForCapability(PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS[0])?.status).toBe('active');
   const impl=activated.deployments.find(d=>d.ref==='token-implementation:1:0x43506849d7c04f9138d1a2050bbf3a0c054402dd')!;
   const proxy=activated.deployments.find(d=>d.ref==='token:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')!;
   expect(impl.identityChecks.find(c=>c.getter==='decimals()')?.expected).toBe('0');
   expect(proxy.identityChecks.find(c=>c.getter==='decimals()')?.expected).toBe('6');
  const asFragment={chains:activated.chains,assets:activated.assets,deployments:activated.deployments,priceFeeds:activated.priceFeeds,pools:activated.pools,markets:activated.markets,activationEvidence:activated.capabilities.map(fn=>({capabilityId:fn.capabilityId,executionProofRef:'fixture proof',sourceIdentityRef:'fixture source'}))};
  const factory=activated.deployments.find(d=>d.ref==='factory:uniswap-v3:1:0x1f98431c8ad98523631ae4a59f267346ea31f984')!;
  expect(()=>buildReviewedManifest([{...asFragment,deployments:activated.deployments.filter(d=>d.ref!==factory.ref)}])).toThrow();
  expect(()=>buildReviewedManifest([{...asFragment,deployments:activated.deployments.map(d=>d.ref===factory.ref?{...d,identityChecks:[{...d.identityChecks[0],args:['bad','also bad',1]}]}:d)}])).toThrow(/Invalid reviewed deployment/);
  expect(()=>buildReviewedManifest([{...asFragment,deployments:activated.deployments.map(d=>d.ref===factory.ref?{...d,abiHash:`0x${'0'.repeat(64)}` as `0x${string}`}:d)}])).toThrow(/Invalid reviewed deployment/);
  const selectedPins=activated.deployments.filter(d=>d.status==='verified');
  expect(()=>buildProspectiveEthereumUsdcWeth500({activate:true,dependencyOverrides:selectedPins.filter(d=>d.ref!==factory.ref)})).toThrow(/Unknown deployment ref|incomplete verified dependency closure/);
  expect(()=>buildProspectiveEthereumUsdcWeth500({activate:true,dependencyOverrides:selectedPins.map(d=>d.ref===factory.ref?{...d,identityChecks:[{...d.identityChecks[0],expected:'0x0000000000000000000000000000000000000001'},d.identityChecks[1]]}:d)})).toThrow(/factory pool relation drift/);
 });
 it('core batch requires action+exact approval+cleanup and rejects unpaired, reordered, or missing cleanup',()=>{
  const fn=action(),effect=fn.describe(make(usdc,weth) as unknown as readonly unknown[],ctx,1) as {kind:'action';operation:'swap';deploymentRef:string;token:string;amount:bigint;funding:{token:string;spender:string;amount:bigint}};
  const funded={...effect,index:1};const grant=PROSPECTIVE_ETH_USDC_WETH_500_CAPABILITY_IDS;
  expect(grant).toHaveLength(3);expect(grant.includes(fn.capabilityId)).toBe(true);
  expect(buildDefiBatchPlan([{kind:'approval',index:0,token:usdc,spender:router,amount:1_000_000n},funded,{kind:'approval',index:2,token:usdc,spender:router,amount:0n}],ctx,{[usdc.toLowerCase()]:1_000_000_000n})).toBeDefined();
  for(const bad of [[{kind:'approval',index:0,token:usdc,spender:router,amount:1n}], [{...funded,index:0},{kind:'approval',index:1,token:usdc,spender:router,amount:1n}], [{kind:'approval',index:0,token:usdc,spender:router,amount:1_000_000n},funded]]) expect(()=>buildDefiBatchPlan(bad as never,ctx,{[usdc.toLowerCase()]:1_000_000_000n})).toThrow();
  expect(()=>buildDefiBatchPlan([{kind:'approval',index:0,token:usdc,spender:router,amount:1_000_000n},{...funded,index:1},{kind:'approval',index:2,token:usdc,spender:router,amount:0n}],{...ctx,allowedCapabilityIds:[grant[0]]},{[usdc.toLowerCase()]:1_000_000_000n})).not.toThrow();
  const authorized=(ids:readonly string[])=>ids.includes(grant[0])&&ids.includes(grant[1]);
  expect(authorized(grant)).toBe(true);expect(authorized([grant[0]])).toBe(false);expect(authorized([grant[1]])).toBe(false);
 });
});
