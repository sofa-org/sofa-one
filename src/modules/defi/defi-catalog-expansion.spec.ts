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
const BATCH_ADMISSIONS = [
  {
    chainId: 8453,
    address: '0xF03D133627364E5eDDaB8134faB3A030cf7b3020',
    protocol: 'SmarDex',
    source: 'SmarDex-Dev/smart-contracts/7ab2beb2afe0e5703c06dfd6eb6bf904c63dc72e',
    functions: [
      {
        signature: 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
        capabilityId: 'smardex:8453:0xf03d133627364e5eddab8134fab3a030cf7b3020:swapExactTokensForTokens',
        abiHash: '0x8c68788f5f1b08e8de02df3ecb51eabecf0b3c96370b02574fd384f9254e3ca6',
        selector: '0x38ed1739',
        mutability: 'nonpayable',
      },
    ],
  },
  {
    chainId: 42161,
    address: '0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41',
    protocol: 'GMX',
    source: 'gmx-io/gmx-synthetics/blob/a85ea3491c19c93bb4b5a002d9b358fb769b7849/deployments/arbitrum/ExchangeRouter.json',
    functions: [
      {
        signature: 'cancelOrder(bytes32)',
        capabilityId: 'gmx:arbitrum-exchange-router-v1:42161:0x1c3fa76e6e1088bce750f23a5bfcffa1efef6a41:cancelOrder',
        abiHash: '0xcb14e40a74bf26986c52a9aa0f61a7fbac73dfec5efa1f429c266dcc1a2eb91a',
        selector: '0x7489ec23',
        mutability: 'payable',
      },
      {
        signature: 'claimFundingFees(address[],address[],address)',
        capabilityId: 'gmx:arbitrum-exchange-router-v1:42161:0x1c3fa76e6e1088bce750f23a5bfcffa1efef6a41:claimFundingFees',
        abiHash: '0x4e75506be86c5b8428095dfdecce8e683fb9cfbfefd26b2422254c3fb818359c',
        selector: '0xc41b1ab3',
        mutability: 'payable',
      },
      {
        signature: 'claimCollateral(address[],address[],uint256[],address)',
        capabilityId: 'gmx:arbitrum-exchange-router-v1:42161:0x1c3fa76e6e1088bce750f23a5bfcffa1efef6a41:claimCollateral',
        abiHash: '0x4efdf3ec012f92132fabd8c0f1029df80704a80a6c799280e82c7cb6bb5bc457',
        selector: '0xe9249b57',
        mutability: 'payable',
      },
    ],
  },
] as const;

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

  it('binds the SmarDex and GMX admissions to their exact methods, ABI hashes, selectors and pinned sources', () => {
    for (const expected of BATCH_ADMISSIONS) {
      const contract = GENERATED_DEFI_REGISTRY.chains.find(({ chainId }) => chainId === expected.chainId)?.contracts.find(({ address }) => address === expected.address);
      expect(contract).toBeDefined();
      expect(contract!.functions.map(({ signature }) => signature).sort()).toEqual(expected.functions.map(({ signature }) => signature).sort());
      for (const reviewed of expected.functions) {
        const fn = contract!.functions.find(({ signature }) => signature === reviewed.signature)!;
        expect(fn).toMatchObject({
          chainId: expected.chainId,
          contract: expected.address,
          protocol: expected.protocol,
          capabilityId: reviewed.capabilityId,
          signature: reviewed.signature,
          abiHash: reviewed.abiHash,
          status: 'active',
          provenance: { status: 'verified' },
          abi: { stateMutability: reviewed.mutability },
        });
        expect(fn.provenance.sourceRef).toContain(expected.source);
        expect(functionAbiHash(fn)).toBe(reviewed.abiHash);
        expect(toFunctionSelector(fn.signature)).toBe(reviewed.selector);
      }
    }
  });

  it('round-trips every new typed entry point and excludes duplicate tuples and unsafe router surfaces', () => {
    const address1 = '0x0000000000000000000000000000000000000001';
    const args: Record<string, readonly unknown[]> = {
      swapExactTokensForTokens: [10n, 9n, [address1], address1, 1_900_000_000n],
      cancelOrder: [`0x${'11'.repeat(32)}`],
      claimFundingFees: [[address1], [address1], address1],
      claimCollateral: [[address1], [address1], [1n], address1],
    };
    const admitted = BATCH_ADMISSIONS.flatMap(({ chainId, address, functions }) => {
      const contract = GENERATED_DEFI_REGISTRY.chains.find((chain) => chain.chainId === chainId)?.contracts.find((item) => item.address === address);
      if (!contract) throw new Error(`Missing admitted contract ${chainId}:${address}`);
      return functions.map(({ signature }) => contract.functions.find((fn) => fn.signature === signature)!);
    });
    for (const fn of admitted) {
      const data = encodeFunctionData({ abi: [fn.abi], functionName: fn.functionName as never, args: args[fn.functionName] as never });
      expect(decodeFunctionData({ abi: [fn.abi], data })).toMatchObject({ functionName: fn.functionName, args: args[fn.functionName] });
    }
    const dexFunctions = GENERATED_DEFI_REGISTRY.chains.find(({ chainId }) => chainId === 8453)!.contracts.find(({ address }) => address === BATCH_ADMISSIONS[0].address)!.functions;
    const gmxFunctions = GENERATED_DEFI_REGISTRY.chains.find(({ chainId }) => chainId === 42161)!.contracts.find(({ address }) => address === BATCH_ADMISSIONS[1].address)!.functions;
    expect(dexFunctions.map(({ functionName }) => functionName)).toEqual(['swapExactTokensForTokens']);
    expect(gmxFunctions.map(({ functionName }) => functionName).sort()).toEqual(['cancelOrder', 'claimCollateral', 'claimFundingFees']);
    expect([...dexFunctions, ...gmxFunctions].map(({ functionName }) => functionName).some((name) => /multicall|makeExternalCalls|execute|sendTokens|set[A-Z]/i.test(name))).toBe(false);

    const catalogFunctions = GENERATED_DEFI_REGISTRY.chains.flatMap(({ chainId, contracts }) => contracts.flatMap(({ address, functions }) => functions.map((fn) => `${chainId}:${address.toLowerCase()}:${fn.signature}`)));
    expect(new Set(catalogFunctions).size).toBe(catalogFunctions.length);
    const capabilityIds = GENERATED_DEFI_REGISTRY.chains.flatMap(({ contracts }) => contracts.flatMap(({ functions }) => functions.map(({ capabilityId }) => capabilityId)));
    expect(new Set(capabilityIds).size).toBe(capabilityIds.length);
  });
});
