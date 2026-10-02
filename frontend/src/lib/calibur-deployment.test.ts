import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { resolveCaliburDeployment } from './calibur-deployment';
import { CALIBUR_ADDRESS, CALIBUR_ADDRESSES, LEGACY_CALIBUR_ADDRESS } from './calibur';

function client(chainId: number, getCode: (args: { address: Address }) => Promise<`0x${string}` | undefined>) {
  return { chain: { id: chainId }, getCode };
}

describe('Calibur deployment resolver', () => {
  it('probes candidates sequentially and returns the first deployed address', async () => {
    const getCode = vi.fn(async ({ address }: { address: Address }) => address === CALIBUR_ADDRESSES[1] ? '0x1234' as const : '0x');
    const rpc = client(31337, getCode);

    await expect(resolveCaliburDeployment(31337, rpc)).resolves.toBe(CALIBUR_ADDRESSES[1]);
    expect(getCode.mock.calls.map(([args]) => args.address)).toEqual(CALIBUR_ADDRESSES.slice(0, 2));
  });

  it('resolves each chain independently and rejects a mismatched RPC client', async () => {
    const getCode = vi.fn(async () => '0xabcd' as const);
    await resolveCaliburDeployment(31337, client(31337, getCode));
    await resolveCaliburDeployment(31338, client(31338, getCode));
    expect(getCode).toHaveBeenCalledTimes(2);
    await expect(resolveCaliburDeployment(31339, client(31340, getCode))).rejects.toThrow(/does not match/);
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
    await expect(resolveCaliburDeployment(chainId as number, client(chainId as number, getCode))).resolves.toBe(expected);
    expect(getCode).not.toHaveBeenCalled();
  });

  it('rejects a mismatched client before resolving a mapped chain', async () => {
    const getCode = vi.fn(async () => { throw new Error('unexpected RPC scan'); });
    await expect(resolveCaliburDeployment(137, client(1, getCode))).rejects.toThrow(/does not match/);
    expect(getCode).not.toHaveBeenCalled();
  });

  it('keeps BSC Testnet untrusted and sequentially scans without deployment', async () => {
    const getCode = vi.fn().mockResolvedValue('0x');
    await expect(resolveCaliburDeployment(97, client(97, getCode))).resolves.toBeNull();
    await expect(resolveCaliburDeployment(97, client(97, getCode))).resolves.toBeNull();
    expect(getCode.mock.calls.map(([args]) => args.address)).toEqual([...CALIBUR_ADDRESSES, ...CALIBUR_ADDRESSES]);
  });

  it('retries after RPC failures and continues past undeployed candidates', async () => {
    const getCode = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('0x')
      .mockResolvedValueOnce('0x')
      .mockResolvedValueOnce('0x1234');
    const rpc = client(31337, getCode);
    await expect(resolveCaliburDeployment(31337, rpc)).rejects.toThrow('offline');
    await expect(resolveCaliburDeployment(31337, rpc)).resolves.toBeNull();
    await expect(resolveCaliburDeployment(31337, rpc)).resolves.toBe(CALIBUR_ADDRESSES[0]);
    expect(getCode).toHaveBeenCalledTimes(4);
  });
});
