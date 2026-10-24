import type { ValidatedPolymarketDepositBatch } from '../defi/signing/polymarket-deposit-batch';
import type { PolymarketDepositBatchDeploymentSnapshot } from './polymarket-deposit-batch-deployment';
import type { Address, Hex } from 'viem';

export const POLYMARKET_DEPOSIT_BATCH_EVIDENCE_MAX_AGE_MS = 15_000;

/** Full immutable RPC probe, including its complete Beacon/factory/wallet deployment identity. */
export type PolymarketDepositBatchEvidence = Readonly<{
  deployment: PolymarketDepositBatchDeploymentSnapshot;
  payloadDigest: Hex;
  deadline: string;
  signerAddress: Address;
}>;

/** Verification contract for the separately owned DepositWallet RPC/provider lane. */
export interface PolymarketDepositBatchVerifier {
  /** Probe identity, predicted wallet, runtime and current nonce at one pinned Polygon block; nonce must equal payload.message.nonce, not nonce+1. Reject paused wallets. */
  verify(payload: ValidatedPolymarketDepositBatch, signer: string): Promise<PolymarketDepositBatchEvidence>;
  /** Local-only checks including payload/signer binding, pinned block identity, RPC fingerprint, and <=15s age; no RPC while locks are held. */
  assertFresh(evidence: PolymarketDepositBatchEvidence, payload: ValidatedPolymarketDepositBatch, signer: string): void;
  /** Recheck chain identity/current nonce and paused state, then call wallet.execute via eth_call with from=factory; never use operator authorization or broadcast. */
  verifySignature(payload: ValidatedPolymarketDepositBatch, signer: string, signature: `0x${string}`, evidence: PolymarketDepositBatchEvidence): Promise<void>;
}
