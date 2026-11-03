import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionData } from 'viem';
import { GENERATED_DEFI_REGISTRY } from '../registry/generated/production-catalog';
import { functionAbiHash } from '../registry/defi-manifest';

const ADDRESSES = [
  '0x106825b71cce77a70b69f57a0acf9c4a6acf292a',
  '0x9c5d3c3abd633b8ea68c5a51325f8630dc620ad9',
] as const;
const EXPECTED = {
  burn: { signature: 'burn(uint256,uint256[2],uint256)', hash: '0xfea3ece2bf717d6d734a0ce48c345d1b1567c914043533b0692ac25a4a386d77' },
  burnBatch: { signature: 'burnBatch((uint256,uint256[2],uint256)[])', hash: '0x99e3f5520e0d37e50f4b089d170d52c7ad29afc16742d14c77d143c2e5589e8f' },
} as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

describe('SOFA SmartTrendVault redemption catalog admission', () => {
  const functions = ADDRESSES.map((address) => {
    const contract = GENERATED_DEFI_REGISTRY.chains.find((chain) => chain.chainId === 1)?.contracts.find((candidate) => candidate.address === address);
    expect(contract).toBeDefined();
    return contract!.functions;
  });

  it('admits only the exact verified nonpayable burn ABI fragments for both documented Ethereum proxies', () => {
    for (const contractFns of functions) {
      expect(contractFns.map(({ functionName }) => functionName).sort()).toEqual(['burn', 'burnBatch']);
      for (const fn of contractFns) {
        const expected = EXPECTED[fn.functionName as keyof typeof EXPECTED];
        expect(fn).toMatchObject({
          chainId: 1,
          status: 'active',
          provenance: { status: 'verified', sourceRef: 'https://etherscan.io/address/0x6E72C8726c71a4Cbc6e31ff7d47B399Fa983C7B8#code' },
          signature: expected.signature,
          abiHash: expected.hash,
          abi: { stateMutability: 'nonpayable' },
        });
        expect(functionAbiHash(fn)).toBe(expected.hash);
      }
    }
  });

  it('binds a content-hashed local ABI snapshot to the Etherscan implementation evidence', () => {
    const evidence = JSON.parse(readFileSync('data/defi-catalog/sources/sofa-smarttrend-vault-redeem.json', 'utf8'));
    const digest = createHash('sha256').update(canonical(evidence.abiSnapshot)).digest('hex');
    expect(evidence.abiSnapshotSha256).toBe(`sha256:${digest}`);
    expect(evidence.sources.find((source: { sourceId: string }) => source.sourceId === 'sofa-smarttrend-implementation-etherscan').url)
      .toBe('https://etherscan.io/address/0x6E72C8726c71a4Cbc6e31ff7d47B399Fa983C7B8#code');
    expect(evidence.contracts.map((contract: { address: string }) => contract.address).sort()).toEqual([...ADDRESSES].sort());
    expect(evidence.abiSnapshot.map((abi: { name: string }) => abi.name).sort()).toEqual(['burn', 'burnBatch']);
    for (const fn of functions.flat()) {
      expect(evidence.abiSnapshot.find((abi: { name: string }) => abi.name === fn.functionName)).toEqual(fn.abi);
    }
  });

  it('round-trips canonical single and batch redemption calldata and excludes payable entry points', () => {
    const burn = functions[0].find((fn) => fn.functionName === 'burn')!;
    const batch = functions[0].find((fn) => fn.functionName === 'burnBatch')!;
    const singleArgs = [1_800_000_000n, [2_000n, 2_500n], 1n] as const;
    const singleData = (encodeFunctionData as any)({ abi: [burn.abi], functionName: 'burn', args: singleArgs });
    expect((decodeFunctionData as any)({ abi: [burn.abi], data: singleData })).toMatchObject({ functionName: 'burn', args: singleArgs });

    const products = [
      { expiry: 1_800_000_000n, anchorPrices: [2_000n, 2_500n], isMaker: 0n },
      { expiry: 1_810_000_000n, anchorPrices: [3_000n, 3_500n], isMaker: 1n },
    ] as const;
    const batchData = (encodeFunctionData as any)({ abi: [batch.abi], functionName: 'burnBatch', args: [products] });
    expect((decodeFunctionData as any)({ abi: [batch.abi], data: batchData })).toMatchObject({ functionName: 'burnBatch', args: [products] });
    expect(functions.flat().every((fn) => fn.abi.stateMutability === 'nonpayable')).toBe(true);
  });
});
