import { toFunctionSelector } from 'viem';
import { buildDexRegistry } from './index';

describe('DEX function catalog', () => {
  it('contains 12 verified active functions with the correct immutable tuple variants', () => {
    const chains = buildDexRegistry().chains;
    const functions = chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
    expect(functions).toHaveLength(12);
    expect(functions.every((fn) => fn.status === 'active' && fn.provenance.status === 'verified')).toBe(true);
    expect(functions.filter((fn) => fn.protocol === 'uniswap-v3')).toHaveLength(4);
    expect(functions.filter((fn) => fn.protocol === 'uniswap-v3-router02')).toHaveLength(7);
    expect(functions.filter((fn) => fn.protocol === 'pancakeswap-v3')).toHaveLength(1);
    const original = functions.find((fn) => fn.protocol === 'uniswap-v3')!;
    const router02 = functions.find((fn) => fn.protocol === 'uniswap-v3-router02')!;
    const pancake = functions.find((fn) => fn.protocol === 'pancakeswap-v3')!;
    expect(original.signature).toBe('exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))');
    expect(router02.signature).toBe('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))');
    expect(pancake.signature).toBe(original.signature);
    expect(original.abi.stateMutability).toBe('payable');
  });

  it('preserves capability identities and has no duplicate selectors per contract', () => {
    const functions = buildDexRegistry().chains.flatMap((chain) => chain.contracts.flatMap((contract) => contract.functions));
    expect(functions.find((fn) => fn.chainId === 1 && fn.protocol === 'uniswap-v3')?.capabilityId)
      .toBe('uniswap-v3:v3:1:0xe592427a0aece92de3edee1f18e0157c05861564:exact-input-single');
    const keys = functions.map((fn) => `${fn.chainId}:${fn.contract.toLowerCase()}:${toFunctionSelector(fn.signature)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
