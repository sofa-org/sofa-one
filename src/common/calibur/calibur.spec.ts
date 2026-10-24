const mockGetCode = jest.fn();

jest.mock('viem/actions', () => ({
  getCode: (...args: unknown[]) => mockGetCode(...args),
  readContract: jest.fn(),
}));

import { decodeAbiParameters, decodeFunctionData, parseAbi } from 'viem';
import {
  encodeCaliburExecuteUserOpCalls,
  getCaliburDelegationCode,
  KeyType,
  ZERO_ADDRESS,
  hashKey,
  packSettings,
  unpackSettings,
  encodeRegisterKey,
  encodeUpdateKeySettings,
  LEGACY_CALIBUR_ADDRESS,
} from './calibur-primitives';
import { hasCaliburDelegation } from './calibur';

describe('Calibur delegation helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('detects whether an EOA is delegated to Calibur', async () => {
    const account = '0x1111111111111111111111111111111111111111';
    mockGetCode.mockResolvedValueOnce(getCaliburDelegationCode());
    mockGetCode.mockResolvedValueOnce(getCaliburDelegationCode(LEGACY_CALIBUR_ADDRESS));
    mockGetCode.mockResolvedValueOnce('0x');

    await expect(hasCaliburDelegation({} as any, account)).resolves.toBe(true);
    await expect(hasCaliburDelegation({} as any, account)).resolves.toBe(true);
    await expect(hasCaliburDelegation({} as any, account)).resolves.toBe(false);
  });

  it('encodes the EntryPoint BatchedCall with complete values and call defaults', () => {
    const to = '0x1111111111111111111111111111111111111111';
    const callData = encodeCaliburExecuteUserOpCalls([
      { to, value: 7n, data: '0x1234' },
      { to },
    ]);

    expect(callData.slice(0, 10)).toBe('0x8dd7712f');
    expect(
      decodeAbiParameters(
        [{ type: 'tuple', components: [
          { type: 'tuple[]', components: [
            { type: 'address' }, { type: 'uint256' }, { type: 'bytes' },
          ] },
          { type: 'bool' },
        ] }],
        `0x${callData.slice(10)}`,
      ),
    ).toEqual([[[[to, 7n, '0x1234'], [to, 0n, '0x']], true]]);
  });

  it('packs and unpacks the full Calibur settings bit layout', () => {
    const settings = {
      isAdmin: true,
      expiration: 2 ** 40 - 1,
      hook: '0x0000000000000000000000000000000000000001' as const,
    };
    const packed = (1n << 200n) | (((1n << 40n) - 1n) << 160n) | 1n;

    expect(packSettings(settings)).toBe(packed);
    expect(unpackSettings(packed)).toEqual(settings);
    expect(unpackSettings(0n)).toEqual({ isAdmin: false, expiration: 0, hook: ZERO_ADDRESS });
  });

  it('distinguishes key types and public key bytes in key identity', () => {
    const key = { keyType: KeyType.Secp256k1, publicKey: '0x1234' as const };
    expect(hashKey(key)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashKey(key)).not.toBe(hashKey({ ...key, keyType: KeyType.P256 }));
    expect(hashKey(key)).not.toBe(hashKey({ ...key, publicKey: '0x123400' }));
  });

  it('encodes key registration and settings updates using the contract ABI', () => {
    const key = { keyType: KeyType.Secp256k1, publicKey: '0x1234' as const };
    const keyHash = hashKey(key);
    const settings = { isAdmin: false, expiration: 123, hook: ZERO_ADDRESS };
    const abi = parseAbi([
      'function register((uint8 keyType, bytes publicKey) key)',
      'function update(bytes32 keyHash, uint256 settings)',
    ]);

    expect(decodeFunctionData({ abi, data: encodeRegisterKey(key) })).toEqual({
      functionName: 'register',
      args: [key],
    });
    expect(decodeFunctionData({ abi, data: encodeUpdateKeySettings(keyHash, settings) })).toEqual({
      functionName: 'update',
      args: [keyHash, 123n << 160n],
    });
  });
});
