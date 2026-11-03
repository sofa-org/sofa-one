import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
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
import { entryPoint08Abi, getUserOperationTypedData, toSmartAccount } from 'viem/account-abstraction';
import {
  CALIBUR_ADDRESS,
  ENTRYPOINT_V08_ADDRESS,
  encodeCaliburExecuteUserOpCalls,
} from '../../../src/common/calibur/calibur-primitives';
import { getChainId, readContract } from 'viem/actions';

const caliburAbi = parseAbi([
  'function execute(((address to, uint256 value, bytes data)[] calls, bool revertOnFailure) batchedCall) payable',
]);

const ROOT_KEY = `0x${'00'.repeat(32)}` as const;
const STUB_SIG =
  '0xfffffffffffffffffffffff0000000000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c' as const;

export type CaliburCall = {
  to: Address;
  value: bigint;
  data: Hex;
};

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

function normalizeSignature(sig: Hex): Hex {
  if (sig.length !== 132) return sig;

  const r = sig.slice(0, 66) as Hex;
  const s = `0x${sig.slice(66, 130)}` as Hex;
  let v = Number.parseInt(sig.slice(130, 132), 16);
  if (v < 27) v += 27;

  return serializeSignature({ r, s, v: BigInt(v) });
}

export async function createCaliburAccount({
  client,
  owner,
  authorizationAddress = CALIBUR_ADDRESS,
}: {
  client: Client<any, any, any>;
  owner: Account;
  authorizationAddress?: Address;
}) {
  return toSmartAccount({
    client,
    entryPoint: {
      abi: entryPoint08Abi,
      address: ENTRYPOINT_V08_ADDRESS,
      version: '0.8',
    },
    authorization: {
      address: authorizationAddress,
      account: owner as never,
    },
    getAddress: async () => getAddress(owner.address),
    getFactoryArgs: async () => ({ factory: '0x7702' as Address, factoryData: '0x' as Hex }),
    encodeCalls: async (calls: readonly { to: Address; data?: Hex; value?: bigint }[]) => encodeCaliburExecuteUserOpCalls(calls),
    getNonce: async () => {
      return readContract(client, {
        abi: entryPoint08Abi,
        address: ENTRYPOINT_V08_ADDRESS,
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
        entryPointAddress: ENTRYPOINT_V08_ADDRESS,
        userOperation: userOperation as never,
      });
      const sig = normalizeSignature(await owner.signTypedData!(typedData as never));
      return encodeAbiParameters(parseAbiParameters('bytes32, bytes, bytes'), [ROOT_KEY, sig, '0x']);
    },
  } as never);
}
