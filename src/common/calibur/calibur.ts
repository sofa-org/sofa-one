import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  serializeSignature,
  type Address,
  type Client,
  type Hex,
} from 'viem';
import { entryPoint08Abi, getUserOperationTypedData, toSmartAccount } from 'viem/account-abstraction';
import type { Account } from 'viem/accounts';

export const CALIBUR_ADDRESS = '0x000000009b1d0af20d8c6d0a44e162d11f9b8f00' as const;
export const ENTRYPOINT_V08_ADDRESS = '0x4337084d9e255ff0702461cf8895ce9e3b5ff108' as const;

export enum KeyType {
  P256 = 0,
  WebAuthnP256 = 1,
  Secp256k1 = 2,
}

export type CaliburKey = {
  keyType: KeyType;
  publicKey: Hex;
};

export type CaliburSessionAccountParams = {
  client: Client;
  signer: Account;
  accountAddress: Address;
  keyHash: Hex;
};

const STUB_SIGNATURE =
  '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c' as const;

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

export function encodeExecute(calls: Hex[]): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'execute',
        inputs: [{ name: 'calls', type: 'bytes[]' }],
        outputs: [],
        stateMutability: 'payable',
      },
    ],
    functionName: 'execute',
    args: [calls],
  });
}

export function createCaliburSessionAccount({
  client,
  signer,
  accountAddress,
  keyHash,
}: CaliburSessionAccountParams) {
  return toSmartAccount({
    client: client as any,
    entryPoint: {
      abi: entryPoint08Abi,
      address: ENTRYPOINT_V08_ADDRESS,
      version: '0.8',
    },
    async getAddress() {
      return accountAddress;
    },
    async encodeCalls(calls: Array<{ to: Address; value?: bigint; data?: Hex }>) {
      return encodeFunctionData({
        abi: [
          {
            type: 'function',
            name: 'executeUserOp',
            inputs: [
              {
                name: 'calls',
                type: 'tuple[]',
                components: [
                  { name: 'target', type: 'address' },
                  { name: 'value', type: 'uint256' },
                  { name: 'data', type: 'bytes' },
                ],
              },
            ],
            outputs: [],
            stateMutability: 'payable',
          },
        ],
        functionName: 'executeUserOp',
        args: [
          calls.map((call: { to: Address; value?: bigint; data?: Hex }) => ({
            target: call.to as Address,
            value: call.value ?? 0n,
            data: call.data ?? '0x',
          })),
        ],
      });
    },
    async getNonce() {
      return 0n;
    },
    async getStubSignature() {
      return encodeAbiParameters(
        [
          { name: 'keyHash', type: 'bytes32' },
          { name: 'signature', type: 'bytes' },
          { name: 'authData', type: 'bytes' },
        ],
        [keyHash, STUB_SIGNATURE, '0x'],
      );
    },
    async sign({ hash }: { hash: Hex }) {
      return (signer as any).sign({ hash });
    },
    async signMessage({ message }: { message: unknown }) {
      return (signer as any).signMessage({ message });
    },
    async signTypedData(typedData: unknown) {
      return (signer as any).signTypedData(typedData);
    },
    async signUserOperation(userOperation: any) {
      const typedData = getUserOperationTypedData({
        chainId: client.chain!.id,
        entryPointAddress: ENTRYPOINT_V08_ADDRESS,
        userOperation,
      });
      const signature = await (signer as any).signTypedData(typedData);
      const r = signature.slice(0, 66) as Hex;
      const s = (`0x${signature.slice(66, 130)}`) as Hex;
      let v = Number.parseInt(signature.slice(130, 132), 16);
      if (v < 27) v += 27;

      const normalizedSignature = serializeSignature({ r, s, v: BigInt(v) });
      return encodeAbiParameters(
        [
          { name: 'keyHash', type: 'bytes32' },
          { name: 'signature', type: 'bytes' },
          { name: 'authData', type: 'bytes' },
        ],
        [keyHash, normalizedSignature, '0x'],
      );
    },
  } as any);
}
