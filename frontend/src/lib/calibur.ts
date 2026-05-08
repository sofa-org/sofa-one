import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  serializeSignature,
  type Account,
  type Client,
  zeroAddress,
  type Address,
  type Hex,
  type SignableMessage,
} from 'viem';
import { entryPoint08Abi, entryPoint08Address, getUserOperationTypedData, toSmartAccount } from 'viem/account-abstraction';
import { getChainId, readContract } from 'viem/actions';

const caliburAbi = parseAbi([
  'function register((uint8 keyType, bytes publicKey) key)',
  'function update(bytes32 keyHash, uint256 settings)',
  'function execute(((address to, uint256 value, bytes data)[] calls, bool revertOnFailure) batchedCall) payable',
]);

const ROOT_KEY = `0x${'00'.repeat(32)}` as const;
const STUB_SIG =
  '0xfffffffffffffffffffffff0000000000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c' as const;
const CALIBUR_EXECUTE_USER_OP_SELECTOR = '0x8dd7712f' as const;

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

function encodeExecuteUserOp(calls: CaliburCall[]): Hex {
  // IAccountExecute callData is selector + ABI-encoded BatchedCall, not a
  // normal executeUserOp(...) ABI call. EntryPoint v0.8 rewrites this selector
  // into executeUserOp(PackedUserOperation, bytes32) on the account.
  return `${CALIBUR_EXECUTE_USER_OP_SELECTOR}${encodeAbiParameters(parseAbiParameters('((address to, uint256 value, bytes data)[], bool)'), [
    [calls, true],
  ]).slice(2)}` as Hex;
}

function normalizeSignature(sig: Hex): Hex {
  if (sig.length !== 132) return sig;

  const r = sig.slice(0, 66) as Hex;
  const s = `0x${sig.slice(66, 130)}` as Hex;
  let v = Number.parseInt(sig.slice(130, 132), 16);
  if (v < 27) v += 27;

  return serializeSignature({ r, s, v: BigInt(v) });
}

export async function createCaliburAccount({ client, owner }: { client: Client<any, any, any>; owner: Account }) {
  return toSmartAccount({
    client,
    entryPoint: {
      abi: entryPoint08Abi,
      address: entryPoint08Address,
      version: '0.8',
    },
    authorization: {
      address: CALIBUR_ADDRESS,
      account: owner as never,
    },
    getAddress: async () => getAddress(owner.address),
    getFactoryArgs: async () => ({ factory: '0x7702' as Address, factoryData: '0x' as Hex }),
    encodeCalls: async (calls: readonly { to: Hex; data?: Hex; value?: bigint }[]) => encodeExecuteUserOp(calls as CaliburCall[]),
    getNonce: async () => {
      return readContract(client, {
        abi: entryPoint08Abi,
        address: entryPoint08Address,
        functionName: 'getNonce',
        args: [owner.address, 0n],
      });
    },
    getStubSignature: async () =>
      encodeAbiParameters(parseAbiParameters('bytes32, bytes, bytes'), [ROOT_KEY, STUB_SIG, '0x']),
    sign: async ({ hash }: { hash: Hex }) => owner.sign!({ hash }),
    signMessage: async ({ message }: { message: SignableMessage }) => owner.signMessage!({ message } as never),
    signTypedData: async (typedData: Parameters<NonNullable<Account['signTypedData']>>[0]) => owner.signTypedData!(typedData as never),
    signUserOperation: async (userOperation: { chainId?: number }) => {
      const chainId = userOperation.chainId ?? (await getChainId(client));
      const typedData = getUserOperationTypedData({
        chainId,
        entryPointAddress: entryPoint08Address,
        userOperation: userOperation as never,
      });
      const sig = normalizeSignature(await owner.signTypedData!(typedData as never));
      return encodeAbiParameters(parseAbiParameters('bytes32, bytes, bytes'), [ROOT_KEY, sig, '0x']);
    },
  } as never);
}
