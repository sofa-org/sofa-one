import type { DefiBatchPlan, DefiCallEffect, DefiExecutionContext } from './defi.types';

/** Enforces atomic finite-approval groups; evidence later checks balances and allowance state. */
export function buildDefiBatchPlan(effects: readonly DefiCallEffect[], context: DefiExecutionContext, ceilings: Readonly<Record<string, bigint>> = {}): DefiBatchPlan {
  const totals: Record<string, bigint> = {};
  const operationTotals: Record<string,bigint>={};
  const consumed = new Set<number>();
  const fail = (): never => { throw new Error('DEFI_INVALID_PARAMETERS'); };
  if (!['eoa','session_key'].includes(context.executionMode)) fail();
  const snapshot=deepFreeze(clone(effects));
  if (!Array.isArray(snapshot) || snapshot.length===0 || snapshot.some((e,i)=>!e||!Number.isSafeInteger(e.index)||e.index!==i)) fail();
  if (context.executionMode === 'eoa') {
    if (snapshot.length===1 && snapshot[0].kind==='approval' && snapshot[0].amount===0n && validApproval(snapshot[0])) return Object.freeze({effects:snapshot,fundingTotals:Object.freeze({})});
    if (snapshot.length !== 1 || snapshot[0].kind !== 'action' || snapshot[0].funding) fail();
    return Object.freeze({ effects: Object.freeze([...effects]), fundingTotals: Object.freeze({}) });
  }
  for (let i = 0; i < snapshot.length; i++) {
    const effect = snapshot[i];
    if (consumed.has(i)) continue;
    if (effect.kind === 'approval') {
      if(!validApproval(effect))fail();
      if (effect.amount === 0n) { const next=snapshot[i+1], previous=snapshot[i-1]; const paired=previous?.kind==='action'&&previous.funding; const reset=next?.kind==='approval'&&next.amount>0n; if(paired&&(previous.funding.token.toLowerCase()!==effect.token.toLowerCase()||previous.funding.spender.toLowerCase()!==effect.spender.toLowerCase()))fail(); if(reset&&(next.token.toLowerCase()!==effect.token.toLowerCase()||next.spender.toLowerCase()!==effect.spender.toLowerCase()))fail(); continue; }
      if (effect.amount < 0n || snapshot[i + 1]?.kind !== 'action') fail();
      if(i>0&&snapshot[i-1].kind==='approval'&&snapshot[i-1].amount===0n&&(snapshot[i-1].token.toLowerCase()!==effect.token.toLowerCase()||snapshot[i-1].spender.toLowerCase()!==effect.spender.toLowerCase()))fail();
      const action = snapshot[i + 1];
      if (action.kind !== 'action' || !action.funding || action.funding.token.toLowerCase() !== effect.token.toLowerCase() || action.funding.spender.toLowerCase() !== effect.spender.toLowerCase() || action.funding.amount !== effect.amount || action.amount !== effect.amount) fail();
      if(!validAction(action))fail();
      const reset = snapshot[i + 2];
      if (!reset || reset.kind !== 'approval' || reset.amount !== 0n || reset.token.toLowerCase() !== effect.token.toLowerCase() || reset.spender.toLowerCase() !== effect.spender.toLowerCase()) fail();
      consumed.add(i + 1); consumed.add(i + 2);
      const key = effect.token.toLowerCase(); totals[key] = (totals[key] ?? 0n) + effect.amount; const operationKey=`${action.operation}:${key}`;operationTotals[operationKey]=(operationTotals[operationKey]??0n)+action.amount;
      continue;
    }
    if (effect.funding) fail();
    if(!validAction(effect))fail();
    const key=effect.token.toLowerCase(), operationKey=`${effect.operation}:${key}`;operationTotals[operationKey]=(operationTotals[operationKey]??0n)+effect.amount;
  }
  for (const [key, total] of Object.entries(operationTotals)) {const token=key.slice(key.indexOf(':')+1);if(total<=0n||ceilings[token]===undefined||total>ceilings[token])fail();}
  return Object.freeze({ effects: snapshot, fundingTotals: Object.freeze(totals) });
}
function clone<T>(v:T):T{return Array.isArray(v)?v.map(clone) as T:v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,clone(x)])) as T:v;}
function deepFreeze<T>(v:T):T{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.freeze(v);Object.values(v as object).forEach(deepFreeze);}return v;}
function validAction(e:Extract<DefiCallEffect,{kind:'action'}>):boolean{return ['swap','supply','repay','withdraw'].includes(e.operation)&&typeof e.token==='string'&&/^0x[0-9a-f]{40}$/i.test(e.token)&&typeof e.deploymentRef==='string'&&e.deploymentRef.length>0&&typeof e.amount==='bigint'&&e.amount>0n&&(!e.funding||e.funding.amount===e.amount&&e.funding.token.toLowerCase()===e.token.toLowerCase());}
function validApproval(e:Extract<DefiCallEffect,{kind:'approval'}>):boolean{return typeof e.amount==='bigint'&&e.amount>=0n&&/^0x[0-9a-f]{40}$/i.test(e.token)&&/^0x[0-9a-f]{40}$/i.test(e.spender);}
