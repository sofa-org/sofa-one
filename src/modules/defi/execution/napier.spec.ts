import { encodeFunctionData, parseAbi, type AbiFunction, type Hex } from 'viem';
import type { DefiExecutionScope, DefiFunctionPolicy } from '../defi.types';
import { validateNapierCollect, validateNapierCollectorBinding } from './napier';

const target = '0x0000001d41857cb60f6be0c9fe74b9e69e1e5234';
const principalToken = '0x1111111111111111111111111111111111111111';
const receiver = '0x2222222222222222222222222222222222222222';
const reward = '0x3333333333333333333333333333333333333333';
const scope: DefiExecutionScope = { kind: 'napier-zero-deadline-collect-v1' };
const input = {
  name: 'inputs', type: 'tuple[]', internalType: 'struct TwoCryptoZap.CollectInput[]',
  components: [
    { name: 'principalToken', type: 'address', internalType: 'address' },
    {
      name: 'permit', type: 'tuple', internalType: 'struct TwoCryptoZap.PermitCollectInput',
      components: [
        { name: 'deadline', type: 'uint256', internalType: 'uint256' },
        { name: 'v', type: 'uint8', internalType: 'uint8' },
        { name: 'r', type: 'bytes32', internalType: 'bytes32' },
        { name: 's', type: 'bytes32', internalType: 'bytes32' },
      ],
    },
  ],
} as const;
const destination = { name: 'receiver', type: 'address', internalType: 'address' } as const;
const abis: readonly AbiFunction[] = [
  { type: 'function', name: 'collectWithPermit', stateMutability: 'nonpayable', inputs: [input, destination], outputs: [] },
  {
    type: 'function', name: 'collectRewardsWithPermit', stateMutability: 'nonpayable',
    inputs: [input, { name: 'rewardTokens', type: 'address[][]', internalType: 'address[][]' }, destination], outputs: [],
  },
];

function policy(abi: AbiFunction): DefiFunctionPolicy {
  return {
    capabilityId: `napier-fixture:${abi.name}`, type: 'contract_call', chainId: 1, contract: target,
    functionName: abi.name,
    signature: `${abi.name}((address,(uint256,uint8,bytes32,bytes32))[],${abi.name === 'collectRewardsWithPermit' ? 'address[][],' : ''}address)`,
    abi, executionScope: scope, status: 'active',
    provenance: { sourceRef: 'source-bound collector boundary fixture', status: 'verified', verifiedAt: '2026-11-02' },
  };
}

function collect(abi: AbiFunction, deadlines: readonly bigint[] = [0n], rewardTokens: readonly (readonly string[])[] = [[reward]]): Hex {
  const inputs = deadlines.map((deadline) => ({
    principalToken,
    permit: { deadline, v: 255, r: `0x${'ab'.repeat(32)}`, s: `0x${'cd'.repeat(32)}` },
  }));
  const args = abi.name === 'collectWithPermit' ? [inputs, receiver] : [inputs, rewardTokens, receiver];
  return encodeFunctionData({ abi: [abi], functionName: abi.name, args } as never);
}

function word(data: string, index: number, value: bigint): string {
  const offset = 10 + index * 64;
  return `${data.slice(0, offset)}${value.toString(16).padStart(64, '0')}${data.slice(offset + 64)}`;
}

describe('Napier collector authority boundary', () => {
  it.each(abis)('rejects every nonzero deadline in $name, including later inputs', (abi) => {
    for (const deadline of [1n, (1n << 256n) - 1n]) {
      for (const deadlines of [[deadline], [0n, deadline], [deadline, 0n]]) {
        expect(() => validateNapierCollect(collect(abi, deadlines))).toThrow();
      }
    }
  });

  it('checks deadlines even when reward-array mismatch would revert on chain', () => {
    expect(() => validateNapierCollect(collect(abis[1], [0n, 1n], []))).toThrow();
  });

  it.each(abis)('rejects malformed, truncated, extended and oversized $name calldata', (abi) => {
    const data = collect(abi);
    for (const invalid of ['0x', data.slice(0, 10), data.slice(0, -2), `${data}00`, `${data}zz`, `${data.slice(0, 10)}${'00'.repeat(65_537)}`]) {
      expect(() => validateNapierCollect(invalid)).toThrow();
    }
  });

  it.each(abis)('bounds all $name input arrays and offsets before decoding', (abi) => {
    const data = collect(abi);
    const arrayStart = Number(BigInt(`0x${data.slice(10, 74)}`)) / 32;
    for (const invalid of [
      collect(abi, Array<bigint>(65).fill(0n)),
      word(data, 0, 0n), word(data, 0, 1n), word(data, 0, 65_536n),
      word(data, arrayStart, (1n << 256n) - 1n),
    ]) expect(() => validateNapierCollect(invalid)).toThrow();
  });

  it.each(abis)('rejects noncanonical PT, uint8 and receiver words in $name', (abi) => {
    const data = collect(abi);
    const start = Number(BigInt(`0x${data.slice(10, 74)}`)) / 32;
    const receiverIndex = abi.inputs.length - 1;
    for (const invalid of [
      word(data, start + 1, (1n << 160n) + BigInt(principalToken)),
      word(data, start + 3, 256n),
      word(data, receiverIndex, (1n << 160n) + BigInt(receiver)),
    ]) expect(() => validateNapierCollect(invalid)).toThrow();
  });

  it('bounds and canonically validates nested rewards even when no input consumes them', () => {
    const abi = abis[1];
    for (const invalid of [
      collect(abi, [], Array.from({ length: 65 }, () => [])),
      collect(abi, [], [Array<string>(65).fill(reward)]),
      collect(abi, [], Array.from({ length: 17 }, () => Array<string>(64).fill(reward))),
    ]) expect(() => validateNapierCollect(invalid)).toThrow();
    const data = collect(abi, [], [[reward]]);
    const rewardsStart = Number(BigInt(`0x${data.slice(74, 138)}`)) / 32;
    const innerStart = rewardsStart + 1 + Number(BigInt(`0x${data.slice(10 + (rewardsStart + 1) * 64, 10 + (rewardsStart + 2) * 64)}`)) / 32;
    for (const invalid of [
      word(data, rewardsStart + 1, 0n),
      word(data, innerStart, (1n << 256n) - 1n),
      word(data, innerStart + 1, (1n << 160n) + BigInt(reward)),
    ]) expect(() => validateNapierCollect(invalid)).toThrow();
  });

  it('does not interpret direct permits or ordinary financial calls as collect', () => {
    const other = parseAbi(['function permitCollector(address owner,address collector,uint256 deadline,uint8 v,bytes32 r,bytes32 s)']);
    const data = encodeFunctionData({ abi: other, functionName: 'permitCollector', args: [principalToken, target, 0n, 0, `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`] });
    expect(() => validateNapierCollect(data)).toThrow();
  });

  it.each(abis)('cannot remove, extend or transplant the $name binding', (abi) => {
    const fn = policy(abi);
    const changed: DefiFunctionPolicy[] = [
      { ...fn, executionScope: undefined },
      { ...fn, executionScope: { kind: 'empty-callback-data-v1', bytesArgIndex: 0 } },
      { ...fn, executionScope: { ...scope, deadline: 0 } as unknown as DefiExecutionScope },
      { ...fn, contract: receiver }, { ...fn, chainId: 42161 }, { ...fn, type: 'typed_data_sign' },
      { ...fn, functionName: 'collect' }, { ...fn, signature: 'collect(address)' },
      { ...fn, abi: { ...abi, stateMutability: 'payable' } },
      { ...fn, abi: { ...abi, outputs: [{ name: 'shares', type: 'uint256' }] } },
      { ...fn, abi: { ...abi, inputs: abi.inputs.map((param, i) => i === 0 ? { ...param, name: 'uncheckedInputs' } : param) } },
    ];
    for (const candidate of changed) expect(() => validateNapierCollectorBinding(candidate)).toThrow();
  });

  it.each(abis)('reserves selector and name aliases at the $name root without a marker', (abi) => {
    const fn = policy(abi);
    for (const candidate of [
      { ...fn, executionScope: undefined, functionName: 'unscopedAlias', abi: { ...abi, name: 'unscopedAlias' } },
      { ...fn, executionScope: undefined, signature: `${abi.name}(bytes)` },
      { ...fn, executionScope: undefined, functionName: 'unscopedAlias', signature: 'unscopedAlias(bytes)' },
    ]) expect(() => validateNapierCollectorBinding(candidate)).toThrow();
  });
});
