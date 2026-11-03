import {
  encodeAbiParameters,
  serializeSignature,
  type Address,
  type Chain,
  type Client,
  type Hex,
  type Transport,
} from 'viem';
import { entryPoint08Abi, getUserOperationTypedData, toSmartAccount } from 'viem/account-abstraction';
import { getCode, readContract } from 'viem/actions';
import type { Account } from 'viem/accounts';
import {
  CALIBUR_DELEGATION_CODES,
  ENTRYPOINT_V08_ADDRESS,
  ZERO_ADDRESS,
  encodeCaliburExecuteUserOpCalls,
  unpackSettings,
  type CaliburKeySettings,
} from './calibur-primitives';

export type CaliburSessionAccountParams = {
  client: Client;
  signer: Account;
  accountAddress: Address;
  keyHash: Hex;
};

const STUB_SIGNATURE =
  '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c' as const;

const CALIBUR_KEY_ABI = [
  {
    type: 'function',
    name: 'getKeySettings',
    inputs: [{ name: 'keyHash', type: 'bytes32' }],
    outputs: [{ name: 'settings', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isRegistered',
    inputs: [{ name: 'keyHash', type: 'bytes32' }],
    outputs: [{ name: 'registered', type: 'bool' }],
    stateMutability: 'view',
  },
] as const;

export async function hasCaliburDelegation(
  client: Client<Transport, Chain | undefined>,
  account: Address,
): Promise<boolean> {
  const code = await getCode(client, { address: account });
  const normalizedCode = code?.toLowerCase();
  return CALIBUR_DELEGATION_CODES.some(
    (delegationCode) => normalizedCode === delegationCode.toLowerCase(),
  );
}

export async function isCaliburKeyRegistered(
  client: Client<Transport, Chain | undefined>,
  account: Address,
  keyHash: Hex,
): Promise<boolean> {
  return readContract(client, {
    abi: CALIBUR_KEY_ABI,
    address: account,
    functionName: 'isRegistered',
    args: [keyHash],
  });
}

export async function getCaliburKeySettings(
  client: Client<Transport, Chain | undefined>,
  account: Address,
  keyHash: Hex,
): Promise<CaliburKeySettings> {
  const packed = await readContract(client, {
    abi: CALIBUR_KEY_ABI,
    address: account,
    functionName: 'getKeySettings',
    args: [keyHash],
  });

  return unpackSettings(packed);
}

export function getAgentKeyUsabilityFailure(
  settings: CaliburKeySettings,
  nowSeconds = Math.floor(Date.now() / 1000),
): string | null {
  if (settings.isAdmin) return 'Agent key must not be an admin key';
  if (settings.expiration <= nowSeconds) return 'Agent key is expired';
  if (settings.hook !== ZERO_ADDRESS) return 'Agent key hook is not supported';

  return null;
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
      // Calibur's EntryPoint path calls executeUserOp(PackedUserOperation, bytes32),
      // then decodes userOp.callData after removing the first 4 selector bytes as
      // BatchedCall({ calls: Call[], revertOnFailure: bool }). This is not the
      // public direct execute(...) ABI used for browser self-registration.
      return encodeCaliburExecuteUserOpCalls(calls);
    },
    async getNonce() {
      return readContract(client, {
        abi: entryPoint08Abi,
        address: ENTRYPOINT_V08_ADDRESS,
        functionName: 'getNonce',
        args: [accountAddress, 0n],
      });
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
