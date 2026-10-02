import { buildDefiBatchPlan } from './defi-batch.policy';
import type { DefiExecutionContext } from './defi.types';
const ctx: DefiExecutionContext = { userId:'u',apiKeyId:'k',walletId:'w',chainId:1,executionMode:'session_key',executionOwner:'0x0000000000000000000000000000000000000001',allowedCapabilityIds:[] };
const token='0x0000000000000000000000000000000000000002', spender='0x0000000000000000000000000000000000000003';
describe('Defi batch policy',()=>{
  it('requires exact finite approval, funded action, and zero cleanup; totals funding',()=>{
    const effects=[{kind:'approval' as const,index:0,token,spender,amount:5n},{kind:'action' as const,index:1,operation:'supply' as const,deploymentRef:'d',token,amount:5n,funding:{token,spender,amount:5n}},{kind:'approval' as const,index:2,token,spender,amount:0n}];
    expect(buildDefiBatchPlan(effects,ctx,{[token]:10n}).fundingTotals[token]).toBe(5n);
    expect(()=>buildDefiBatchPlan(effects.slice(0,2),ctx,{[token]:10n})).toThrow('DEFI_INVALID_PARAMETERS');
  });
  it('rejects unpaired positive approval and funded EOA action',()=>{
    expect(()=>buildDefiBatchPlan([{kind:'approval',index:0,token,spender,amount:1n}],ctx,{[token]:1n})).toThrow();
    expect(()=>buildDefiBatchPlan([{kind:'action',index:0,operation:'supply',deploymentRef:'d',token,amount:1n,funding:{token,spender,amount:1n}}],{...ctx,executionMode:'eoa'})).toThrow();
  });
});
