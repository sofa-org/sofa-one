import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { createCaliburDeploymentResolver } from './calibur-deployment';
import { CALIBUR_ADDRESS, LEGACY_CALIBUR_ADDRESS } from './calibur';

const first = '0x0000000000000000000000000000000000000001' as Address;
const second = '0x0000000000000000000000000000000000000002' as Address;
const third = '0x0000000000000000000000000000000000000003' as Address;

function client(chainId: number, getCode: (args: { address: Address }) => Promise<`0x${string}` | undefined>) {
  return { chain: { id: chainId }, getCode };
}

describe('Calibur deployment resolver', () => {
  it('preserves address order and caches a successful result per chain', async () => {
    const getCode = vi.fn(async ({ address }: { address: Address }) => address === second ? '0x1234' as const : '0x');
    const resolve = createCaliburDeploymentResolver([first, second, third]);
    const rpc = client(31337, getCode);

    await expect(resolve(31337, rpc)).resolves.toBe(second);
    await expect(resolve(31337, rpc)).resolves.toBe(second);
    expect(getCode.mock.calls.map(([args]) => args.address)).toEqual([first, second]);
  });

  it('expires successful results at the five minute TTL', async () => {
    let now = 10;
    const getCode = vi.fn(async () => '0x1234' as const);
    const resolve = createCaliburDeploymentResolver([first], 300_000, () => now);
    const rpc = client(31337, getCode);
    await resolve(31337, rpc);
    now += 299_999;
    await resolve(31337, rpc);
    expect(getCode).toHaveBeenCalledTimes(1);
    now += 1;
    await resolve(31337, rpc);
    expect(getCode).toHaveBeenCalledTimes(2);
  });

  it('isolates cache by chain id and rejects a mismatched RPC client', async () => {
    const getCode = vi.fn(async () => '0xabcd' as const);
    const resolve = createCaliburDeploymentResolver([first]);
    await resolve(31337, client(31337, getCode));
    await resolve(31338, client(31338, getCode));
    expect(getCode).toHaveBeenCalledTimes(2);
    await expect(resolve(31339, client(31340, getCode))).rejects.toThrow(/does not match/);
    expect(getCode).toHaveBeenCalledTimes(2);
  });

  it.each([
    [1, CALIBUR_ADDRESS], [8453, CALIBUR_ADDRESS], [11155111, CALIBUR_ADDRESS],
    [42161, CALIBUR_ADDRESS], [10, CALIBUR_ADDRESS], [56, CALIBUR_ADDRESS],
    [143, CALIBUR_ADDRESS], [137, CALIBUR_ADDRESS], [10143, CALIBUR_ADDRESS],
    [84532, LEGACY_CALIBUR_ADDRESS], [80002, LEGACY_CALIBUR_ADDRESS],
    [11155420, LEGACY_CALIBUR_ADDRESS],
  ])('uses trusted deployment on chain %s without an RPC probe', async (chainId, expected) => {
    const getCode = vi.fn(async () => { throw new Error('unexpected RPC scan'); });
    const resolve = createCaliburDeploymentResolver([first]);
    await expect(resolve(chainId as number, client(chainId as number, getCode))).resolves.toBe(expected);
    expect(getCode).not.toHaveBeenCalled();
  });

  it('rejects a mismatched client before resolving a mapped chain', async () => {
    const getCode = vi.fn(async () => { throw new Error('unexpected RPC scan'); });
    const resolve = createCaliburDeploymentResolver([first]);
    await expect(resolve(137, client(1, getCode))).rejects.toThrow(/does not match/);
    expect(getCode).not.toHaveBeenCalled();
  });

  it('keeps Polygon Amoy untrusted and scans without caching an undeployed result', async () => {
    const getCode = vi.fn().mockResolvedValue('0x');
    const resolve = createCaliburDeploymentResolver([first, second]);
    await expect(resolve(97, client(97, getCode))).resolves.toBeNull();
    await expect(resolve(97, client(97, getCode))).resolves.toBeNull();
    expect(getCode.mock.calls.map(([args]) => args.address)).toEqual([first, second, first, second]);
  });

  it('coalesces concurrent resolution for a chain', async () => {
    let finish!: (code: `0x${string}`) => void;
    const getCode = vi.fn(() => new Promise<`0x${string}`>((resolve) => { finish = resolve; }));
    const resolve = createCaliburDeploymentResolver([first]);
    const rpc = client(31337, getCode);
    const a = resolve(31337, rpc);
    const b = resolve(31337, rpc);
    await vi.waitFor(() => expect(getCode).toHaveBeenCalledTimes(1));
    finish('0x1234');
    await expect(Promise.all([a, b])).resolves.toEqual([first, first]);
  });

  it('does not cache RPC failures or an undeployed result', async () => {
    const getCode = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('0x')
      .mockResolvedValueOnce('0x1234');
    const resolve = createCaliburDeploymentResolver([first]);
    const rpc = client(31337, getCode);
    await expect(resolve(31337, rpc)).rejects.toThrow('offline');
    await expect(resolve(31337, rpc)).resolves.toBeNull();
    await expect(resolve(31337, rpc)).resolves.toBe(first);
    expect(getCode).toHaveBeenCalledTimes(3);
  });
});
