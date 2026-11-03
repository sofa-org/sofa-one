import { encodeFunctionData, parseAbi, type AbiFunction, type Hex } from 'viem';
import type { DefiExecutionScope, DefiFunctionPolicy } from '../defi.types';
import { validateUmamiRequest, validateUmamiRequestBinding } from './umami';

const target = '0x5f851f67d24419982ecd7b7765defd64fbb50a97';
const receiver = '0x2222222222222222222222222222222222222222';
const owner = '0x3333333333333333333333333333333333333333';
const zero = '0x0000000000000000000000000000000000000000';
const scope: DefiExecutionScope = { kind: 'umami-zero-request-callback-v1' };
const abis = parseAbi([
  'function depositWithCallback(uint256 assets,uint256 minOutAfterFees,address receiver,address callback) payable returns (uint256 shares)',
  'function redeemWithCallback(uint256 shares,uint256 minOutAfterFees,address receiver,address owner,address callback) payable returns (uint256 assets)',
]);

function policy(abi: AbiFunction): DefiFunctionPolicy {
  return {
    capabilityId: `umami-fixture:${abi.name}`, type: 'contract_call', chainId: 42161, contract: target,
    functionName: abi.name, signature: `${abi.name}(${abi.inputs.map((input) => input.type).join(',')})`,
    abi, executionScope: scope, status: 'active',
    provenance: { sourceRef: 'typed source-bound request fixture', status: 'verified', verifiedAt: '2026-11-02' },
  };
}

function request(abi: AbiFunction, callback: string = zero): Hex {
  const args = abi.name === 'depositWithCallback'
    ? [(1n << 256n) - 1n, 0n, receiver, callback]
    : [1n << 255n, (1n << 256n) - 1n, receiver, owner, callback];
  return encodeFunctionData({ abi: [abi], functionName: abi.name, args } as never);
}

describe('Umami zero selected request callback boundary', () => {
  it.each(abis)('rejects a selected user callback for $name', (abi) => {
    expect(() => validateUmamiRequest(request(abi, receiver))).toThrow();
  });

  it.each(abis)('rejects truncated, extended and oversized $name calldata', (abi) => {
    const data = request(abi);
    for (const invalid of ['0x', data.slice(0, 10), data.slice(0, -2), `${data}00`, `${data.slice(0, 10)}${'00'.repeat(65_537)}`]) {
      expect(() => validateUmamiRequest(invalid)).toThrow();
    }
  });

  it.each(abis)('rejects noncanonical address words in $name', (abi) => {
    const data = request(abi);
    for (let index = 2; index < abi.inputs.length; index++) {
      const offset = 10 + index * 64;
      const dirty = `${data.slice(0, offset)}01${data.slice(offset + 2)}`;
      expect(() => validateUmamiRequest(dirty)).toThrow();
    }
  });

  it('does not interpret ordinary deposit as the scoped callback entrypoint', () => {
    const abi = parseAbi(['function deposit(uint256 assets,uint256 minOutAfterFees,address receiver) payable returns (uint256 shares)']);
    const data = encodeFunctionData({ abi, functionName: 'deposit', args: [1n, 0n, receiver] });
    expect(() => validateUmamiRequest(data)).toThrow();
  });

  it.each(abis)('cannot flatten or transplant the mandatory $name scope', (abi) => {
    const fn = policy(abi);
    const changed: DefiFunctionPolicy[] = [
      { ...fn, executionScope: undefined },
      { ...fn, executionScope: { kind: 'empty-callback-data-v1', bytesArgIndex: abi.inputs.length - 1 } },
      { ...fn, executionScope: { ...scope, callback: zero } as unknown as DefiExecutionScope },
      { ...fn, contract: receiver },
      { ...fn, chainId: 1 },
      { ...fn, type: 'typed_data_sign' },
      { ...fn, signature: 'deposit(uint256,uint256,address)' },
      { ...fn, functionName: 'redeem' },
      { ...fn, abi: { ...abi, stateMutability: 'nonpayable' } },
      { ...fn, abi: { ...abi, outputs: [] } },
      { ...fn, abi: { ...abi, outputs: [{ name: '', type: 'uint256' }] } },
      { ...fn, abi: { ...abi, inputs: abi.inputs.map((input, index) => index === abi.inputs.length - 1 ? { ...input, type: 'bytes' } : input) } },
    ];
    for (const candidate of changed) expect(() => validateUmamiRequestBinding(candidate)).toThrow();
  });
});
