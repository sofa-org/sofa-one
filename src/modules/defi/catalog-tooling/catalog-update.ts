import { createHash } from 'node:crypto';
import { toFunctionSelector } from 'viem';
import type { DefiFunctionPolicy } from '../defi.types';
import type { DefiExecutionScope } from '../defi.types';
import type { DefiRegistryFragment } from '../registry/defi-manifest.types';
import { buildReviewedManifest } from '../registry/defi-manifest';
import { POLYMARKET_PUSD_WRAP_IDENTITY } from '../execution/pusd-identity';
import { executionScopeHash } from '../execution/scope';
import { validatePolymarketPusdAdmission } from './pusd-admission';
import { assertBaselinePreserved, canonicalSourceSha256, catalogDiff, compileSourceSnapshotBindings, SOURCE_CHAIN_IDS, validateCatalogDocument } from './catalog-generator';

type Admission = Readonly<{ sourcePath:string; familyId:string; familyVersion:string; chainId:number; contract:string; signature:string; selector:string; abiHash:string; capabilityId:string; sourceRefs:readonly string[]; executionScope:DefiExecutionScope|null; executionScopeHash:string|null; authorityReview:{classification:'ordinary-direct'|'polymarket-pusd-restricted';sourceRefs:readonly string[];evidence:string} }>;
export type CatalogUpdatePlan = Readonly<{schemaVersion:1;baseline:{path:string;rawSha256:string;manifestHash:string};sources:readonly {path:string;canonicalSha256:string}[];admissions:readonly Admission[];deactivations:readonly {capabilityId:string;expectedFullObjectSha256:string;reason:string}[]}>;
export type CatalogUpdateBinding = Readonly<{sourcePath:string;familyId:string;familyVersion:string;chainId:number;contract:string;signature:string;selector:string;abiHash:string;sourceRefs:readonly string[];fn:DefiFunctionPolicy}>;

const rec=(v:unknown,n:string):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error(`${n} must be an object`);return v as Record<string,unknown>};
const arr=(v:unknown,n:string):unknown[]=>{if(!Array.isArray(v))throw Error(`${n} must be an array`);return v;};
const strict=(v:Record<string,unknown>,fields:string[],n:string)=>{if(Object.keys(v).some(k=>!fields.includes(k))||fields.some(k=>!(k in v)))throw Error(`${n} has missing or unsupported fields`);};
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const sourcePattern=/^data\/defi-catalog\/updates\/[a-z0-9]+(?:-[a-z0-9]+)*\/sources\/[A-Za-z0-9._-]+\.json$/;

export function validateUpdatePlan(value:unknown,planPath?:string):CatalogUpdatePlan {
  const p=rec(value,'plan');strict(p,['schemaVersion','baseline','sources','admissions','deactivations'],'plan');if(p.schemaVersion!==1)throw Error('Unsupported update schemaVersion');
  const b=rec(p.baseline,'baseline');strict(b,['path','rawSha256','manifestHash'],'baseline');if(typeof b.path!=='string'||!/^data\/defi-catalog\/(?:v[1-9][0-9]*|updates\/[a-z0-9]+(?:-[a-z0-9]+)*)\/catalog\.json$/.test(b.path)||!sha(b.rawSha256)||typeof b.manifestHash!=='string'||!/^0x[a-f0-9]{64}$/.test(b.manifestHash))throw Error('Invalid baseline pins');
  const sources=arr(p.sources,'sources').map(v=>{const s=rec(v,'source');strict(s,['path','canonicalSha256'],'source');if(typeof s.path!=='string'||!sourcePattern.test(s.path)||!sha(s.canonicalSha256))throw Error('Invalid source pin');return {path:s.path,canonicalSha256:s.canonicalSha256 as string} as const;});
  const dir=(x:string)=>x.slice(0,x.lastIndexOf('/'));const expected=planPath?.replace(/\/plan\.json$/,'/sources');if(!sources.length||new Set(sources.map(x=>x.path)).size!==sources.length||sources.some(x=>dir(x.path)!==dir(sources[0].path)||(expected!==undefined&&dir(x.path)!==expected)))throw Error('Sources must be unique and confined to the selected update folder');
  const admissions=arr(p.admissions,'admissions').map(v=>{const a=rec(v,'admission');strict(a,['sourcePath','familyId','familyVersion','chainId','contract','signature','selector','abiHash','capabilityId','sourceRefs','executionScope','executionScopeHash','authorityReview'],'admission');const r=rec(a.authorityReview,'authorityReview');strict(r,['classification','sourceRefs','evidence'],'authorityReview');
    const refs=(v:unknown,label:string):string[]=>{if(!Array.isArray(v)||!v.length||v.some(x=>typeof x!=='string'||!/^[A-Za-z0-9._:-]{1,160}$/.test(x))||new Set(v).size!==v.length)throw Error(`${label} must be nonempty unique source IDs`);return [...v as string[]].sort();};
    if(typeof a.sourcePath!=='string'||!sources.some(s=>s.path===a.sourcePath)||typeof a.familyId!=='string'||!/^[A-Za-z0-9._-]{1,80}$/.test(a.familyId)||typeof a.familyVersion!=='string'||!/^[A-Za-z0-9._@-]{1,80}$/.test(a.familyVersion)||typeof a.chainId!=='number'||!SOURCE_CHAIN_IDS.includes(a.chainId)||typeof a.contract!=='string'||!/^0x[0-9a-f]{40}$/.test(a.contract)||typeof a.signature!=='string'||typeof a.selector!=='string'||!/^0x[0-9a-f]{8}$/.test(a.selector)||typeof a.abiHash!=='string'||!/^0x[a-f0-9]{64}$/.test(a.abiHash)||typeof a.capabilityId!=='string'||!/^[-A-Za-z0-9:._]{1,160}$/.test(a.capabilityId)||a.capabilityId.startsWith('candidate:')||typeof r.evidence!=='string'||!r.evidence.trim())throw Error('Invalid catalog admission');
    const sourceRefs=refs(a.sourceRefs,'admission.sourceRefs'),reviewRefs=refs(r.sourceRefs,'authorityReview.sourceRefs');if(reviewRefs.some(x=>!sourceRefs.includes(x)))throw Error('Authority review refs must resolve within bound source refs');
    let selector:string;try{selector=toFunctionSelector(a.signature).toLowerCase();}catch{selector='';}if(!selector||selector!==a.selector)throw Error('Admission signature or selector is invalid');
    const classification=r.classification;
    if(classification==='ordinary-direct') {
      if(a.executionScope!==null||a.executionScopeHash!==null)throw Error('Generic ordinary admissions must remain scope-free');
    } else if(classification==='polymarket-pusd-restricted') {
      if(a.executionScope===null||typeof a.executionScopeHash!=='string'||!/^0x[a-f0-9]{64}$/.test(a.executionScopeHash))throw Error('Restricted pUSD admission requires its mandatory scope');
      if(a.executionScopeHash!==executionScopeHash(a.executionScope as DefiExecutionScope))throw Error('Restricted pUSD scope hash mismatch');
    } else throw Error('Unsupported catalog authority classification');
    return {...a,sourceRefs,authorityReview:{classification,sourceRefs:reviewRefs,evidence:r.evidence}} as unknown as Admission;
  });
  const deactivations=arr(p.deactivations,'deactivations').map(v=>{const d=rec(v,'deactivation');strict(d,['capabilityId','expectedFullObjectSha256','reason'],'deactivation');if(typeof d.capabilityId!=='string'||typeof d.reason!=='string'||!d.reason.trim()||!sha(d.expectedFullObjectSha256))throw Error('Invalid deactivation');return d as unknown as CatalogUpdatePlan['deactivations'][number];});
  if(new Set(admissions.map(a=>a.capabilityId)).size!==admissions.length)throw Error('Duplicate admission capabilityId');if(new Set(deactivations.map(d=>d.capabilityId)).size!==deactivations.length)throw Error('Duplicate deactivation');
  return {schemaVersion:1,baseline:b as unknown as CatalogUpdatePlan['baseline'],sources,admissions,deactivations};
}

function canonicalJson(v:unknown):string {if(Array.isArray(v))return `[${v.map(x=>x===undefined?'null':canonicalJson(x)).join(',')}]`;if(v&&typeof v==='object')return `{${Object.entries(v as Record<string,unknown>).filter(([,x])=>x!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>`${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;return JSON.stringify(v)??'null';}
export function fullCatalogFunctionSha256(fn:DefiFunctionPolicy):string{return createHash('sha256').update(canonicalJson(fn)).digest('hex');}
function hasBytes(v:unknown):boolean {if(Array.isArray(v))return v.some(hasBytes);if(v&&typeof v==='object'){const x=v as Record<string,unknown>;if(typeof x.type==='string'&&/^bytes(?:[0-9]+)?(?:\[[0-9]*\])*$/.test(x.type))return true;return Object.values(x).some(hasBytes);}return false;}
function selectorKey(x:{chainId:number;contract:string;selector:string}):string{return `${x.chainId}:${x.contract.toLowerCase()}:${x.selector.toLowerCase()}`;}

export function prepareCatalogUpdate(baseline:DefiRegistryFragment,planValue:unknown,inputs:readonly {sourcePath:string;document:unknown}[],baselineRawSha256:string) {
  const plan=validateUpdatePlan(planValue);if(!sha(baselineRawSha256)||baselineRawSha256!==plan.baseline.rawSha256)throw Error('Baseline raw bytes pin mismatch');
  if(inputs.length!==plan.sources.length||inputs.some((x,i)=>x.sourcePath!==plan.sources[i].path)||new Set(inputs.map(x=>x.sourcePath)).size!==inputs.length)throw Error('Inputs must exactly match unique pinned source order');
  const manifest=buildReviewedManifest([baseline]).manifestHash;if(manifest!==plan.baseline.manifestHash)throw Error('Baseline manifest pin mismatch');
  const bindings:CatalogUpdateBinding[]=[];const rawSourceDigests=inputs.map((x,i)=>{const digest=canonicalSourceSha256(x.document);if(digest!==plan.sources[i].canonicalSha256)throw Error(`Source digest mismatch: ${x.sourcePath}`);bindings.push(...compileSourceSnapshotBindings(x.document,x.sourcePath));return {sourcePath:x.sourcePath,canonicalSha256:digest};});
  const keys=new Set<string>();for(const b of bindings){const key=`${b.sourcePath}:${b.familyId}:${b.familyVersion}:${b.chainId}:${b.contract}:${b.signature}`;if(keys.has(key))throw Error('Duplicate source candidate identity');keys.add(key);if(b.fn.status!=='inactive'||b.fn.provenance.status!=='candidate'||b.fn.executionScope)throw Error('Source candidate is not inactive and unscoped');}
  const index=new Map(bindings.map(b=>[`${b.sourcePath}:${b.familyId}:${b.familyVersion}:${b.chainId}:${b.contract}:${b.signature}:${b.selector}:${b.abiHash}`,b]));
  const admissionByKey=new Map<string,Admission>();const newSelectorKeys=new Set<string>();
  const oldFunctions=baseline.chains.flatMap(c=>c.contracts.flatMap(k=>k.functions.map(fn=>({chainId:c.chainId,contract:k.address,fn,selector:toFunctionSelector(fn.signature).toLowerCase()}))));
  for(const a of plan.admissions){const key=`${a.sourcePath}:${a.familyId}:${a.familyVersion}:${a.chainId}:${a.contract}:${a.signature}:${a.selector}:${a.abiHash}`,b=index.get(key);if(!b)throw Error('Admission does not exactly match source family/version, identity, ABI, and selector');
    const refs=b.sourceRefs;if(a.sourceRefs.length!==refs.length||a.sourceRefs.some((r,i)=>r!==refs[i])||a.authorityReview.sourceRefs.some(r=>!refs.includes(r)))throw Error('Admission or authority-review source refs do not match resolved source evidence');
    if(oldFunctions.some(o=>selectorKey({chainId:o.chainId,contract:o.contract,selector:o.selector})===selectorKey(a)))throw Error('Admission collides with an existing baseline selector');
    if(hasBytes(b.fn.abi)||b.fn.executionScope)throw Error('Generic ordinary updates reject byte-bearing ABI and scoped source functions');
     if(a.authorityReview.classification==='polymarket-pusd-restricted') {
       const sourceInput=inputs.find((input)=>input.sourcePath===a.sourcePath)!;
       const sourceDigest=rawSourceDigests.find((source)=>source.sourcePath===a.sourcePath)!.canonicalSha256;
       validatePolymarketPusdAdmission({familyId:a.familyId,familyVersion:a.familyVersion,chainId:a.chainId,contract:a.contract,signature:a.signature,selector:a.selector,abiHash:a.abiHash,capabilityId:a.capabilityId,scope:a.executionScope,scopeHash:a.executionScopeHash,fn:b.fn,sourcePath:a.sourcePath,sourceDigest,sourceDocument:sourceInput.document,sourceRefs:a.sourceRefs});
     }
    else if(a.executionScope!==null||a.executionScopeHash!==null||b.fn.signature===POLYMARKET_PUSD_WRAP_IDENTITY.signature&&b.fn.contract.toLowerCase()===POLYMARKET_PUSD_WRAP_IDENTITY.contract) throw Error('pUSD identity requires its exact restricted scoped admission');
    const sk=selectorKey(a);if(newSelectorKeys.has(sk))throw Error('Two new admissions collide at one chain/contract selector');newSelectorKeys.add(sk);
    if(admissionByKey.has(key))throw Error('A source candidate may be admitted exactly once');admissionByKey.set(key,a);
  }
  for(const d of plan.deactivations){const old=oldFunctions.find(o=>o.fn.capabilityId===d.capabilityId);if(!old||fullCatalogFunctionSha256(old.fn)!==d.expectedFullObjectSha256)throw Error('Deactivation does not bind the exact full baseline function object');}
   const makeCatalog=(active:boolean)=>{const chains=baseline.chains.map(c=>({...c,contracts:c.contracts.map(k=>({...k,functions:[...k.functions]}))}));for(const b of bindings){const key=`${b.sourcePath}:${b.familyId}:${b.familyVersion}:${b.chainId}:${b.contract}:${b.signature}:${b.selector}:${b.abiHash}`,a=active?admissionByKey.get(key):undefined;if(active&&!a)continue;const fn=active&&a?{...b.fn,capabilityId:a.capabilityId,status:'active' as const,provenance:{...b.fn.provenance,status:'verified' as const},inactiveReason:undefined,executionScope:a.executionScope??undefined}:b.fn;let chain=chains.find(c=>c.chainId===b.chainId);if(!chain){chain={chainId:b.chainId,status:active&&a?'active':'inactive',contracts:[]};chains.push(chain);}let contract=chain.contracts.find(k=>k.address.toLowerCase()===b.contract);if(!contract){contract={address:b.contract,status:active&&a?'active':'inactive',functions:[]};chain.contracts.push(contract);}contract.functions.push(fn);}return validateCatalogDocument({schemaVersion:1,chains});};
  const projectedCatalog=makeCatalog(true);
  assertBaselinePreserved(projectedCatalog,{schemaVersion:1,baselineManifestHash:manifest,chains:baseline.chains});
  const previewCatalog=makeCatalog(false);
  return {candidates:bindings.map(b=>({...b,admitted:admissionByKey.has(`${b.sourcePath}:${b.familyId}:${b.familyVersion}:${b.chainId}:${b.contract}:${b.signature}:${b.selector}:${b.abiHash}`)})),previewCatalog,projectedCatalog,diff:catalogDiff(baseline,previewCatalog),projectedDiff:catalogDiff(baseline,projectedCatalog),sourceDigests:rawSourceDigests,deactivationProposals:plan.deactivations.map(d=>({...d,status:'proposed-inactive' as const}))};
}

export function assembleCatalogUpdate(baseline:DefiRegistryFragment,planValue:unknown,inputs:readonly {sourcePath:string;document:unknown}[],baselineRawSha256:string):DefiRegistryFragment {if(validateUpdatePlan(planValue).deactivations.length)throw Error('Applying deactivations is deferred');return prepareCatalogUpdate(baseline,planValue,inputs,baselineRawSha256).projectedCatalog;}
