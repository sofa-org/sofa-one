import type { AbiFunction } from 'viem';
import type { DefiChainPolicy, DefiExecutionContext, DefiFunctionPolicy } from '../../defi.types';
import type { DefiRegistryFragment, ReviewedAsset, ReviewedDeployment, ReviewedMarket } from '../defi-manifest.types';

const AAVE_SHA = '17567521ae51088c85e01a6d8240f18b383bac2f';
const COMET_SHA = 'f766f51583c23acc33b2a7824654ef2029a96804';
const source = (repo: string, sha: string, file: string) => `https://github.com/${repo}/blob/${sha}/${file}`;
const lower = (s: string) => s.toLowerCase();
const assetRows = [
  [1,'USDC','0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',6],[1,'USDT','0xdAC17F958D2ee523a2206206994597C13D831ec7',6],[1,'WETH','0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',18],
  [8453,'USDC','0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',6],[8453,'WETH','0x4200000000000000000000000000000000000006',18],
  [42161,'USDC','0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',6],[42161,'USDT','0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',6],[42161,'WETH','0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',18],
  [10,'USDC','0x7F5c764cBc14f9669B88837ca1490cCa17c31607',6],[10,'USDT','0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',6],[10,'WETH','0x4200000000000000000000000000000000000006',18],
  [137,'USDC','0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',6],[137,'WETH','0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',18],
  [56,'USDC','0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',18],[56,'USDT','0x55d398326f99059fF775485246999027B3197955',18],
  [143,'USDC','0x754704Bc059F8C67012fEd69BC8A327a5aafb603',6],[143,'WETH','0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242',18],
] as const;
const aavePools = [
  [1,'0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2','0x728a138A4823392C2EFA55e028d434F526fE03CF','AaveV3Ethereum.ts'],
  [8453,'0xA238Dd80C259a72e81d7e4664a9801593F98d1c5','0xA4AbC5FcBA6D0d7E3D144d6dbF6cb6128599dFdB','AaveV3Base.ts'],
  [42161,'0x794a61358D6845594F94dc1DB02A252b5b4814aD','0xF05Fd3cC911b4c5E36e53c00354F645E22922C9A','AaveV3Arbitrum.ts'],
  [10,'0x794a61358D6845594F94dc1DB02A252b5b4814aD','0x66185E53343336d4FaeA5317d1Fcca103Dd4088D','AaveV3Optimism.ts'],
  [137,'0x794a61358D6845594F94dc1DB02A252b5b4814aD','0x6030dB989D47cD74FC17bB6F4FcD3A8B29FEe57e','AaveV3Polygon.ts'],
  [56,'0x6807dc923806fE8Fd134338EABCA509979a7e0cB','0x5e2B0FcC5b9734C7Ec0A03401ee9e6805F783B6d','AaveV3BNB.ts'],
  [143,'0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef','0x9539531EA4f6563A66421a7449506152609985be','AaveV3Monad.ts'],
] as const;
const cometMarkets = [[1,'0xc3d688B66703497DAA19211EEdff47f25384cdc3','0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],[8453,'0xb125E6687d4313864e53df431d5425969c15Eb2F','0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],[42161,'0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf','0xaf88d065e77c8cC2239327C5EDb3A432268e5831']] as const;
const addr=(x:unknown):x is string=>typeof x==='string'&&/^0x[0-9a-fA-F]{40}$/.test(x);
const uint=(x:unknown):x is bigint=>typeof x==='bigint'&&x>0n&&x<(1n<<256n)-1n;
const owner=(a:unknown,c:DefiExecutionContext)=>addr(a)&&addr(c.executionOwner)&&lower(a)===lower(c.executionOwner)&&c.executionMode==='user_operation';
const abi=(name:string,inputs:string[],outputs:string[]=[]):AbiFunction=>({type:'function',name,stateMutability:'nonpayable',inputs:inputs.map((type,i)=>({name:['asset','amount','onBehalfOf','referralCode','to','interestRateMode'][i]??`arg${i}`,type})),outputs:outputs.map((type,i)=>({name:`out${i}`,type}))} as AbiFunction);
const assets:ReviewedAsset[]=[]; const deployments:ReviewedDeployment[]=[]; const markets:ReviewedMarket[]=[];
const assetRef=(chain:number,address:string)=>`asset:${chain}:${lower(address)}`;
for(const [chain,symbol,address,decimals] of assetRows){const ref=`token:${chain}:${lower(address)}`; deployments.push({ref,chainId:chain,address,status:'candidate',sourceRef:`${source('aave-dao/aave-address-book',AAVE_SHA,'src/ts')}/` ,identityChecks:[]});assets.push({ref:assetRef(chain,address),chainId:chain,address,symbol,decimals,maxOperationRaw:BigInt(symbol==='WETH'?25:1000)*10n**BigInt(decimals),deploymentRef:ref});}
const caps:DefiFunctionPolicy[]=[];
function add(chain:number,contract:string,name:string,signature:string,abiFn:AbiFunction,operation:string,check:(a:readonly unknown[],c:DefiExecutionContext)=>boolean,describe:(a:readonly unknown[],c:DefiExecutionContext,i:number)=>ReturnType<DefiFunctionPolicy['describe']>,reason?:string,assetList?:string[],protocol='Aave V3'){
 const dep=`${protocol==='Compound III'?'compound-comet':'aave'}:${chain}:${lower(contract)}`; const id=`${protocol==='Compound III'?'compound-comet':'aave-v3'}:${chain}:${lower(contract)}:${name}`;
 caps.push({capabilityId:id,type:'contract_call',chainId:chain,contract,functionName:name,signature,abi:abiFn,policy:{ref:`${protocol.toLowerCase().replaceAll(' ','-')}-reviewed-candidate`,version:1},status:'inactive',protocol,operation,label:`${protocol} ${operation}`,description:`Fixed ${protocol} ABI ${signature}; candidate only, no lending deadline protection asserted.`,inactiveReason:reason??'Inactive until independent source identity proof and successful local-fork execution proof are accepted.',dependencies:[],manifestRefs:{assets:assetList??[],deployments:[dep]},validate:check,describe});
}
for(const [chain,pool,_impl,file] of aavePools){
 const dep=`aave:${chain}:${lower(pool)}`, ref=`https://github.com/aave-dao/aave-address-book/blob/${AAVE_SHA}/src/ts/${file}`;
 deployments.push({ref:dep,chainId:chain,address:pool,status:'candidate',sourceRef:ref,identityChecks:[{getter:'ADDRESSES_PROVIDER',expected:'candidate identity; pending independent on-chain check'},{getter:'POOL_IMPL',expected:_impl}]});
 const tokenRefs=assets.filter(a=>a.chainId===chain).map(a=>a.ref);
 markets.push({ref:`market:${chain}:${lower(pool)}`,chainId:chain,deploymentRef:dep,assetRefs:tokenRefs,marketRef:pool});
 const allowed=assetRows.filter(r=>r[0]===chain).map(r=>r[2]);
 const match=(x:unknown)=>allowed.some(t=>lower(t)===lower(String(x)));
 const supplyAbi=abi('supply',['address','uint256','address','uint16']);
 add(chain,pool,'supply','supply(address,uint256,address,uint16)',supplyAbi,'supply',(a,c)=>a.length===4&&match(a[0])&&uint(a[1])&&owner(a[2],c)&&a[3]===0n&&BigInt(a[1] as bigint)<=assets.find(x=>x.chainId===chain&&lower(x.address)===lower(a[0] as string))!.maxOperationRaw,
  (a,c,i)=>{const token=String(a[0]);return{kind:'action',index:i,operation:'supply',deploymentRef:dep,token,amount:a[1] as bigint,funding:{token,spender:pool,amount:a[1] as bigint}};},undefined,tokenRefs);
 const withdrawAbi=abi('withdraw',['address','uint256','address'],['uint256']);
 add(chain,pool,'withdraw','withdraw(address,uint256,address)',withdrawAbi,'withdraw',(a,c)=>a.length===3&&match(a[0])&&uint(a[1])&&owner(a[2],c)&&BigInt(a[1] as bigint)<=assets.find(x=>x.chainId===chain&&lower(x.address)===lower(a[0] as string))!.maxOperationRaw,
  (a,_c,i)=>({kind:'action',index:i,operation:'withdraw',deploymentRef:dep,token:String(a[0]),amount:a[1] as bigint}),undefined,tokenRefs);
 const repayAbi=abi('repay',['address','uint256','uint256','address'],['uint256']);
 add(chain,pool,'repay','repay(address,uint256,uint256,address)',repayAbi,'repay',(a,c)=>a.length===4&&match(a[0])&&uint(a[1])&&a[2]===2n&&owner(a[3],c)&&BigInt(a[1] as bigint)<=assets.find(x=>x.chainId===chain&&lower(x.address)===lower(a[0] as string))!.maxOperationRaw,
  (a,_c,i)=>{const token=String(a[0]);return{kind:'action',index:i,operation:'repay',deploymentRef:dep,token,amount:a[1] as bigint,funding:{token,spender:pool,amount:a[1] as bigint}};},undefined,tokenRefs);
 add(chain,pool,'borrow','borrow(address,uint256,uint256,uint16,address)',abi('borrow',['address','uint256','uint256','uint16','address']), 'borrow',()=>false,()=>{throw new Error('Borrow is unsupported and inactive by product policy');},'Borrow is not selected; no borrowing or health-factor policy is authorized.',tokenRefs);
}
for(const [chain,market,token] of cometMarkets){const asset=assetRef(chain,token),dep=`compound-comet:${chain}:${lower(market)}`;
 if(!assets.some(a=>a.ref===asset)){const tokenDep=`token:${chain}:${lower(token)}`;deployments.push({ref:tokenDep,chainId:chain,address:token,status:'candidate',sourceRef:source('compound-finance/comet',COMET_SHA,`deployments/arbitrum/usdc/configuration.json`),identityChecks:[]});assets.push({ref:asset,chainId:chain,address:token,symbol:'USDC',decimals:6,maxOperationRaw:1000n*10n**6n,deploymentRef:tokenDep});}
 deployments.push({ref:dep,chainId:chain,address:market,status:'candidate',sourceRef:source('compound-finance/comet',COMET_SHA,`deployments/${chain===1?'mainnet':chain===8453?'base':'arbitrum'}/usdc/roots.json`),identityChecks:[{getter:'baseToken',expected:token}]});
 markets.push({ref:`market:${chain}:${lower(market)}`,chainId:chain,deploymentRef:dep,assetRefs:[asset],marketRef:market,debtAssetRef:asset});
 for(const [name,operation] of [['supply','supply'],['withdraw','withdraw']] as const){const signature=`${name}(address,uint256)`;
  const inactive=name==='withdraw'?'Comet base withdraw may create debt; excluded from grantable policy.':'Inactive until source identity and successful local-fork proof are accepted.';
  add(chain,market,name,signature,abi(name,['address','uint256']),operation,(a,c)=>name==='supply'&&a.length===2&&lower(String(a[0]))===lower(token)&&uint(a[1])&&BigInt(a[1] as bigint)<=assets.find(x=>x.ref===asset)!.maxOperationRaw&&c.executionMode==='user_operation'&&addr(c.executionOwner),
   (a,_c,i)=>{if(name!=='supply')throw new Error('Compound base withdraw is unsupported');return{kind:'action',index:i,operation:'supply',deploymentRef:dep,token,amount:a[1] as bigint,funding:{token,spender:market,amount:a[1] as bigint}};},inactive,[asset],'Compound III');
 }
}
const chains:DefiChainPolicy[]=[...new Set(caps.map(x=>x.chainId))].sort((a,b)=>a-b).map(chain=>({chainId:chain,status:'inactive',contracts:[...new Set(caps.filter(x=>x.chainId===chain).map(x=>x.contract))].map(address=>({address,status:'inactive',functions:caps.filter(x=>x.chainId===chain&&lower(x.contract)===lower(address))}))}));
export const LENDING_MARKETS=Object.freeze(markets);
export const LENDING_CAPABILITIES=Object.freeze(caps);
export function buildLendingRegistry():DefiRegistryFragment{return{chains,assets,deployments,priceFeeds:[],pools:[],markets,activationEvidence:[]};}
