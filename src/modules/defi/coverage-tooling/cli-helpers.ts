export type CoverageCliOptions = Readonly<{ inputPath: string; manifestPath: string; outputPath?: string; checkPath?: string }>;

export function parseCoverageCliArgs(args: readonly string[]): CoverageCliOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--input', '--manifest', '--output', '--check'].includes(key)) throw new Error(`Unknown argument: ${key}`);
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    values.set(key, value);
  }
  const inputPath = values.get('--input');
  const manifestPath = values.get('--manifest');
  const outputPath = values.get('--output');
  const checkPath = values.get('--check');
  if (!inputPath || !manifestPath) throw new Error('Required: --input <normalized-v1.json> --manifest <manifest.json>');
  if (outputPath && checkPath) throw new Error('Use either --output or --check, not both');
  return { inputPath, manifestPath, ...(outputPath ? { outputPath } : {}), ...(checkPath ? { checkPath } : {}) };
}

export function serializeCoverageReport(report: unknown): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function isCoverageReportCurrent(expected: string, existing: string): boolean {
  return expected === existing;
}
