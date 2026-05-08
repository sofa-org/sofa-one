import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';

const caliburAbi = parseAbi([
  'function register((uint8 keyType, bytes publicKey) key)',
  'function update(bytes32 keyHash, uint256 settings)',
  'function execute(((address to, uint256 value, bytes data)[] calls, bool revertOnFailure) batchedCall) payable',
]);

export const CALIBUR_ADDRESS = '0x000000009b1d0af20d8c6d0a44e162d11f9b8f00' as const;
export const CALIBUR_DELEGATION_CODE = `0xef0100${CALIBUR_ADDRESS.slice(2)}` as const;

export enum KeyType {
  P256 = 0,
  WebAuthnP256 = 1,
  Secp256k1 = 2,
}

export type CaliburKey = {
  keyType: KeyType;
  publicKey: Hex;
};

export type KeySettings = {
  isAdmin: boolean;
  expiration: number;
  hook: Address;
};

export type CaliburCall = {
  to: Address;
  value: bigint;
  data: Hex;
};

export function hashKey(key: CaliburKey): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('uint8, bytes32'), [key.keyType, keccak256(key.publicKey)]),
  );
}

export function packSettings(settings: KeySettings): bigint {
  const admin = settings.isAdmin ? 1n : 0n;
  const expiration = BigInt(settings.expiration);
  const hook = BigInt(getAddress(settings.hook));

  return (admin << 200n) | (expiration << 160n) | hook;
}

export function encodeRegisterKey(key: CaliburKey): Hex {
  return encodeFunctionData({
    abi: caliburAbi,
    functionName: 'register',
    args: [key],
  });
}

export function encodeUpdateKeySettings(keyHash: Hex, settings: KeySettings): Hex {
  return encodeFunctionData({
    abi: caliburAbi,
    functionName: 'update',
    args: [keyHash, packSettings(settings)],
  });
}

export function encodeSelfCall(data: Hex): CaliburCall {
  return {
    to: zeroAddress,
    value: 0n,
    data,
  };
}

export function encodeExecute(calls: CaliburCall[]): Hex {
  return encodeFunctionData({
    abi: caliburAbi,
    functionName: 'execute',
    args: [{ calls, revertOnFailure: true }],
  });
}
