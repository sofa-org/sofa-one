import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { assertUpdateRepositoryFile } from './update-cli-files';
import { parseUpdateArgs } from './update-cli-args';

const CURRENT_POINTER_PATH='data/defi-catalog/updates/current.json';
const PLAN_PATH=/^data\/defi-catalog\/updates\/[a-z0-9]+(?:-[a-z0-9]+)*\/plan\.json$/;
type CurrentPointer=Readonly<{schemaVersion:1;planPath:string;planRawSha256:string}>;

/** Read the optional tooling-only current-plan pointer, failing closed unless it is genuinely absent. */
export function loadCurrentCatalogUpdate(root:string):string|undefined {
  const pointerFile=assertUpdateRepositoryFile(root,CURRENT_POINTER_PATH,true);
  try { lstatSync(pointerFile); }
  catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error; }
  const bytes=readFileSync(pointerFile);
  let value:unknown;
  try { value=JSON.parse(bytes.toString('utf8')) as unknown; } catch(error) { throw new Error(`Invalid current catalog-update pointer JSON: ${(error as Error).message}`); }
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Current catalog-update pointer must be an object');
  const pointer=value as Record<string,unknown>;
  if(Object.keys(pointer).sort().join(',')!=='planPath,planRawSha256,schemaVersion'||pointer.schemaVersion!==1||typeof pointer.planPath!=='string'||!PLAN_PATH.test(pointer.planPath)||typeof pointer.planRawSha256!=='string'||!/^[a-f0-9]{64}$/.test(pointer.planRawSha256))throw new Error('Current catalog-update pointer has unsupported fields or invalid pins');
  // Reuse the CLI parser's conservative path validation; no discovery or arbitrary path is accepted.
  parseUpdateArgs('generate',['--plan',pointer.planPath]);
  const planFile=assertUpdateRepositoryFile(root,pointer.planPath);
  const planBytes=readFileSync(planFile);
  if(createHash('sha256').update(planBytes).digest('hex')!==pointer.planRawSha256)throw new Error('Current catalog-update pointer raw plan digest mismatch');
  return pointer.planPath;
}

/** Use the current pointer only for truly bare generate/check/diff invocations. */
export function selectBareCatalogUpdateArgs(root:string,args:readonly string[]):readonly string[] {
  if(args.length!==1||!['generate','check','diff'].includes(args[0]))return args;
  const planPath=loadCurrentCatalogUpdate(root);
  return planPath?[args[0],'--plan',planPath]:args;
}

/** True only when check reached the legacy v9 path through bare-command fallback. */
export function isBareLegacyV9Check(originalArgs:readonly string[]):boolean {
  return originalArgs.length===1&&originalArgs[0]==='check';
}
