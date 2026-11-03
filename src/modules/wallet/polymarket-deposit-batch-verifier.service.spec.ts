import { ServiceUnavailableException } from '@nestjs/common';
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { validatePolymarketDepositBatch } from '../defi/signing/polymarket-deposit-batch';
import {
  expectedBeaconProxyRuntime,
  PolymarketDepositBatchDeploymentProbe,
  POLYMARKET_DEPOSIT_BEACON,
  POLYMARKET_DEPOSIT_CURRENT_IMPLEMENTATION,
  POLYMARKET_DEPOSIT_FACTORY,
} from './polymarket-deposit-batch-deployment';
import { PolymarketDepositBatchVerifierService } from './polymarket-deposit-batch-verifier.service';

const NOW = 1_800_000_000_000;
const SIGNER = '0x0000000000000000000000000000000000000001' as Address;
const WALLET = '0x94bf330955a0b957662feaf878de77bf25f76cd9' as Address;
const FACTORY_IMPL = '0x528CC05EFac2B0d255e423272187efD41248aBd7' as Address;
const HASH = {
  factory: '0xaaa52c8cc8a0e3fd27ce756cc6b4e70c51423e9b597b11f32d3e49f8b1fc890d',
  factoryImpl: '0xe6424f1008e46b4b657efacf9500ea7747cbbf3055d9d76459253ac2884793d2',
  beacon: '0xf87b06a1302051471df08ff79a938757509569e16b7a7efa55a3ea7b29b0b9d1',
  implementation: '0xf5c1072460e64902af84d35f5bb1d0a15d80a88c5827b831a977fbc5a0684b96',
  wallet: `0x${'aa'.repeat(32)}`,
} as const;
const RPC = 'https://polygon.example/rpc';
const RAW_SIGNATURE = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b` as Hex;

const makePayload = () => validatePolymarketDepositBatch({
  domain: { name: 'DepositWallet', version: '1', chainId: 137, verifyingContract: WALLET },
  types: {
    Call: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }],
    Batch: [{ name: 'wallet', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'calls', type: 'Call[]' }],
  },
  primaryType: 'Batch',
  message: {
    wallet: WALLET,
    nonce: '4',
    deadline: String(NOW / 1000 + 120),
    calls: [{ target: '0x2222222222222222222222222222222222222222', value: '0', data: encodeFunctionData({ abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }] as const, functionName: 'approve', args: ['0x3333333333333333333333333333333333333333', 5n] }) }],
  },
}, NOW);

describe('PolymarketDepositBatchVerifierService', () => {
  let now: number;
  let config: { get: jest.Mock };
  let state: Record<string, any>;
  let client: any;
  let deploymentProbe: PolymarketDepositBatchDeploymentProbe;
  let verifier: PolymarketDepositBatchVerifierService;

  beforeEach(() => {
    jest.clearAllMocks();
    now = NOW;
    config = { get: jest.fn((key: string) => key === 'rpc.urls.137' ? RPC : undefined) };
    const id = `0x${SIGNER.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
    state = {
      nonce: 4n,
      paused: 0n,
      factoryImplCode: '0xf002',
      beaconDefault: POLYMARKET_DEPOSIT_CURRENT_IMPLEMENTATION,
      beaconPinned: POLYMARKET_DEPOSIT_CURRENT_IMPLEMENTATION,
      walletCode: expectedBeaconProxyRuntime(POLYMARKET_DEPOSIT_BEACON, POLYMARKET_DEPOSIT_FACTORY, id),
      failCall: false,
    };
    const word = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
    client = {
      getChainId: jest.fn(async () => 137),
      getBlock: jest.fn(async () => ({ number: 900n, hash: `0x${'11'.repeat(32)}`, timestamp: BigInt(Math.floor(now / 1000)) })),
      getCode: jest.fn(async ({ address }: any) => {
        const a = address.toLowerCase();
        if (a === POLYMARKET_DEPOSIT_FACTORY.toLowerCase()) return '0xf001';
        if (a === FACTORY_IMPL.toLowerCase()) return state.factoryImplCode;
        if (a === POLYMARKET_DEPOSIT_BEACON.toLowerCase()) return '0xf003';
        if (a === POLYMARKET_DEPOSIT_CURRENT_IMPLEMENTATION.toLowerCase()) return '0xf004';
        if (a === WALLET.toLowerCase()) return state.walletCode;
        return '0x';
      }),
      getStorageAt: jest.fn(async ({ address, slot }: any) => {
        if (address.toLowerCase() === POLYMARKET_DEPOSIT_FACTORY.toLowerCase()) return word(FACTORY_IMPL);
        if (address.toLowerCase() === POLYMARKET_DEPOSIT_BEACON.toLowerCase()) return word(state.beaconDefault);
        if (slot === '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50') return word(POLYMARKET_DEPOSIT_BEACON);
        return `0x${'00'.repeat(32)}`;
      }),
      readContract: jest.fn(async ({ address, functionName }: any) => {
        if (address.toLowerCase() === POLYMARKET_DEPOSIT_FACTORY.toLowerCase()) return functionName === 'BEACON' ? POLYMARKET_DEPOSIT_BEACON : WALLET;
        if (address.toLowerCase() === POLYMARKET_DEPOSIT_BEACON.toLowerCase()) return functionName === 'defaultImplementation' ? state.beaconDefault : state.beaconPinned;
        if (functionName === 'owner') return SIGNER;
        if (functionName === 'factory') return POLYMARKET_DEPOSIT_FACTORY;
        if (functionName === 'id') return id;
        if (functionName === 'nonce') return state.nonce;
        if (functionName === 'paused') return state.paused;
        throw new Error('unexpected read');
      }),
      call: jest.fn(async () => {
        if (state.failCall) throw new Error('reverted with signature bytes');
        return { data: '0x' };
      }),
    };
    const hashes: Record<string, string> = { '0xf001': HASH.factory, '0xf002': HASH.factoryImpl, '0xf003': HASH.beacon, '0xf004': HASH.implementation, [state.walletCode]: HASH.wallet };
    class TestVerifier extends PolymarketDepositBatchVerifierService {
      protected currentTime() { return now; }
      protected createProbe(rpcUrl: string) {
        const probe = new PolymarketDepositBatchDeploymentProbe({ client, rpcUrl, now: () => now, hashCode: (code) => (hashes[code] ?? `0x${'bb'.repeat(32)}`) as Hex });
        deploymentProbe = probe;
        return probe;
      }
    }
    verifier = new TestVerifier(config as any);
  });

  it('probes full deployment identity, preserves frozen snapshot, and verifies execution without broadcasting', async () => {
    const payload = makePayload();
    const evidence = await verifier.verify(payload, SIGNER);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.deployment)).toBe(true);
    expect(evidence.deployment).toMatchObject({ chainId: 137, signer: SIGNER, nonce: 4n, executionWalletPaused: false, blockNumber: 900n });
    expect(evidence.deployment.wallet.toLowerCase()).toBe(WALLET.toLowerCase());
    await verifier.assertFresh(evidence, payload, SIGNER);
    await verifier.verifySignature(payload, SIGNER, RAW_SIGNATURE, evidence);
    expect(client.call).toHaveBeenCalledWith(expect.objectContaining({ account: POLYMARKET_DEPOSIT_FACTORY, to: evidence.deployment.wallet, blockNumber: 900n, data: expect.stringMatching(/^0x/) }));
    expect(client.call.mock.calls[0][0].data).toContain(RAW_SIGNATURE.slice(2));
    expect(client).not.toHaveProperty('sendTransaction');
  });

  it('rejects nonce, runtime and beacon implementation drift at probe/reprobe', async () => {
    const payload = makePayload();
    state.nonce = 5n;
    await expect(verifier.verify(payload, SIGNER)).rejects.toBeInstanceOf(ServiceUnavailableException);
    state.nonce = 4n;
    state.factoryImplCode = '0xchanged';
    await expect(verifier.verify(payload, SIGNER)).rejects.toBeInstanceOf(ServiceUnavailableException);
    state.factoryImplCode = '0xf002';
    const evidence = await verifier.verify(payload, SIGNER);
    state.beaconPinned = '0x1111111111111111111111111111111111111111';
    await expect(verifier.verifySignature(payload, SIGNER, RAW_SIGNATURE, evidence)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(client.call).not.toHaveBeenCalled();
  });

  it('rejects paused wallets and stale, changed-RPC, changed-payload, or changed-signer evidence', async () => {
    const payload = makePayload();
    state.paused = 1n;
    await expect(verifier.verify(payload, SIGNER)).rejects.toBeInstanceOf(ServiceUnavailableException);
    state.paused = 0n;
    const evidence = await verifier.verify(payload, SIGNER);
    now += 15_001;
    expect(() => verifier.assertFresh(evidence, payload, SIGNER)).toThrow(ServiceUnavailableException);
    now = NOW;
    config.get.mockReturnValueOnce('https://other.example/rpc');
    expect(() => verifier.assertFresh(evidence, payload, SIGNER)).toThrow(ServiceUnavailableException);
    const changedPayload = validatePolymarketDepositBatch({ ...payload, message: { ...payload.message, deadline: String(NOW / 1000 + 121) } }, NOW);
    await expect(verifier.verifySignature(changedPayload, SIGNER, RAW_SIGNATURE, evidence)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(verifier.verifySignature(payload, '0x0000000000000000000000000000000000000002', RAW_SIGNATURE, evidence)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('withholds signatures when execute eth_call reverts, without logging provider details', async () => {
    const payload = makePayload();
    const evidence = await verifier.verify(payload, SIGNER);
    state.failCall = true;
    await expect(verifier.verifySignature(payload, SIGNER, '0x1234', evidence)).rejects.toMatchObject({
      response: { code: 'POLYMARKET_SIGNING_FAILED', message: expect.not.stringContaining('signature bytes') },
    });
  });

  it.each([
    ['deadline', (payload: ReturnType<typeof makePayload>) => { now = Number(payload.message.deadline) * 1000 + 1; }],
    ['15-second evidence freshness', () => { now += 15_001; }],
  ])('rejects a successful async simulation that crosses %s', async (_label, advanceClock) => {
    const payload = makePayload();
    const evidence = await verifier.verify(payload, SIGNER);
    jest.spyOn(deploymentProbe, 'verifySignature').mockImplementation(async () => advanceClock(payload));
    await expect(verifier.verifySignature(payload, SIGNER, RAW_SIGNATURE, evidence)).rejects.toMatchObject({
      response: { code: 'POLYMARKET_SIGNING_FAILED' },
    });
  });
});
