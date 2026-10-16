import { decodeFunctionData, encodeFunctionData, toFunctionSelector } from 'viem';
import { GENERATED_DEFI_REGISTRY } from './registry/generated/production-catalog';
import { functionAbiHash } from './registry/defi-manifest';

const CASES = [
  {
    address: '0x66017d22b0f8556afdd19fc67041899eb65a21bb',
    protocol: 'liquity-v1-stability-pool',
    signatures: ['provideToSP(uint256,address)', 'withdrawFromSP(uint256)'],
    source: 'github.com/liquity/dev/blob/f79fc03f70b6b482b496d09fe5ba80d48f74a06b',
  },
  {
    address: '0x50bd66d59911f5e086ec87ae43c811e0d059dd11',
    protocol: 'k3-sbold',
    signatures: ['deposit(uint256,address)', 'redeem(uint256,address,address)', 'withdraw(uint256,address,address)'],
    source: 'docs.liquity.org/v2-faq/bold-and-earn',
  },
] as const;
const SELECTORS: Record<string, string> = {
  'provideToSP(uint256,address)': '0x5f788d65',
  'withdrawFromSP(uint256)': '0x2e54bf95',
  'deposit(uint256,address)': '0x6e553f65',
  'withdraw(uint256,address,address)': '0xb460af94',
  'redeem(uint256,address,address)': '0xba087652',
};

describe('focused DeFi catalog expansion admissions', () => {
  const contracts = CASES.map(({ address }) => {
    const contract = GENERATED_DEFI_REGISTRY.chains.find(({ chainId }) => chainId === 1)?.contracts.find((item) => item.address === address);
    expect(contract).toBeDefined();
    return contract!;
  });

  it('binds only the reviewed exact deployed functions and their fixed ABI hashes/selectors', () => {
    CASES.forEach((expected, index) => {
      const functions = contracts[index].functions;
      expect(functions.map(({ signature }) => signature).sort()).toEqual([...expected.signatures].sort());
      for (const fn of functions) {
        expect(fn).toMatchObject({
          chainId: 1,
          contract: expected.address,
          capabilityId: `${expected.protocol}:1:${expected.address}:${fn.functionName}`,
          status: 'active',
          provenance: { status: 'verified' },
          abi: { stateMutability: 'nonpayable' },
        });
        expect(fn.provenance.sourceRef).toContain(expected.source);
        expect(fn.abiHash).toBe(functionAbiHash(fn));
        expect(toFunctionSelector(fn.signature)).toBe(SELECTORS[fn.signature]);
      }
    });
  });

  it('canonical-encodes and decodes each admitted function and excludes sensitive entry points', () => {
    const args: Record<string, readonly unknown[]> = {
      provideToSP: [123n, '0x0000000000000000000000000000000000000001'],
      withdrawFromSP: [123n],
      deposit: [123n, '0x0000000000000000000000000000000000000001'],
      redeem: [123n, '0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
      withdraw: [123n, '0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002'],
    };
    const admitted = contracts.flatMap(({ functions }) => functions);
    for (const fn of admitted) {
      const encoded = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName as never, args: args[fn.functionName] as never });
      expect(decodeFunctionData({ abi: [fn.abi], data: encoded }).functionName).toBe(fn.functionName);
    }
    expect(admitted.map(({ functionName }) => functionName).sort()).toEqual(['deposit', 'provideToSP', 'redeem', 'withdraw', 'withdrawFromSP']);
    expect(admitted.every(({ abi }) => abi.stateMutability === 'nonpayable')).toBe(true);
    expect(admitted.map(({ functionName }) => functionName).some((name) => /admin|owner|upgrade|execute|multicall|rescue|sweep|set/i.test(name))).toBe(false);
    expect(admitted.find(({ protocol }) => protocol === 'k3-sbold')?.warnings?.join(' ')).toContain('third-party');
    const liquityWarning = admitted.find(({ protocol }) => protocol === 'liquity-v1-stability-pool')?.warnings?.join(' ');
    expect(liquityWarning).toContain('LUSD');
    expect(liquityWarning).toContain('liquidations');
    expect(liquityWarning).not.toContain('BOLD');
  });
});
