import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { createCaliburDeploymentResolver } from './calibur-deployment';

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
    const rpc = client(1, getCode);

    await expect(resolve(1, rpc)).resolves.toBe(second);
    await expect(resolve(1, rpc)).resolves.toBe(second);
    expect(getCode.mock.calls.map(([args]) => args.address)).toEqual([first, second]);
  });

  it('expires successful results at the five minute TTL', async () => {
    let now = 10;
    const getCode = vi.fn(async () => '0x1234' as const);
    const resolve = createCaliburDeploymentResolver([first], 300_000, () => now);
    const rpc = client(1, getCode);
    await resolve(1, rpc);
    now += 299_999;
    await resolve(1, rpc);
    expect(getCode).toHaveBeenCalledTimes(1);
    now += 1;
    await resolve(1, rpc);
    expect(getCode).toHaveBeenCalledTimes(2);
  });

  it('isolates cache by chain id and rejects a mismatched RPC client', async () => {
    const getCode = vi.fn(async () => '0xabcd' as const);
    const resolve = createCaliburDeploymentResolver([first]);
    await resolve(1, client(1, getCode));
    await resolve(2, client(2, getCode));
    expect(getCode).toHaveBeenCalledTimes(2);
    await expect(resolve(3, client(4, getCode))).rejects.toThrow(/does not match/);
    expect(getCode).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent resolution for a chain', async () => {
    let finish!: (code: `0x${string}`) => void;
    const getCode = vi.fn(() => new Promise<`0x${string}`>((resolve) => { finish = resolve; }));
    const resolve = createCaliburDeploymentResolver([first]);
    const rpc = client(1, getCode);
    const a = resolve(1, rpc);
    const b = resolve(1, rpc);
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
    const rpc = client(1, getCode);
    await expect(resolve(1, rpc)).rejects.toThrow('offline');
    await expect(resolve(1, rpc)).resolves.toBeNull();
    await expect(resolve(1, rpc)).resolves.toBe(first);
    expect(getCode).toHaveBeenCalledTimes(3);
  });
});
