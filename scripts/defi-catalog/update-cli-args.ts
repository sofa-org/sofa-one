export type UpdateMode = 'update-preview' | 'update-build' | 'generate' | 'check' | 'diff';

export interface ParsedUpdateArgs {
  planPath: string;
  write: boolean;
}

const PLAN_PATH = /^data\/defi-catalog\/updates\/[a-z0-9]+(?:-[a-z0-9]+)*\/plan\.json$/;

/** Parse only the fixed generic-update argument vocabulary; no caller-selected output paths. */
export function parseUpdateArgs(mode: UpdateMode, args: readonly string[]): ParsedUpdateArgs {
  let planPath: string | undefined;
  let write = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--plan' && planPath === undefined && index + 1 < args.length) {
      planPath = args[++index];
      continue;
    }
    if (arg === '--write' && mode === 'update-build' && !write) {
      write = true;
      continue;
    }
    throw new Error('Generic plan commands accept only one --plan and update-build --write');
  }
  if (!planPath || !PLAN_PATH.test(planPath)) throw new Error('Plan must be a fixed repository update plan path');
  return { planPath, write };
}
