import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  numberToHex,
  parseAbiParameters,
  type Address,
  type Hex,
} from 'viem';

export const CALIBUR_ADDRESS = '0x000000005c84F8Fd50b21CAC312528A64437030e' as const;
export const LEGACY_CALIBUR_ADDRESS = '0x000000009b1d0af20d8c6d0a44e162d11f9b8f00' as const;
export const CALIBUR_ADDRESSES = [CALIBUR_ADDRESS, LEGACY_CALIBUR_ADDRESS] as const;
export const ENTRYPOINT_V08_ADDRESS = '0x4337084d9e255ff0702461cf8895ce9e3b5ff108' as const;
export const EIP7702_DELEGATION_PREFIX = '0xef0100' as const;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export enum KeyType {
  P256 = 0,
  WebAuthnP256 = 1,
  Secp256k1 = 2,
}

export type CaliburKey = {
  keyType: KeyType;
  publicKey: Hex;
};

export type CaliburKeySettings = {
  isAdmin: boolean;
  expiration: number;
  hook: Address;
};

export function getCaliburDelegationCode(address: Address = CALIBUR_ADDRESS): Hex {
  return `${EIP7702_DELEGATION_PREFIX}${address.slice(2)}` as Hex;
}

export const CALIBUR_DELEGATION_CODES = CALIBUR_ADDRESSES.map(getCaliburDelegationCode);

export function hashKey(key: CaliburKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: 'keyType', type: 'uint8' },
        { name: 'publicKeyHash', type: 'bytes32' },
      ],
      [key.keyType, keccak256(key.publicKey)],
    ),
  );
}

export function packSettings(settings: CaliburKeySettings): bigint {
  const admin = settings.isAdmin ? 1n : 0n;
  const expiration = BigInt(settings.expiration);
  const hook = BigInt(getAddress(settings.hook));

  return (admin << 200n) | (expiration << 160n) | hook;
}

export function unpackSettings(packed: bigint): CaliburKeySettings {
  const hookMask = (1n << 160n) - 1n;
  const expirationMask = (1n << 40n) - 1n;
  const hook = getAddress(numberToHex(packed & hookMask, { size: 20 }));
  const expiration = Number((packed >> 160n) & expirationMask);
  const isAdmin = ((packed >> 200n) & 1n) === 1n;

  return { isAdmin, expiration, hook };
}

export function encodeUpdateKeySettings(keyHash: Hex, settings: CaliburKeySettings): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'update',
        inputs: [
          { name: 'keyHash', type: 'bytes32' },
          { name: 'settings', type: 'uint256' },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
      },
    ],
    functionName: 'update',
    args: [keyHash, packSettings(settings)],
  });
}

export function encodeRegisterKey(key: CaliburKey): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'register',
        inputs: [
          {
            name: 'key',
            type: 'tuple',
            components: [
              { name: 'keyType', type: 'uint8' },
              { name: 'publicKey', type: 'bytes' },
            ],
          },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
      },
    ],
    functionName: 'register',
    args: [key],
  });
}

export function encodeCaliburExecuteUserOpCalls(
  calls: readonly { to: Address; value?: bigint; data?: Hex }[],
): Hex {
  // EntryPoint v0.8 rewrites this selector to executeUserOp(PackedUserOperation,
  // bytes32); Calibur decodes the remaining bytes as BatchedCall, not execute(...).
  const encoded = encodeAbiParameters(parseAbiParameters('((address,uint256,bytes)[],bool)'), [
    [
      calls.map((call) => [call.to, call.value ?? 0n, call.data ?? '0x'] as const),
      true,
    ],
  ]);
  return `0x8dd7712f${encoded.slice(2)}` as Hex;
}
