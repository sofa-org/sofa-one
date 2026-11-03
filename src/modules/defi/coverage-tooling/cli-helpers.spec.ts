import { isCoverageReportCurrent, parseCoverageCliArgs, serializeCoverageReport } from './cli-helpers';

describe('coverage CLI helpers', () => {
  it('parses deterministic local input/manifest/report arguments', () => {
    expect(parseCoverageCliArgs(['--input', 'universe.json', '--manifest', 'manifest.json', '--output', 'report.json'])).toEqual({ inputPath: 'universe.json', manifestPath: 'manifest.json', outputPath: 'report.json' });
    expect(parseCoverageCliArgs(['--input', 'u', '--manifest', 'm', '--check', 'r'])).toEqual({ inputPath: 'u', manifestPath: 'm', checkPath: 'r' });
  });

  it('rejects ambiguous and unknown flags and checks reports byte-for-byte', () => {
    expect(() => parseCoverageCliArgs(['--input', 'u', '--manifest', 'm', '--check', 'r', '--output', 'o'])).toThrow('either --output or --check');
    expect(() => parseCoverageCliArgs(['--input', 'u', '--input', 'x', '--manifest', 'm'])).toThrow('Duplicate argument');
    expect(() => parseCoverageCliArgs(['--input', 'u', '--manifest', 'm', '--network'])).toThrow('Unknown argument');
    const serialized = serializeCoverageReport({ a: 1, b: ['x'] });
    expect(serialized).toBe('{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}\n');
    expect(isCoverageReportCurrent(serialized, serialized)).toBe(true);
    expect(isCoverageReportCurrent(serialized, serialized.trimEnd())).toBe(false);
  });
});
