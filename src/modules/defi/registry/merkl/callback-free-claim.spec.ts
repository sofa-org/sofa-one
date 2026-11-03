import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import { DefiCatalogService } from '../../defi-catalog.service';
import { DefiPolicyService } from '../../defi-policy.service';
import type { DefiExecutionContext, DefiExecutionScope, DefiFunctionPolicy } from '../../defi.types';
import { buildReviewedManifest, functionAbiHash } from '../defi-manifest';
import { PRODUCTION_DEFI_MANIFEST } from '../production-registry';
import { executionScopeHash } from '../../execution/scope';

const OWNER = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const RECIPIENT = '0x3333333333333333333333333333333333333333';
const signature = 'claimWithRecipient(address[],address[],uint256[],bytes32[][],address[],bytes[])';
const selected = PRODUCTION_DEFI_MANIFEST.capabilities.filter((fn) => fn.protocol === 'Merkl');
const claim = (chainId = 10) => selected.find((fn) => fn.chainId === chainId && fn.signature === signature)!;
const manifestFor = (functions: readonly DefiFunctionPolicy[]) => buildReviewedManifest(functions.map((fn) => ({ chains: [{ chainId: fn.chainId, status: 'active' as const, contracts: [{ address: fn.contract, status: 'active' as const, functions: [fn] }] }] })));
const manifest = manifestFor(selected);

function fixture() {
  const fn = claim();
  const state = { pausedScopeKeys: [] as string[] };
  const key = { userId: 'user', walletId: 'wallet', revoked: false, frozenAt: null, expiresAt: null, canSendTransaction: true, capabilityMode: 'custom', allowedCapabilityIds: [fn.capabilityId] };
  const db = { $queryRaw: jest.fn(), defiPolicyState: { findUnique: jest.fn(async () => state) }, apiKey: { findUnique: jest.fn(async () => key) }, userWallet: { findFirst: jest.fn(async () => ({ id: 'wallet' })) } };
  const catalog = new DefiCatalogService(manifest.chains, db as never, manifest);
  const policy = new DefiPolicyService(db as never, {} as never, catalog);
  const context: DefiExecutionContext = { userId: 'user', walletId: 'wallet', apiKeyId: '00000000-0000-4000-8000-000000000001', chainId: 10, executionMode: 'session_key', executionOwner: OWNER, capabilityMode: 'custom', allowedCapabilityIds: [fn.capabilityId] };
  return { fn, state, key, db, policy, context };
}

function call(datas: readonly Hex[] = ['0x'], amounts = datas.map(() => 100n)) {
  return { to: claim().contract, data: encodeFunctionData({ abi: [claim().abi], functionName: 'claimWithRecipient', args: [datas.map(() => OWNER), datas.map(() => TOKEN), amounts, datas.map(() => []), datas.map(() => RECIPIENT), datas] } as never) };
}
const readWord = (data: Hex, offset: number) => Number(BigInt(`0x${data.slice(10 + offset * 2, 10 + (offset + 32) * 2)}`));
const replaceWord = (data: Hex, offset: number, value: bigint): Hex => `${data.slice(0, 10 + offset * 2)}${value.toString(16).padStart(64, '0')}${data.slice(10 + (offset + 32) * 2)}` as Hex;
const invalid = { audit: { code: 'DEFI_INVALID_PARAMETERS' } };

describe('Merkl claim recipient without explicit recipient callbacks', () => {
  it('keeps an exact recipient-bearing claim committed through final authorization', async () => {
    const f = fixture();
    const interaction = call(['0x', '0x'], [1n, (1n << 256n) - 1n]);
    const auth = await f.policy.authorizeContractCalls([interaction], f.context);
    expect(auth.executionPlan.map((node) => [node.data, node.match.capabilityId, node.match.executionScopeHash])).toEqual([[interaction.data, f.fn.capabilityId, executionScopeHash(f.fn.executionScope!)]]);
    await f.policy.assertStillAuthorized(f.db as never, auth);
  });

  it('rejects callback bytes in every position in custom and all mode, even for zero amounts', async () => {
    const f = fixture();
    for (const context of [f.context, { ...f.context, capabilityMode: 'all' as const, allowedCapabilityIds: [] }]) {
      for (const datas of [['0x01', '0x'], ['0x', '0xbeef']] as const) {
        await expect(f.policy.authorizeContractCalls([call(datas, [0n, 0n])], context)).rejects.toMatchObject(invalid);
      }
    }
  });

  it('bounds every array and nested proof before decoding and rejects aliased or extended encodings', async () => {
    const f = fixture();
    const good = call().data;
    const proofs = readWord(good, 3 * 32);
    const innerProof = proofs + 32 + readWord(good, proofs + 32);
    const hiddenCallback = call(['0x', '0xbeef']).data;
    const datasBase = readWord(hiddenCallback, 5 * 32) + 32;
    const malformed = [
      replaceWord(good, 5 * 32, (1n << 256n) - 1n),
      replaceWord(good, readWord(good, 0), 65n),
      replaceWord(good, innerProof, 65n),
      replaceWord(hiddenCallback, datasBase + 32, BigInt(readWord(hiddenCallback, datasBase))),
      `${good}${'00'.repeat(32)}` as Hex,
    ];
    for (const data of malformed) await expect(f.policy.authorizeContractCalls([{ to: f.fn.contract, data }], f.context)).rejects.toMatchObject(invalid);
    await expect(f.policy.authorizeContractCalls([{ ...call(), value: '1' }], f.context)).rejects.toMatchObject(invalid);
  });

  it('does not borrow the ordinary claim or same-address other-chain grant', async () => {
    const f = fixture();
    const ordinary = selected.find((fn) => fn.chainId === 10 && fn.functionName === 'claim')!;
    for (const id of [ordinary.capabilityId, claim(137).capabilityId]) {
      await expect(f.policy.authorizeContractCalls([call()], { ...f.context, allowedCapabilityIds: [id] })).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
    }
  });

  it('rechecks current pauses and exact membership at final acceptance', async () => {
    const f = fixture();
    const auth = await f.policy.authorizeContractCalls([call()], f.context);
    f.state.pausedScopeKeys.push(`capability:${f.fn.capabilityId}`);
    await expect(f.policy.assertStillAuthorized(f.db as never, auth)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_PAUSED' } });
    f.state.pausedScopeKeys.length = 0;
    f.key.allowedCapabilityIds = [];
    await expect(f.policy.assertStillAuthorized(f.db as never, auth)).rejects.toMatchObject({ audit: { code: 'DEFI_CAPABILITY_NOT_GRANTED' } });
  });

  it('cannot remove its interpreter or move the reserved scope to a different ABI or deployment', () => {
    const fn = claim();
    for (const patch of [
      { executionScope: undefined }, { chainId: 1 }, { contract: RECIPIENT },
      { abi: { ...fn.abi, stateMutability: 'payable' as const } },
      { executionScope: { kind: 'merkl-empty-claim-data-v1', allowCallbacks: true } as unknown as DefiExecutionScope },
    ]) expect(() => manifestFor([{ ...fn, ...patch }])).toThrow();
  });

  it('does not implicitly expand the closed financial multicall child vocabulary', () => {
    const fn = claim();
    const wrapper: DefiFunctionPolicy = {
      ...fn, capabilityId: 'merkl:security-fixture:wrapper', functionName: 'multicall', signature: 'multicall(bytes[])',
      abi: parseAbi(['function multicall(bytes[] data) returns (bytes[] results)'])[0],
      executionScope: { kind: 'same-target-financial-multicall-v1', bytesArrayArgIndex: 0, nativeValuePolicy: 'zero', allowedChildren: [{ capabilityId: fn.capabilityId, signature: fn.signature, abiHash: functionAbiHash(fn), executionScopeHash: executionScopeHash(fn.executionScope!) }] },
    };
    expect(() => manifestFor([wrapper, fn])).toThrow();
  });
});
