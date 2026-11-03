import { encodeFunctionData } from 'viem';
import type { DefiInteraction } from '../defi.types';
import { decodePusdWrapCall, POLYMARKET_PUSD_WRAP_ABI, POLYMARKET_PUSD_WRAP_IDENTITY as identity } from './pusd-identity';

describe('decodePusdWrapCall', () => {
  const interaction = (asset: string = identity.asset, value?: string): DefiInteraction => ({
    to: identity.contract,
    data: encodeFunctionData({ abi: POLYMARKET_PUSD_WRAP_ABI, functionName: 'wrap', args: [asset as `0x${string}`, '0x0000000000000000000000000000000000000002', 123n] }),
    ...(value === undefined ? {} : { value }),
  });

  it('returns null only for a nonmatching chain, destination, or selector', () => {
    expect(decodePusdWrapCall(1, interaction())).toBeNull();
    expect(decodePusdWrapCall(137, { ...interaction(), to: '0x0000000000000000000000000000000000000001' })).toBeNull();
    expect(decodePusdWrapCall(137, { ...interaction(), data: '0xdeadbeef' })).toBeNull();
  });

  it('returns decoded canonical arguments and rejects invalid calldata, asset, and native value', () => {
    expect(decodePusdWrapCall(137, interaction())).toEqual({ asset: identity.asset, recipient: '0x0000000000000000000000000000000000000002', amount: 123n });
    expect(() => decodePusdWrapCall(137, { ...interaction(), data: `${interaction().data}00` })).toThrow();
    expect(() => decodePusdWrapCall(137, interaction('0x0000000000000000000000000000000000000001'))).toThrow();
    expect(() => decodePusdWrapCall(137, interaction(identity.asset, '1'))).toThrow();
  });
});
