import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment, ReviewedAsset, ReviewedDeployment, ReviewedMarket } from '../defi-manifest.types';

const candidates=[
 {chain:1,vault:'0x04422053aDDbc9bB2759b248B574e3FCA76Bc145',asset:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',name:'Keyrock USDC',owner:'0xbA75546ACD56b3a9142f94F179b03970eE4283Fd',curator:'0xbA75546ACD56b3a9142f94F179b03970eE4283Fd',factory:'0xA1D94F746dEfa1928926b84fB2596c06926C0405',adapter:'0x7CA32dCD9269b0BeB21a4F364DED5cfFCB7b3635'},
 {chain:8453,vault:'0x050cE30b927Da55177A4914EC73480238BAD56f0',asset:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',name:'Gauntlet USDC Prime',owner:'0x5a4E19842e09000a582c20A4f524C26Fb48Dd4D0',curator:'0x9E33faAE38ff641094fa68c65c2cE600b3410585',factory:'0x4501125508079A99ebBebCE205DeC9593C2b5857',adapter:'0x2fEcd40f436CA170D2478a58Da898FcE93988eef'},
] as const;
const lower=(s:string)=>s.toLowerCase();
const abi=(name:string,inputs:string[],outputs:string[]):AbiFunction=>({type:'function',name,stateMutability:'nonpayable',inputs:inputs.map((type,i)=>({name:(name==='deposit'?['assets','onBehalf']:name==='withdraw'?['assets','receiver','onBehalf']:['shares','receiver','onBehalf'])[i],type})),outputs:outputs.map((type,i)=>({name:name==='redeem'?'assets':`out${i}`,type}))} as AbiFunction);
const addr=(x:unknown):x is string=>typeof x==='string'&&/^0x[0-9a-fA-F]{40}$/.test(x);
const positive=(x:unknown):x is bigint=>typeof x==='bigint'&&x>0n&&x<(1n<<256n)-1n;
const assets:ReviewedAsset[]=[],deployments:ReviewedDeployment[]=[],markets:ReviewedMarket[]=[],caps:DefiFunctionPolicy[]=[];
const assetRef=(chain:number,addr:string)=>`asset:${chain}:${lower(addr)}`;
for(const v of candidates){
 const dref=`morpho-vault-v2:${v.chain}:${lower(v.vault)}`, aref=`morpho-usdc:${v.chain}:${lower(v.asset)}`;
 const src=`https://api.morpho.org/graphql (vaultV2ByAddress; snapshot 2026-10-02; mutable API, no response hash)`;
 const tokenRef=`token:${v.chain}:${lower(v.asset)}`;
 deployments.push({ref:dref,chainId:v.chain,address:v.vault,status:'candidate',sourceRef:src,identityChecks:[{getter:'asset',expected:v.asset},{getter:'owner',expected:v.owner},{getter:'curator',expected:v.curator},{getter:'factory',expected:v.factory}]});
 deployments.push({ref:tokenRef,chainId:v.chain,address:v.asset,status:'candidate',sourceRef:`https://github.com/aave-dao/aave-address-book/blob/17567521ae51088c85e01a6d8240f18b383bac2f/src/ts/`,identityChecks:[]});
 assets.push({ref:assetRef(v.chain,v.asset),chainId:v.chain,address:v.asset,symbol:'USDC',decimals:6,maxOperationRaw:1000n*10n**6n,deploymentRef:tokenRef});
 markets.push({ref:`market:${v.chain}:${lower(v.vault)}`,chainId:v.chain,deploymentRef:dref,assetRefs:[assetRef(v.chain,v.asset)],marketRef:v.vault,collateralAssetRef:assetRef(v.chain,v.asset)});
 const specs=[
  {name:'deposit',signature:'deposit(uint256,address)',inputs:['uint256','address'],outputs:['uint256'],operation:'deposit'},
  {name:'withdraw',signature:'withdraw(uint256,address,address)',inputs:['uint256','address','address'],outputs:['uint256'],operation:'withdraw'},
  {name:'redeem',signature:'redeem(uint256,address,address)',inputs:['uint256','address','address'],outputs:['uint256'],operation:'withdraw'},
 ] as const;
 for(const s of specs){const id=`morpho-vault-v2:${v.chain}:${lower(v.vault)}:${s.name}`;
  const validate=(args:readonly unknown[],context:DefiExecutionContext)=>{
   if(!addr(context.executionOwner)||context.executionMode!=='user_operation')return false;
   const cap=1000n*10n**6n;
   if(s.name==='deposit')return args.length===2&&positive(args[0])&&(args[0] as bigint)<=cap&&addr(args[1])&&lower(args[1])===lower(context.executionOwner);
   return args.length===3&&positive(args[0])&&(s.name==='withdraw'?(args[0] as bigint)<=cap:true)&&addr(args[1])&&addr(args[2])&&lower(args[1])===lower(context.executionOwner)&&lower(args[2])===lower(context.executionOwner);
  };
  const describe:DefiFunctionPolicy['describe']=(args,_context,index)=>{
   if(s.name==='deposit')return{kind:'action',index,operation:'supply',deploymentRef:dref,token:v.asset,amount:args[0] as bigint,funding:{token:v.asset,spender:v.vault,amount:args[0] as bigint}};
   throw new Error('Vault withdrawal/redeem has no configured share ceiling or protected minimum output');
  };
  caps.push({capabilityId:id,type:'contract_call',chainId:v.chain,contract:v.vault,functionName:s.name,signature:s.signature,abi:abi(s.name,[...s.inputs],[...s.outputs]),policy:{ref:'morpho-vault-v2-candidate',version:1},status:'inactive',protocol:'Morpho Vault V2',operation:s.operation,label:`${v.name} ${s.name}`,description:`Exact official API candidate; ${s.signature}. ERC-4626-compatible shape is not arbitrary-vault authorization.`,inactiveReason:'Inactive: standard vault calls lack execution min-output protection, and live immutable implementation/asset/audit evidence is incomplete; share amount cap is unconfigured.',dependencies:[],manifestRefs:{assets:[assetRef(v.chain,v.asset)],deployments:[dref]},validate,describe});
 }
}
const chains:DefiChainPolicy[]=candidates.map(v=>({chainId:v.chain,status:'inactive',contracts:[{address:v.vault,status:'inactive',functions:caps.filter(c=>c.chainId===v.chain)}]}));
export const VAULT_MARKETS:readonly ReviewedMarket[]=Object.freeze(markets);
export const VAULT_CANDIDATES=Object.freeze(candidates);
export const VAULT_CAPABILITIES=Object.freeze(caps);
export function buildVaultRegistry():DefiRegistryFragment{return{chains,assets,deployments,priceFeeds:[],pools:[],markets,activationEvidence:[]};}
