import { ServiceUnavailableException } from '@nestjs/common';
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  stringToHex,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import type { ValidatedPolymarketDepositBatch } from '../defi/signing/polymarket-deposit-batch';

export const POLYMARKET_POLYGON_CHAIN_ID = 137 as const;
export const POLYMARKET_DEPOSIT_FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07' as Address;
export const POLYMARKET_DEPOSIT_BEACON = '0x7A18EDfe055488A3128f01F563e5B479D92ffc3a' as Address;
export const POLYMARKET_DEPOSIT_CURRENT_IMPLEMENTATION = '0xf7f27C29e60fe6325beF8dA7F93250353d2e3294' as Address;

const FACTORY_PROXY_HASH = '0xaaa52c8cc8a0e3fd27ce756cc6b4e70c51423e9b597b11f32d3e49f8b1fc890d';
const FACTORY_IMPLEMENTATION_HASH = '0xe6424f1008e46b4b657efacf9500ea7747cbbf3055d9d76459253ac2884793d2';
const BEACON_CODE_HASH = '0xf87b06a1302051471df08ff79a938757509569e16b7a7efa55a3ea7b29b0b9d1';
const CURRENT_IMPLEMENTATION_HASH = '0xf5c1072460e64902af84d35f5bb1d0a15d80a88c5827b831a977fbc5a0684b96';
const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex;
const ERC1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50' as Hex;
// Solady UpgradeableBeacon's namespaced slot, verified against the factory's bundled LibClone source.
const BEACON_IMPLEMENTATION_SLOT = `0x${'0'.repeat(32 - 18)}911c5a209f08d5ec5e` as Hex;

const FACTORY_ABI = [
  { type: 'function', name: 'predictWalletAddress', stateMutability: 'view', inputs: [{ name: '_id', type: 'bytes32' }], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'BEACON', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;
const WALLET_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'id', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bytes32' }] },
  { type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'execute', stateMutability: 'nonpayable', inputs: [{ name: '_batch', type: 'tuple', components: [{ name: 'wallet', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }] }, { name: '_signature', type: 'bytes' }], outputs: [] },
] as const;
const BEACON_ABI = [
  { type: 'function', name: 'defaultImplementation', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'implementation', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;

export type PolymarketDepositBatchDeploymentSnapshot = Readonly<{
  chainId: 137;
  wallet: Address;
  signer: Address;
  id: Hex;
  factoryAddress: Address;
  factoryBeaconAddress: Address;
  nonce: bigint;
  executionWalletPaused: false;
  blockNumber: bigint;
  blockHash: Hex;
  blockTimestamp: bigint;
  checkedAt: number;
  rpcFingerprint: Hex;
  factoryProxyCodeHash: Hex;
  factoryImplementation: Address;
  factoryImplementationCodeHash: Hex;
  beaconCodeHash: Hex;
  beaconDefaultImplementation: Address;
  beaconPinnedImplementation: Address;
  currentImplementationCodeHash: Hex;
  walletBeaconAddress: Address;
  walletCodeHash: Hex;
  identityDigest: Hex;
}>;

export type PolymarketDepositBatchDeploymentOptions = Readonly<{
  client: PublicClient;
  rpcUrl: string;
  now?: () => number;
  /** Test seam; production callers should use the default keccak implementation. */
  hashCode?: (code: Hex) => Hex;
}>;

/** Polygon-only, pinned-block deployment probe. It never submits a transaction. */
export class PolymarketDepositBatchDeploymentProbe {
  private readonly now: () => number;
  private readonly codeHash: (code: Hex) => Hex;
  constructor(private readonly options: PolymarketDepositBatchDeploymentOptions) {
    this.now = options.now ?? Date.now;
    this.codeHash = options.hashCode ?? hashCode;
  }

  async probe(payload: ValidatedPolymarketDepositBatch, signerInput: string): Promise<PolymarketDepositBatchDeploymentSnapshot> {
    try {
      const client = this.options.client;
      const signer = getAddress(signerInput);
      if (await client.getChainId() !== POLYMARKET_POLYGON_CHAIN_ID) throw new Error('wrong chain');
      const block = await client.getBlock({ blockTag: 'latest' });
      if (block.number === null || block.hash === null || block.timestamp === undefined) throw new Error('missing block identity');
      const wallet = getAddress(payload.message.wallet);
      if (getAddress(payload.domain.verifyingContract) !== wallet) throw new Error('wallet mismatch');
      const id = `0x${signer.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
      const blockNumber = block.number;

      const [factoryCode, factoryImplSlot, factoryBeacon, predictedWallet] = await Promise.all([
        client.getCode({ address: POLYMARKET_DEPOSIT_FACTORY, blockNumber }),
        client.getStorageAt({ address: POLYMARKET_DEPOSIT_FACTORY, slot: ERC1967_IMPLEMENTATION_SLOT, blockNumber }),
        client.readContract({ address: POLYMARKET_DEPOSIT_FACTORY, abi: FACTORY_ABI, functionName: 'BEACON', blockNumber }),
        client.readContract({ address: POLYMARKET_DEPOSIT_FACTORY, abi: FACTORY_ABI, functionName: 'predictWalletAddress', args: [id], blockNumber }),
      ]);
      const factoryImplementation = addressFromSlot(factoryImplSlot);
      if (!factoryCode || this.codeHash(factoryCode) !== FACTORY_PROXY_HASH || !factoryImplementation || factoryImplementation.toLowerCase() === POLYMARKET_DEPOSIT_FACTORY.toLowerCase()) throw new Error('factory proxy mismatch');
      const factoryImplementationCode = await client.getCode({ address: factoryImplementation, blockNumber });
      if (!factoryImplementationCode || this.codeHash(factoryImplementationCode) !== FACTORY_IMPLEMENTATION_HASH) throw new Error('factory implementation mismatch');
      if (getAddress(factoryBeacon) !== POLYMARKET_DEPOSIT_BEACON || getAddress(predictedWallet) !== wallet) throw new Error('factory prediction mismatch');

      const [beaconCode, beaconImplementationSlot, beaconDefault, beaconPinned, walletCode, walletImplementationSlot, walletBeaconSlot] = await Promise.all([
        client.getCode({ address: POLYMARKET_DEPOSIT_BEACON, blockNumber }),
        client.getStorageAt({ address: POLYMARKET_DEPOSIT_BEACON, slot: BEACON_IMPLEMENTATION_SLOT, blockNumber }),
        client.readContract({ address: POLYMARKET_DEPOSIT_BEACON, abi: BEACON_ABI, functionName: 'defaultImplementation', blockNumber }),
        client.readContract({ address: POLYMARKET_DEPOSIT_BEACON, abi: BEACON_ABI, functionName: 'implementation', account: wallet, blockNumber }),
        client.getCode({ address: wallet, blockNumber }),
        client.getStorageAt({ address: wallet, slot: ERC1967_IMPLEMENTATION_SLOT, blockNumber }),
        client.getStorageAt({ address: wallet, slot: ERC1967_BEACON_SLOT, blockNumber }),
      ]);
      if (!beaconCode || this.codeHash(beaconCode) !== BEACON_CODE_HASH) throw new Error('beacon mismatch');
      const slotImplementation = addressFromSlot(beaconImplementationSlot);
      if (!slotImplementation || getAddress(beaconDefault) !== slotImplementation || getAddress(beaconPinned) !== slotImplementation) throw new Error('beacon dispatch mismatch');
      if (getAddress(beaconDefault) !== POLYMARKET_DEPOSIT_CURRENT_IMPLEMENTATION || getAddress(beaconPinned) !== POLYMARKET_DEPOSIT_CURRENT_IMPLEMENTATION) throw new Error('unsupported implementation');
      const implementationCode = await client.getCode({ address: POLYMARKET_DEPOSIT_CURRENT_IMPLEMENTATION, blockNumber });
      if (!implementationCode || this.codeHash(implementationCode) !== CURRENT_IMPLEMENTATION_HASH) throw new Error('unsupported implementation code');
      if (!walletCode || this.codeHash(walletCode) !== this.codeHash(expectedBeaconProxyRuntime(POLYMARKET_DEPOSIT_BEACON, getAddress(POLYMARKET_DEPOSIT_FACTORY), id))) throw new Error('wallet runtime mismatch');
      if (!isCanonicalZeroSlot(walletImplementationSlot)) throw new Error('wallet implementation override or malformed slot');
      if (!walletBeaconSlot || addressFromSlot(walletBeaconSlot) !== POLYMARKET_DEPOSIT_BEACON) throw new Error('wallet beacon slot mismatch');

      const [owner, factory, walletId, nonce, paused] = await Promise.all([
        client.readContract({ address: wallet, abi: WALLET_ABI, functionName: 'owner', blockNumber }),
        client.readContract({ address: wallet, abi: WALLET_ABI, functionName: 'factory', blockNumber }),
        client.readContract({ address: wallet, abi: WALLET_ABI, functionName: 'id', blockNumber }),
        client.readContract({ address: wallet, abi: WALLET_ABI, functionName: 'nonce', blockNumber }),
        client.readContract({ address: wallet, abi: WALLET_ABI, functionName: 'paused', blockNumber }),
      ]);
      if (getAddress(owner) !== signer || getAddress(factory) !== POLYMARKET_DEPOSIT_FACTORY || walletId.toLowerCase() !== id.toLowerCase() || nonce !== BigInt(payload.message.nonce) || paused !== 0n) throw new Error('wallet identity, nonce, or pause mismatch');
      await this.assertCanonicalBlock(blockNumber, block.hash, block.timestamp);
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0 || now - Number(block.timestamp) * 1000 < 0 || now - Number(block.timestamp) * 1000 > 60_000) throw new Error('stale chain block');
      const common = { chainId: 137 as const, wallet, signer, id, factoryAddress: POLYMARKET_DEPOSIT_FACTORY, factoryBeaconAddress: getAddress(factoryBeacon), nonce, executionWalletPaused: false as const, blockNumber, blockHash: block.hash, blockTimestamp: block.timestamp, checkedAt: now, rpcFingerprint: keccak256(stringToHex(this.options.rpcUrl)), factoryProxyCodeHash: this.codeHash(factoryCode), factoryImplementation, factoryImplementationCodeHash: this.codeHash(factoryImplementationCode), beaconCodeHash: this.codeHash(beaconCode), beaconDefaultImplementation: getAddress(beaconDefault), beaconPinnedImplementation: getAddress(beaconPinned), currentImplementationCodeHash: this.codeHash(implementationCode), walletBeaconAddress: addressFromSlot(walletBeaconSlot)!, walletCodeHash: this.codeHash(walletCode) };
      return Object.freeze({ ...common, identityDigest: identityDigest(common) });
    } catch {
      throw unavailable();
    }
  }

  async assertCanonicalBlock(blockNumber: bigint, expectedHash: Hex, expectedTimestamp: bigint): Promise<void> {
    const canonical = await this.options.client.getBlock({ blockNumber });
    if (canonical.number !== blockNumber || canonical.hash === null || canonical.hash.toLowerCase() !== expectedHash.toLowerCase() || canonical.timestamp !== expectedTimestamp) throw unavailable();
  }

  /** Adapter-friendly alias: complete identity snapshot, not the smaller public evidence projection. */
  verify(payload: ValidatedPolymarketDepositBatch, signer: string): Promise<PolymarketDepositBatchDeploymentSnapshot> {
    return this.probe(payload, signer);
  }

  assertFresh(snapshot: PolymarketDepositBatchDeploymentSnapshot, payload: ValidatedPolymarketDepositBatch, signer: string): void {
    const now = this.now();
    if (snapshot.signer.toLowerCase() !== signer.toLowerCase() || snapshot.wallet.toLowerCase() !== payload.message.wallet.toLowerCase() || snapshot.nonce !== BigInt(payload.message.nonce) || snapshot.rpcFingerprint !== keccak256(stringToHex(this.options.rpcUrl)) || !Number.isSafeInteger(now) || now < snapshot.checkedAt || now - snapshot.checkedAt > 15_000 || now - Number(snapshot.blockTimestamp) * 1000 < 0 || now - Number(snapshot.blockTimestamp) * 1000 > 60_000 || BigInt(payload.message.deadline) < snapshot.blockTimestamp || BigInt(payload.message.deadline) <= BigInt(Math.floor(now / 1000)) || snapshot.identityDigest !== identityDigest(snapshot)) throw unavailable();
  }

  /** Re-read the deployment and reject any ownership/runtime/implementation/nonce identity drift. */
  async assertUnchanged(snapshot: PolymarketDepositBatchDeploymentSnapshot, payload: ValidatedPolymarketDepositBatch, signer: string): Promise<PolymarketDepositBatchDeploymentSnapshot> {
    const latest = await this.probe(payload, signer);
    const stable = (value: PolymarketDepositBatchDeploymentSnapshot) => ({
      chainId: value.chainId, wallet: value.wallet, signer: value.signer, id: value.id, factoryAddress: value.factoryAddress,
      factoryBeaconAddress: value.factoryBeaconAddress, nonce: value.nonce, executionWalletPaused: value.executionWalletPaused,
      rpcFingerprint: value.rpcFingerprint, factoryProxyCodeHash: value.factoryProxyCodeHash,
      factoryImplementation: value.factoryImplementation, factoryImplementationCodeHash: value.factoryImplementationCodeHash,
      beaconCodeHash: value.beaconCodeHash, beaconDefaultImplementation: value.beaconDefaultImplementation,
      beaconPinnedImplementation: value.beaconPinnedImplementation, currentImplementationCodeHash: value.currentImplementationCodeHash,
      walletBeaconAddress: value.walletBeaconAddress, walletCodeHash: value.walletCodeHash,
    });
    const encode = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);
    if (encode(stable(snapshot)) !== encode(stable(latest))) throw unavailable();
    return latest;
  }

  /** Exact execute(Batch,bytes) eth_call from the factory against the same pinned block; never broadcasts. */
  async simulate(payload: ValidatedPolymarketDepositBatch, signature: Hex, snapshot: PolymarketDepositBatchDeploymentSnapshot): Promise<void> {
    try {
      const data = encodeFunctionData({ abi: WALLET_ABI, functionName: 'execute', args: [{ wallet: snapshot.wallet, nonce: BigInt(payload.message.nonce), deadline: BigInt(payload.message.deadline), calls: payload.message.calls.map((call) => ({ target: getAddress(call.target), value: BigInt(call.value), data: call.data })) }, signature] });
      await this.options.client.call({ account: POLYMARKET_DEPOSIT_FACTORY, to: snapshot.wallet, data, blockNumber: snapshot.blockNumber });
      await this.assertCanonicalBlock(snapshot.blockNumber, snapshot.blockHash, snapshot.blockTimestamp);
    } catch { throw unavailable(); }
  }

  /** Re-probe every deployment identity field and nonce, then perform a non-broadcast eth_call. */
  async verifySignature(payload: ValidatedPolymarketDepositBatch, signer: string, signature: Hex, snapshot: PolymarketDepositBatchDeploymentSnapshot): Promise<void> {
    this.assertFresh(snapshot, payload, signer);
    const latest = await this.assertUnchanged(snapshot, payload, signer);
    await this.simulate(payload, signature, latest);
    // Preserve the probe timestamp: simulation latency must not renew deployment evidence.
    this.assertFresh(latest, payload, signer);
  }
}

/** LibClone's verified initcode emits this exact ERC1967 beacon-proxy runtime with immutable args. */
export function expectedBeaconProxyRuntime(beacon: Address, factory: Address, id: Hex): Hex {
  const args = encodeAbiAddressBytes32(factory, id);
  void beacon; // Beacon is held in the ERC-1967 beacon storage slot, not embedded in runtime.
  return `0x363d3d373d3d363d602036600436635c60da1b60e01b36527fa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50545afa5036515af43d6000803e604d573d6000fd5b3d6000f3${args.slice(2)}`;
}

function encodeAbiAddressBytes32(address: Address, id: Hex): Hex { return `0x${address.slice(2).toLowerCase().padStart(64, '0')}${id.slice(2).toLowerCase()}`; }
function hashCode(code: Hex): Hex { return keccak256(toBytes(code)); }
function addressFromSlot(slot: Hex | undefined): Address | null {
  if (typeof slot !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(slot) || !/^0{24}$/i.test(slot.slice(2, 26))) return null;
  const address = slot.slice(-40);
  if (/^0{40}$/i.test(address)) return null;
  return getAddress(`0x${address}`);
}
function isCanonicalZeroSlot(slot: Hex | undefined): boolean { return typeof slot === 'string' && /^0x0{64}$/i.test(slot); }
function identityDigest(value: Omit<PolymarketDepositBatchDeploymentSnapshot, 'identityDigest'> | PolymarketDepositBatchDeploymentSnapshot): Hex {
  const { checkedAt: _checkedAt, identityDigest: _digest, ...identity } = value as PolymarketDepositBatchDeploymentSnapshot;
  void _checkedAt;
  void _digest;
  return keccak256(stringToHex(JSON.stringify(identity, (_, item) => typeof item === 'bigint' ? item.toString() : item)));
}
function unavailable(): ServiceUnavailableException { return new ServiceUnavailableException({ code: 'POLYMARKET_SIGNING_FAILED', message: 'Polymarket DepositWallet batch signing could not be verified' }); }
