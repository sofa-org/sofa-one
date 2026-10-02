import { decodeFunctionData, encodeFunctionData } from 'viem';
import { buildDexRegistry } from './index';

const user='0x1111111111111111111111111111111111111111';
const usdc='0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const usdt='0xdAC17F958D2ee523a2206206994597C13D831ec7';
const weth='0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const independentDeadlineAbi=[{type:'function',name:'exactInputSingle',stateMutability:'payable',inputs:[{name:'params',type:'tuple',components:[{name:'tokenIn',type:'address'},{name:'tokenOut',type:'address'},{name:'fee',type:'uint24'},{name:'recipient',type:'address'},{name:'deadline',type:'uint256'},{name:'amountIn',type:'uint256'},{name:'amountOutMinimum',type:'uint256'},{name:'sqrtPriceLimitX96',type:'uint160'}]}],outputs:[{name:'amountOut',type:'uint256'}]}] as const;
const independentRouter02Abi=[{type:'function',name:'exactInputSingle',stateMutability:'payable',inputs:[{name:'params',type:'tuple',components:[{name:'tokenIn',type:'address'},{name:'tokenOut',type:'address'},{name:'fee',type:'uint24'},{name:'recipient',type:'address'},{name:'amountIn',type:'uint256'},{name:'amountOutMinimum',type:'uint256'},{name:'sqrtPriceLimitX96',type:'uint160'}]}],outputs:[{name:'amountOut',type:'uint256'}]}] as const;

function getFunction(chainId:number,protocol='uniswap-v3') {
 const entry=buildDexRegistry().chains.find(c=>c.chainId===chainId)?.contracts.find(c=>c.functions.some(f=>f.protocol===protocol));
 return entry?.functions.find(f=>f.protocol===protocol)!;
}
function context(chainId=1,owner=user) {return {userId:'u',apiKeyId:'k',walletId:'w',chainId,executionMode:'eoa',executionOwner:owner,allowedCapabilityIds:[]};}

describe('DEX reviewed candidates',()=>{
 beforeEach(()=>jest.useFakeTimers().setSystemTime(new Date('2026-10-02T00:00:00Z')));
 afterEach(()=>jest.useRealTimers());

 it('uses externally encoded canonical eight-word original V3 ABI vector and describes funded input',()=>{
  const now=BigInt(Math.floor(Date.now()/1000));
  const params=[usdc,usdt,500,user,now+60n,1_000_000n,990_000n,0n] as const;
  const named={tokenIn:params[0],tokenOut:params[1],fee:params[2],recipient:params[3],deadline:params[4],amountIn:params[5],amountOutMinimum:params[6],sqrtPriceLimitX96:params[7]};
  const data=encodeFunctionData({abi:independentDeadlineAbi,functionName:'exactInputSingle',args:[named]});
  const decoded=decodeFunctionData({abi:independentDeadlineAbi,data});
  expect(Object.values(decoded.args[0] as object)).toEqual(params);
  const fn=getFunction(1),args=[params] as unknown as readonly unknown[];
  expect(fn.validate(args,context())).toBe(true);
  expect(fn.validate([Object.fromEntries(['tokenIn','tokenOut','fee','recipient','deadline','amountIn','amountOutMinimum','sqrtPriceLimitX96'].map((k,i)=>[k,params[i]]))],context())).toBe(true);
  const effect=fn.describe(args,context(),0);
  expect(effect).toMatchObject({kind:'action',operation:'swap',token:usdc,funding:{token:usdc,spender:fn.contract,amount:1_000_000n}});
 });

  it('enforces chain asset pairs, owner, recorded pool/fee and finite per-asset raw ceilings',()=>{
  const now=BigInt(Math.floor(Date.now()/1000));const fn=getFunction(1);
  const mk=(input:string,output:string,fee:number,amount=1_000_000n,min=1n,deadline=now+30n,recipient=user,limit=0n)=>[[input,output,fee,recipient,deadline,amount,min,limit]] as unknown as readonly unknown[];
  expect(fn.validate(mk(usdc,usdt,500),context())).toBe(true);
  expect(fn.validate(mk(usdc,usdt,3000),context())).toBe(false);
  expect(fn.validate(mk(usdc,'0x4200000000000000000000000000000000000006',500),context())).toBe(false);
   expect(fn.validate(mk(usdc,usdt,500,1_000_000_001n),context())).toBe(false);
   expect(fn.validate(mk(usdc,usdt,500,1_000_000_000n),context())).toBe(true);
   expect(fn.validate(mk(usdc,usdt,500,1_000_000_001n),context())).toBe(false);
   expect(fn.validate(mk(usdt,usdc,500,1_000_000_000n),context())).toBe(false); // no reversed pool is configured
   expect(buildDexRegistry().assets.find(a=>a.chainId===1&&a.address.toLowerCase()===usdt.toLowerCase())?.maxOperationRaw).toBe(1_000_000_000n);
  expect(fn.validate(mk(usdc,usdt,500,1n,0n),context())).toBe(false);
  expect(fn.validate(mk(usdc,usdt,500,0n),context())).toBe(false);
  expect(fn.validate(mk(usdc,usdt,500,1n,1n,now+121n),context())).toBe(false);
  expect(fn.validate(mk(usdc,usdt,500,1n,1n,now),context())).toBe(false);
  expect(fn.validate(mk(usdc,usdt,500,1n,1n,now+1n,'0x2222222222222222222222222222222222222222'),context())).toBe(false);
  expect(fn.validate(mk(usdc,usdt,500,1n,1n,now+1n,user,1n),context())).toBe(false);
   expect(fn.validate(mk(usdc,usdt,500),context(10))).toBe(false);
  });

  it('uses the approved 0.25 WETH boundary exactly and rejects one raw wei over',()=>{
   const now=BigInt(Math.floor(Date.now()/1000));const fn=getFunction(1);
   const mk=(amount:bigint)=>[[weth,usdc,500,user,now+30n,amount,1n,0n]] as unknown as readonly unknown[];
   expect(fn.validate(mk(250_000_000_000_000_000n),context())).toBe(true);
   expect(fn.validate(mk(250_000_000_000_000_001n),context())).toBe(false);
   expect(buildDexRegistry().assets.find(a=>a.chainId===1&&a.address.toLowerCase()===weth.toLowerCase())?.maxOperationRaw).toBe(250_000_000_000_000_000n);
  });

 it('keeps every deployment and capability inactive and never manufactures Router02 deadline semantics',()=>{
  const fragment=buildDexRegistry();
  expect(fragment.chains.every(c=>c.status==='inactive'&&c.contracts.every(k=>k.status==='inactive'&&k.functions.every(f=>f.status==='inactive')))).toBe(true);
  const router02=fragment.chains.find(c=>c.chainId===8453)!.contracts[0].functions[0];
  const params=[usdc,'0x4200000000000000000000000000000000000006',500,user,1n,1n,0n] as const;
  const named={tokenIn:params[0],tokenOut:params[1],fee:params[2],recipient:params[3],amountIn:params[4],amountOutMinimum:params[5],sqrtPriceLimitX96:params[6]};
  const data=encodeFunctionData({abi:independentRouter02Abi,functionName:'exactInputSingle',args:[named]});
  expect(Object.values(decodeFunctionData({abi:independentRouter02Abi,data}).args[0] as object)).toEqual(params);
  expect(router02.signature).toBe('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))');
  expect(router02.validate([params],context(8453))).toBe(false);
  expect(()=>router02.describe([params],context(8453),0)).toThrow();
  expect(fragment.assets.some(a=>a.chainId===56&&a.symbol==='WETH')).toBe(false);
  expect(fragment.assets.find(a=>a.chainId===1&&a.symbol==='USDC')?.maxOperationRaw).toBe(1_000_000_000n);
  expect(fragment.assets.find(a=>a.chainId===56&&a.symbol==='USDC')?.maxOperationRaw).toBe(1_000_000_000_000_000_000_000n);
 });

 it('deep-freezes returned catalog data so callers cannot mutate closed-over policy inputs',()=>{
  const fragment=buildDexRegistry();
  expect(Object.isFrozen(fragment.chains[0].contracts[0].functions[0].manifestRefs?.assets)).toBe(true);
  expect(Object.isFrozen(fragment.assets[0])).toBe(true);
  expect(Object.isFrozen(fragment.deployments[0])).toBe(true);
  expect(()=>{(fragment.assets[0] as {address:string}).address='0x0000000000000000000000000000000000000001';}).toThrow();
 });
});
