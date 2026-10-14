import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, http, keccak256, stringToHex, toBytes, type Address, type PublicClient } from 'viem';
import { polygon } from 'viem/chains';
import { polymarketDepositWalletAddress, type ValidatedPolymarketOrder } from '../defi/signing/polymarket-clob-order';

export type DepositWalletEvidence = Readonly<{
  agent: string;
  deposit: string;
  codeHash: string;
  checkedAt: number;
  rpcFingerprint: string;
}>;
const CODE_HASH = /^0x[0-9a-fA-F]{64}$/;

@Injectable()
export class PolymarketDepositWalletVerifierService {
  private client?: PublicClient;
  private clientRpc?: string;
  constructor(private readonly config: ConfigService) {}

  private getRpc(): string {
    const rpc = this.config.get<string>('simulation.rpcUrls.137');
    if (typeof rpc !== 'string' || !rpc.trim()) throw new ServiceUnavailableException('Polymarket deposit wallet verification unavailable');
    return rpc;
  }

  async verify(agentWalletAddress: string, payload: ValidatedPolymarketOrder): Promise<DepositWalletEvidence> {
    const deposit = polymarketDepositWalletAddress(payload);
    const agent = agentWalletAddress.toLowerCase();
    const rpc = this.getRpc();
    try {
      if (!this.client || this.clientRpc !== rpc) {
        this.client = createPublicClient({ chain: polygon, transport: http(rpc, { timeout: 5000 }) });
        this.clientRpc = rpc;
      }
      const chainId = await this.client.getChainId();
      if (chainId !== 137) throw new Error('chain mismatch');
      const code = await this.client.getCode({ address: deposit as Address });
      if (!code || code === '0x') throw new Error('missing runtime code');
      const codeHash = keccak256(toBytes(code));
      return Object.freeze({ agent, deposit: deposit.toLowerCase(), codeHash, checkedAt: Date.now(), rpcFingerprint: keccak256(stringToHex(rpc)) });
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('Polymarket deposit wallet verification unavailable');
    }
  }

  assertFresh(evidence: DepositWalletEvidence, agent: string, payload: ValidatedPolymarketOrder): void {
    const deposit = polymarketDepositWalletAddress(payload).toLowerCase();
    const rpc = this.getRpc();
    if (evidence.agent !== agent.toLowerCase() || evidence.deposit !== deposit || !CODE_HASH.test(evidence.codeHash) || evidence.rpcFingerprint !== keccak256(stringToHex(rpc)) || !Number.isFinite(evidence.checkedAt) || Date.now() - evidence.checkedAt < 0 || Date.now() - evidence.checkedAt > 15_000) {
      throw new ServiceUnavailableException('Polymarket deposit wallet verification expired');
    }
  }

  async verify1271(payload: ValidatedPolymarketOrder, orderDigest: `0x${string}`, envelope: `0x${string}`): Promise<void> {
    try {
      const deposit = polymarketDepositWalletAddress(payload) as Address;
      const result = await this.client!.readContract({ address: deposit, abi: [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'signature', type: 'bytes' }], outputs: [{ name: '', type: 'bytes4' }] }], functionName: 'isValidSignature', args: [orderDigest, envelope] });
      if (String(result).toLowerCase() !== '0x1626ba7e') throw new Error('invalid signature');
    } catch { throw new ServiceUnavailableException('Polymarket deposit wallet signature verification failed'); }
  }
}
