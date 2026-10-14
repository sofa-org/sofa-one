import { ChildProcess } from 'node:child_process';
import { assertLocalEndpoint, assertReadonlyMethod } from '../scripts/defi-fork-verifier';

describe('fork verifier safety guard', () => {
  const child = (pid: number | undefined, exitCode: number | null) => ({ pid, exitCode } as ChildProcess);
  it('rejects remote URLs, arbitrary hosts and malformed ports', () => {
    for (const url of ['https://127.0.0.1:8545', 'http://localhost:8545', 'http://192.168.1.4:8545', 'http://127.0.0.1:abc']) {
      expect(() => assertLocalEndpoint(url, child(123, null), 34567)).toThrow();
    }
  });
  it('requires a live process it owns and a local endpoint', () => {
    expect(() => assertLocalEndpoint('http://127.0.0.1:34567', child(undefined, null), 34567)).toThrow();
    expect(() => assertLocalEndpoint('http://127.0.0.1:34567', child(123, 1), 34567)).toThrow();
    expect(() => assertLocalEndpoint('http://127.0.0.1:34567', child(123, null), 34567)).not.toThrow();
    expect(() => assertLocalEndpoint('http://127.0.0.1:34568', child(123, null), 34567)).toThrow();
  });
  it('rejects every non-read source method and arbitrary local write method', () => {
    expect(() => assertReadonlyMethod('eth_sendTransaction', true)).toThrow();
    expect(() => assertReadonlyMethod('anvil_setCode', true)).toThrow();
    expect(() => assertReadonlyMethod('debug_traceTransaction', true)).toThrow();
    expect(() => assertReadonlyMethod('eth_sendRawTransaction')).toThrow();
    expect(() => assertReadonlyMethod('anvil_setBalance', true)).toThrow();
    expect(() => assertReadonlyMethod('anvil_setBalance')).not.toThrow();
    expect(() => assertReadonlyMethod('debug_traceTransaction')).not.toThrow();
    expect(() => assertReadonlyMethod('eth_call', true)).not.toThrow();
  });
});
