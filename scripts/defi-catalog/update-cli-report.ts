import type { CatalogUpdatePlan } from '../../src/modules/defi/catalog-tooling/catalog-update';

type PreparedUpdate = ReturnType<typeof import('../../src/modules/defi/catalog-tooling/catalog-update').prepareCatalogUpdate>;

function identity(x:{sourcePath:string;familyId:string;familyVersion:string;chainId:number;contract:string;signature:string;selector:string;abiHash:string}):string {
  return [x.sourcePath,x.familyId,x.familyVersion,x.chainId,x.contract.toLowerCase(),x.signature,x.selector.toLowerCase(),x.abiHash].join('\u0000');
}

/** Shape the CLI report without conflating inactive source candidates with active projected admissions. */
export function createCatalogUpdateCliReport(prepared:PreparedUpdate,plan:CatalogUpdatePlan,baselineDefinitions:number) {
  const admissions=new Map(plan.admissions.map(a=>[identity(a),a]));
  const candidates=prepared.candidates.map(candidate=>{
    if(candidate.fn.status!=='inactive')throw new Error('CLI preview candidates must remain inactive');
    const admission=admissions.get(identity(candidate));
    if(Boolean(admission)!==candidate.admitted)throw new Error('Prepared candidate admission mapping is inconsistent');
    return {
      sourcePath:candidate.sourcePath,familyId:candidate.familyId,familyVersion:candidate.familyVersion,
      chainId:candidate.chainId,contract:candidate.contract,signature:candidate.signature,selector:candidate.selector,
      abiHash:candidate.abiHash,sourceRefs:candidate.sourceRefs,status:candidate.fn.status,
      candidateCapabilityId:candidate.fn.capabilityId,admitted:Boolean(admission),projectedCapabilityId:admission?.capabilityId??null,
    };
  });
  if(admissions.size!==prepared.candidates.filter(c=>c.admitted).length)throw new Error('An admission did not resolve to one preview candidate');
  const count=(catalog:PreparedUpdate['previewCatalog'])=>catalog.chains.reduce((n,c)=>n+c.contracts.reduce((m,k)=>m+k.functions.length,0),0);
  return {
    candidates,
    previewDiff:prepared.diff,
    projectedDiff:prepared.projectedDiff,
    sourceDigests:prepared.sourceDigests,
    counts:{candidates:candidates.length,admissions:plan.admissions.length,deactivations:prepared.deactivationProposals.length,baselineDefinitions,candidatePreviewDefinitions:count(prepared.previewCatalog),admittedProjectionDefinitions:count(prepared.projectedCatalog)},
    deactivations:prepared.deactivationProposals,
    writePerformed:false as const,
  };
}
