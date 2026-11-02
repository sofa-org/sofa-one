import { encodeFunctionData, parseAbi, type AbiFunction, type Hex } from 'viem';
import type { DefiFunctionPolicy } from '../defi.types';
import { validateFlexaStake, validateFlexaStakeBinding } from './flexa';

const root = '0xd57e335457b6f5d09ac69248230005a02f9b60cf';
const token = '0x2222222222222222222222222222222222222222';
const stake = parseAbi(['function stake(address _token,uint256 _amount,bytes _collateralizableApprovalSignature) returns (uint256)'])[0];
const releasable = parseAbi(['function stakeReleasableTokensFrom(address _pool,address _token,uint256 _amount,bytes _collateralizableApprovalSignature) returns (uint256)'])[0];
const functions = [
  { abi: stake, signature: 'stake(address,uint256,bytes)', signatureIndex: 2, tokenIndex: 0 },
  { abi: releasable, signature: 'stakeReleasableTokensFrom(address,address,uint256,bytes)', signatureIndex: 3, tokenIndex: 1 },
];

function policy(abi: AbiFunction, signature: string): DefiFunctionPolicy {
  return {
    capabilityId: `flexa-test:${abi.name}`, type: 'contract_call', chainId: 1, contract: root,
    functionName: abi.name, signature, abi, status: 'active',
    provenance: { sourceRef: 'source-bound Flexa security fixture', verifiedAt: '2026-11-02', status: 'verified' },
    executionScope: { kind: 'flexa-preauthorized-stake-v1' },
  };
}

function call(abi: AbiFunction, signature: Hex = '0x', pool = root): Hex {
  const args = abi.name === 'stakeReleasableTokensFrom' ? [pool, token, (1n << 256n) - 1n, signature] : [token, (1n << 256n) - 1n, signature];
  return encodeFunctionData({ abi: [abi], functionName: abi.name, args } as never);
}

function replaceWord(data: Hex, index: number, word: string): Hex {
  const offset = 10 + index * 64;
  return `${data.slice(0, offset)}${word}${data.slice(offset + 64)}` as Hex;
}

describe('Flexa preauthorized stake leaf constraints', () => {
  it.each(functions)('rejects allowance signatures for $signature', ({ abi }) => {
    for (const signature of ['0x01', `0x${'ff'.repeat(65)}`] as Hex[]) {
      expect(() => validateFlexaStake(call(abi, signature))).toThrow();
    }
  });

  it('rejects every selected external pool, including the implementation and beacon', () => {
    for (const pool of ['0x0000000000000000000000000000000000000000', token,
      '0xcc437a7bb14f07de09b0f4438df007c8f64cf29f', '0x1f00d6f7c18a8edf4f8bb4ead8a898abdd9c9e14']) {
      expect(() => validateFlexaStake(call(releasable, '0x', pool))).toThrow();
    }
  });

  it.each(functions)('rejects noncanonical and unbounded wire data for $signature', ({ abi, signatureIndex, tokenIndex }) => {
    const data = call(abi);
    const invalid = [
      `${data}00`, data.slice(0, -2),
      replaceWord(data, signatureIndex, 'ff'.repeat(32)),
      replaceWord(data, signatureIndex + 1, '0'.repeat(59) + '10001'),
      replaceWord(data, tokenIndex, `01${'0'.repeat(22)}${token.slice(2)}`),
    ];
    for (const encoded of invalid) expect(() => validateFlexaStake(encoded)).toThrow();
  });

  it('does not interpret deposit/signature authority or an outer multicall as staking', () => {
    const deposit = parseAbi(['function depositAndStake(address _token,uint256 _amount,bytes _collateralizableDepositApprovalSignature) returns (uint256)'])[0];
    const multicall = parseAbi(['function multicall(bytes[] data) returns (bytes[] results)'])[0];
    expect(() => validateFlexaStake(call(deposit))).toThrow();
    expect(() => validateFlexaStake(encodeFunctionData({ abi: [multicall], functionName: 'multicall', args: [[call(stake)]] }))).toThrow();
  });

  it.each(functions)('cannot drop the mandatory scope or move its marker for $signature', ({ abi, signature }) => {
    const fn = policy(abi, signature);
    const invalid: DefiFunctionPolicy[] = [
      { ...fn, executionScope: undefined },
      { ...fn, executionScope: { kind: 'empty-callback-data-v1', bytesArgIndex: abi.inputs.length - 1 } },
      { ...fn, executionScope: { ...fn.executionScope, bytesArgIndex: abi.inputs.length - 1 } as never },
      { ...fn, contract: token }, { ...fn, chainId: 42161 }, { ...fn, type: 'typed_data_sign' },
      { ...fn, signature: 'depositAndStake(address,uint256,bytes)' }, { ...fn, functionName: 'depositAndStake' },
    ];
    for (const changed of invalid) expect(() => validateFlexaStakeBinding(changed)).toThrow();
  });

  it.each(functions)('requires the exact full ABI for $signature', ({ abi, signature }) => {
    const fn = policy(abi, signature);
    for (const changed of [
      { ...abi, stateMutability: 'payable' as const }, { ...abi, outputs: [] },
      { ...abi, outputs: [{ name: 'poolUnits', type: 'uint256' }] },
      { ...abi, inputs: abi.inputs.map((input, index) => index === abi.inputs.length - 1 ? { ...input, type: 'bytes32' } : input) },
    ]) expect(() => validateFlexaStakeBinding({ ...fn, abi: changed })).toThrow();
  });
});
