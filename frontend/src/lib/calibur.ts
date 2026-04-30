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
  'function execute((address target, uint256 value, bytes data)[] calls) payable',
]);

export enum KeyType {
  P256 = 0,
  WebAuthnP256 = 1,
  Secp256k1 = 2,
}

export type CaliburKey = {
  keyType: KeyType;
  publicKey: Hex;
};

export type CaliburCall = {
  target: Address;
  value: bigint;
  data: Hex;
};

export type KeySettings = {
  isAdmin: boolean;
  expiration: number;
  hook: Address;
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

export function encodeRegisterKey(key: CaliburKey): CaliburCall {
  return {
    target: zeroAddress,
    value: 0n,
    data: encodeFunctionData({
      abi: caliburAbi,
      functionName: 'register',
      args: [key],
    }),
  };
}

export function encodeUpdateKeySettings(keyHash: Hex, settings: KeySettings): CaliburCall {
  return {
    target: zeroAddress,
    value: 0n,
    data: encodeFunctionData({
      abi: caliburAbi,
      functionName: 'update',
      args: [keyHash, packSettings(settings)],
    }),
  };
}

export function encodeExecute(calls: CaliburCall[]): Hex {
  return encodeFunctionData({
    abi: caliburAbi,
    functionName: 'execute',
    args: [calls],
  });
}
