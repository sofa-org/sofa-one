import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, http, TransactionReceiptNotFoundError, type Hex } from 'viem';
import { getSupportedChain } from '../../../common/chains/supported-chains';

/**
 * A single sanitized receipt log (never calldata or full payloads).
 *
 * `removed` is `boolean | undefined` because viem's `Log.removed` is optional
 * and may be absent on some providers. The claim path treats any value other
 * than the explicit boolean `false` as unsafe evidence (review/reject) — a
 * missing removal flag is never treated as an active log.
 */
export interface UsdcReceiptLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
  removed: boolean | undefined;
}

/**
 * Sanitized transaction receipt for USDC payment confirmation. Only the fields
 * needed for strict Transfer verification are exposed: status, transaction
 * hash, from/to, block number/hash/timestamp, and logs
 * (address/topics/data/logIndex/removed). No calldata, private keys, API keys,
 * or provider objects.
 */
export interface UsdcReceipt {
  status: 'success' | 'reverted';
  transactionHash: string;
  from: string;
  to: string | null;
  blockNumber: bigint;
  blockHash: string;
  blockTimestamp: bigint;
  logs: UsdcReceiptLog[];
}

/**
 * RPC boundary for USDC payment confirmation. Implementations must return
 * `null` for a not-found receipt (retryable) and throw for transient RPC
 * errors (retryable); they must never fabricate a receipt.
 */
export interface UsdcReceiptProvider {
  getTransactionReceipt(chainId: number, txHash: string): Promise<UsdcReceipt | null>;
  getBlockNumber(chainId: number): Promise<bigint>;
}

/**
 * viem-backed receipt provider. The RPC URL is always read from server
 * configuration (`billing.usdc.rpcUrls.<chainId>`) — never from the client —
 * and the chain comes from the supported-chains registry. A not-found receipt
 * is returned as `null` (classified by viem's official
 * `TransactionReceiptNotFoundError` type, never by matching error-message
 * text); any other provider error — including rate-limit errors whose message
 * happens to contain "not found" — propagates to the caller as a retryable RPC
 * error.
 */
@Injectable()
export class ViemUsdcReceiptProvider implements UsdcReceiptProvider {
  constructor(private readonly config: ConfigService) {}

  async getTransactionReceipt(chainId: number, txHash: string): Promise<UsdcReceipt | null> {
    const client = this.client(chainId);
    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
      if (!receipt) return null;
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      return {
        status: receipt.status === 'success' ? 'success' : 'reverted',
        transactionHash: receipt.transactionHash,
        from: receipt.from,
        to: receipt.to ?? null,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        blockTimestamp: block.timestamp,
        logs: receipt.logs.map((log) => ({
          address: log.address,
          topics: log.topics,
          data: log.data,
          logIndex: log.logIndex,
          removed: log.removed,
        })),
      };
    } catch (err) {
      // Only a genuine receipt-not-found is retryable-as-pending (null). Any
      // other provider error (rate limits, timeouts, connection failures, ...)
      // is rethrown so the caller treats it as a retryable RPC error.
      if (err instanceof TransactionReceiptNotFoundError) {
        return null;
      }
      throw err;
    }
  }

  async getBlockNumber(chainId: number): Promise<bigint> {
    return this.client(chainId).getBlockNumber();
  }

  private client(chainId: number) {
    const rpcUrl = this.config.get<string>(`billing.usdc.rpcUrls.${chainId}`);
    if (!rpcUrl) {
      throw new Error(`USDC RPC URL is not configured for chain ${chainId}`);
    }
    const { chain } = getSupportedChain(chainId);
    return createPublicClient({ chain, transport: http(rpcUrl) });
  }
}
