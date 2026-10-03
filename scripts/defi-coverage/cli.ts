import { readFile, writeFile } from 'node:fs/promises';
import { computeCoverage } from '../../src/modules/defi/coverage-tooling/calculator';
import { isCoverageReportCurrent, parseCoverageCliArgs, serializeCoverageReport } from '../../src/modules/defi/coverage-tooling/cli-helpers';
import type { CoverageInput, CoverageManifestCapability } from '../../src/modules/defi/coverage-tooling/types';

async function main(args: readonly string[]): Promise<number> {
  try {
    const options = parseCoverageCliArgs(args);
    const [inputText, manifestText] = await Promise.all([readFile(options.inputPath, 'utf8'), readFile(options.manifestPath, 'utf8')]);
    const input = JSON.parse(inputText) as CoverageInput;
    const manifestValue = JSON.parse(manifestText) as { capabilities?: CoverageManifestCapability[] } | CoverageManifestCapability[];
    const capabilities = Array.isArray(manifestValue) ? manifestValue : manifestValue.capabilities;
    if (!capabilities) throw new Error('Manifest JSON must be an array or an object with a capabilities array');
    const serialized = serializeCoverageReport(computeCoverage(input, capabilities));
    if (options.checkPath) {
      const existing = await readFile(options.checkPath, 'utf8');
      if (!isCoverageReportCurrent(serialized, existing)) {
        process.stderr.write(`Coverage report is stale: ${options.checkPath}\n`);
        return 1;
      }
      process.stdout.write('Coverage report is current.\n');
      return 0;
    }
    if (options.outputPath) await writeFile(options.outputPath, serialized, 'utf8');
    else process.stdout.write(serialized);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
