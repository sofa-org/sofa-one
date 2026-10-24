import { ServiceUnavailableException } from '@nestjs/common';
import { decodeFunctionData, type Address, type Hex } from 'viem';
import { validatePolymarketDepositBatch } from '../defi/signing/polymarket-deposit-batch';
import {
  expectedBeaconProxyRuntime,
  PolymarketDepositBatchDeploymentProbe,
  POLYMARKET_DEPOSIT_BEACON,
  POLYMARKET_DEPOSIT_CURRENT_IMPLEMENTATION,
  POLYMARKET_DEPOSIT_FACTORY,
} from './polymarket-deposit-batch-deployment';

const SIGNER = '0x0000000000000000000000000000000000000001' as Address;
const WALLET = '0x94bf330955a0b957662feaf878de77bf25f76cd9' as Address;
const BLOCK = 900n;
const NOW = 1_800_000_000_000;
const FACTORY_IMPL = '0x528CC05EFac2B0d255e423272187efD41248aBd7' as Address;
const HASH = {
  factory: '0xaaa52c8cc8a0e3fd27ce756cc6b4e70c51423e9b597b11f32d3e49f8b1fc890d',
  factoryImpl: '0xe6424f1008e46b4b657efacf9500ea7747cbbf3055d9d76459253ac2884793d2',
  beacon: '0xf87b06a1302051471df08ff79a938757509569e16b7a7efa55a3ea7b29b0b9d1',
  implementation: '0xf5c1072460e64902af84d35f5bb1d0a15d80a88c5827b831a977fbc5a0684b96',
  wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as const;
const payload = validatePolymarketDepositBatch({
  domain: { name: 'DepositWallet', version: '1', chainId: 137, verifyingContract: WALLET },
  types: {
    Call: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }],
    Batch: [{ name: 'wallet', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'calls', type: 'Call[]' }],
  },
  primaryType: 'Batch',
  message: { wallet: WALLET, nonce: '4', deadline: String(NOW / 1000 + 120), calls: [{ target: '0x2222222222222222222222222222222222222222', value: '0', data: '0x1234' }] },
}, NOW);

describe('PolymarketDepositBatchDeploymentProbe', () => {
  let state: Record<string, any>;
  let client: any;
  let probe: PolymarketDepositBatchDeploymentProbe;
  let now: number;

  beforeEach(() => {
    jest.clearAllMocks();
    now = NOW;
    const id = `0x${SIGNER.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
    const runtime = expectedBeaconProxyRuntime(POLYMARKET_DEPOSIT_BEACON, POLYMARKET_DEPOSIT_FACTORY, id);
    state = {
      factoryCode: '0xf001', factoryImplCode: '0xf002', beaconCode: '0xf003', currentImplCode: '0xf004', walletCode: runtime,
      factoryImpl: FACTORY_IMPL, beaconDefault: POLYMARKET_DEPOSIT_CURRENT_IMPLEMENTATION,
      beaconPinned: POLYMARKET_DEPOSIT_CURRENT_IMPLEMENTATION, owner: SIGNER, walletFactory: POLYMARKET_DEPOSIT_FACTORY,
      walletId: id, nonce: 4n, paused: 0n, predicted: WALLET, wrongChain: false, failCall: false,
      walletImplSlot: `0x${'00'.repeat(32)}`, probeReorg: false, simulationReorg: false,
    };
    const addressWord = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
    client = {
      getChainId: jest.fn(async () => state.wrongChain ? 80002 : 137),
      getBlock: jest.fn(async ({ blockNumber }: any) => ({ number: BLOCK, hash: (blockNumber !== undefined && (state.probeReorg || state.simulationReorg)) ? `0x${'22'.repeat(32)}` : `0x${'11'.repeat(32)}`, timestamp: BigInt(Math.floor(NOW / 1000)) })),
      getCode: jest.fn(async ({ address }: any) => {
        const lower = address.toLowerCase();
        if (lower === POLYMARKET_DEPOSIT_FACTORY.toLowerCase()) return state.factoryCode;
        if (lower === FACTORY_IMPL.toLowerCase()) return state.factoryImplCode;
        if (lower === POLYMARKET_DEPOSIT_BEACON.toLowerCase()) return state.beaconCode;
        if (lower === POLYMARKET_DEPOSIT_CURRENT_IMPLEMENTATION.toLowerCase()) return state.currentImplCode;
        if (lower === WALLET.toLowerCase()) return state.walletCode;
        return '0x';
      }),
      getStorageAt: jest.fn(async ({ address, slot }: any) => {
        if (address.toLowerCase() === POLYMARKET_DEPOSIT_FACTORY.toLowerCase()) return addressWord(state.factoryImpl);
        if (address.toLowerCase() === POLYMARKET_DEPOSIT_BEACON.toLowerCase()) return addressWord(state.beaconDefault);
        if (slot === '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50') return addressWord(POLYMARKET_DEPOSIT_BEACON);
        return state.walletImplSlot;
      }),
      readContract: jest.fn(async ({ address, functionName }: any) => {
        if (address.toLowerCase() === POLYMARKET_DEPOSIT_FACTORY.toLowerCase()) return functionName === 'BEACON' ? POLYMARKET_DEPOSIT_BEACON : state.predicted;
        if (address.toLowerCase() === POLYMARKET_DEPOSIT_BEACON.toLowerCase()) return functionName === 'defaultImplementation' ? state.beaconDefault : state.beaconPinned;
        if (functionName === 'owner') return state.owner;
        if (functionName === 'factory') return state.walletFactory;
        if (functionName === 'id') return state.walletId;
        if (functionName === 'nonce') return state.nonce;
        if (functionName === 'paused') return state.paused;
        throw new Error('unexpected read');
      }),
      call: jest.fn(async () => { if (state.failCall) throw new Error('execution reverted'); if (state.simulationReorg) return { data: '0x' }; if (state.advanceDuringCall) now += state.advanceDuringCall; return { data: '0x' }; }),
    };
    const fakeHashes: Record<string, string> = {
      [state.factoryCode]: HASH.factory,
      [state.factoryImplCode]: HASH.factoryImpl,
      [state.beaconCode]: HASH.beacon,
      [state.currentImplCode]: HASH.implementation,
      [state.walletCode]: HASH.wallet,
    };
    probe = new PolymarketDepositBatchDeploymentProbe({ client, rpcUrl: 'https://polygon.example/rpc', now: () => now, hashCode: (code) => (fakeHashes[code] ?? '0xbb'.repeat(32)) as Hex });
  });

  it('accepts the verified deployment at one pinned block; checks the golden prediction ID', async () => {
    const snapshot = await probe.probe(payload, SIGNER);
    expect(snapshot).toMatchObject({ chainId: 137, wallet: expect.stringMatching(/^0x94bf/i), signer: SIGNER, nonce: 4n, blockNumber: BLOCK });
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'predictWalletAddress', args: [`0x${'0'.repeat(62)}01`], blockNumber: BLOCK }));
    for (const call of [...client.getCode.mock.calls, ...client.getStorageAt.mock.calls, ...client.readContract.mock.calls]) expect(call[0].blockNumber).toBe(BLOCK);
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: POLYMARKET_DEPOSIT_BEACON, functionName: 'implementation', account: expect.stringMatching(/^0x94bf/i), blockNumber: BLOCK }));
    probe.assertFresh(snapshot, payload, SIGNER);
    expect(expectedBeaconProxyRuntime(POLYMARKET_DEPOSIT_BEACON, POLYMARKET_DEPOSIT_FACTORY, snapshot.id)).toHaveLength(2 + 146 * 2);
    const oracleRuntime = `0x363d3d373d3d363d602036600436635c60da1b60e01b36527fa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50545afa5036515af43d6000803e604d573d6000fd5b3d6000f3${'0'.repeat(24)}${POLYMARKET_DEPOSIT_FACTORY.slice(2).toLowerCase()}${'0'.repeat(62)}01`;
    expect(expectedBeaconProxyRuntime(POLYMARKET_DEPOSIT_BEACON, POLYMARKET_DEPOSIT_FACTORY, snapshot.id)).toBe(oracleRuntime);
  });

  it('rejects a same-height reorg during probe and a reorg after execute eth_call', async () => {
    state.probeReorg = true;
    await expect(probe.probe(payload, SIGNER)).rejects.toBeInstanceOf(ServiceUnavailableException);
    state.probeReorg = false;
    const snapshot = await probe.probe(payload, SIGNER);
    state.simulationReorg = true;
    await expect(probe.simulate(payload, '0x1234', snapshot)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects factory upgrades even when proxy runtime is unchanged', async () => {
    state.factoryImplCode = '0xchanged';
    await expect(probe.probe(payload, SIGNER)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects changed beacon defaults or per-wallet pins', async () => {
    state.beaconDefault = '0x1111111111111111111111111111111111111111';
    await expect(probe.probe(payload, SIGNER)).rejects.toBeInstanceOf(ServiceUnavailableException);
    state.beaconDefault = POLYMARKET_DEPOSIT_CURRENT_IMPLEMENTATION;
    state.beaconPinned = '0x1111111111111111111111111111111111111111';
    await expect(probe.probe(payload, SIGNER)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects wallet implementation overrides, counterfeit getters/runtime, and nonce changes', async () => {
    state.walletImplSlot = `0x${'00'.repeat(12)}1111111111111111111111111111111111111111`;
    await expect(probe.probe(payload, SIGNER)).rejects.toBeInstanceOf(ServiceUnavailableException);
    state.walletImplSlot = undefined;
    await expect(probe.probe(payload, SIGNER)).rejects.toBeInstanceOf(ServiceUnavailableException);
    state.walletImplSlot = `0x${'00'.repeat(32)}`;
    state.owner = '0x1111111111111111111111111111111111111111';
    await expect(probe.probe(payload, SIGNER)).rejects.toBeInstanceOf(ServiceUnavailableException);
    state.owner = SIGNER;
    state.walletCode = '0x6000';
    await expect(probe.probe(payload, SIGNER)).rejects.toBeInstanceOf(ServiceUnavailableException);
    state.walletCode = expectedBeaconProxyRuntime(POLYMARKET_DEPOSIT_BEACON, POLYMARKET_DEPOSIT_FACTORY, `0x${'0'.repeat(62)}01`);
    state.nonce = 5n;
    await expect(probe.probe(payload, SIGNER)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects paused wallets and failing execute eth_call without broadcasting', async () => {
    state.paused = 1n;
    await expect(probe.probe(payload, SIGNER)).rejects.toBeInstanceOf(ServiceUnavailableException);
    state.paused = 0n;
    const snapshot = await probe.probe(payload, SIGNER);
    state.failCall = true;
    await expect(probe.simulate(payload, '0x1234', snapshot)).rejects.toBeInstanceOf(ServiceUnavailableException);
    state.failCall = false;
    const signature = '0x123456' as Hex;
    await probe.simulate(payload, signature, snapshot);
    const [callArgs] = client.call.mock.calls.at(-1) as any[];
    const decoded = decodeFunctionData({ abi: [{ type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ name: '_batch', type: 'tuple', components: [{ name: 'wallet', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }] }, { name: '_signature', type: 'bytes' }], outputs: [] }] as const, data: callArgs.data });
    expect(decoded.args).toEqual([{ wallet: snapshot.wallet, nonce: 4n, deadline: BigInt(payload.message.deadline), calls: [{ target: payload.message.calls[0].target, value: 0n, data: '0x1234' }] }, signature]);
    expect(callArgs).toMatchObject({ account: POLYMARKET_DEPOSIT_FACTORY, to: expect.stringMatching(/^0x94bf/i), blockNumber: BLOCK });
    expect(client).not.toHaveProperty('sendTransaction');
  });

  it('rechecks freshness and deadline after simulation without renewing the probe timestamp', async () => {
    const snapshot = await probe.probe(payload, SIGNER);
    state.advanceDuringCall = 16_000;
    await expect(probe.verifySignature(payload, SIGNER, '0x1234', snapshot)).rejects.toBeInstanceOf(ServiceUnavailableException);
    now = NOW;
    state.advanceDuringCall = 121_000;
    const second = await probe.probe(payload, SIGNER);
    await expect(probe.verifySignature(payload, SIGNER, '0x1234', second)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('compares stable deployment identity and nonce across re-probes', async () => {
    const snapshot = await probe.probe(payload, SIGNER);
    await expect(probe.assertUnchanged(snapshot, payload, SIGNER)).resolves.toMatchObject({ nonce: 4n });
    state.nonce = 5n;
    await expect(probe.assertUnchanged(snapshot, payload, SIGNER)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
