import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, http, type PublicClient } from 'viem';
import { polygon } from 'viem/chains';
import { polymarketDepositBatchDigest, type ValidatedPolymarketDepositBatch } from '../defi/signing/polymarket-deposit-batch';
import { PolymarketDepositBatchDeploymentProbe } from './polymarket-deposit-batch-deployment';
import {
  POLYMARKET_DEPOSIT_BATCH_EVIDENCE_MAX_AGE_MS,
  type PolymarketDepositBatchEvidence,
  type PolymarketDepositBatchVerifier,
} from './polymarket-deposit-batch-verifier.types';

const RPC_TIMEOUT_MS = 5_000;
const GENERIC_ERROR = 'Polymarket DepositWallet batch signing could not be verified';

@Injectable()
export class PolymarketDepositBatchVerifierService implements PolymarketDepositBatchVerifier {
  private client?: PublicClient;
  private clientRpc?: string;
  private probe?: PolymarketDepositBatchDeploymentProbe;
  private probeRpc?: string;

  constructor(private readonly config: ConfigService) {}

  async verify(payload: ValidatedPolymarketDepositBatch, signer: string): Promise<PolymarketDepositBatchEvidence> {
    try {
      const probe = this.getProbe();
      const deployment = await probe.verify(payload, signer);
      const evidence = Object.freeze({
        deployment,
        payloadDigest: polymarketDepositBatchDigest(payload),
        deadline: payload.message.deadline,
        signerAddress: deployment.signer,
      });
      probe.assertFresh(deployment, payload, signer);
      return evidence;
    } catch {
      throw unavailable();
    }
  }

  assertFresh(evidence: PolymarketDepositBatchEvidence, payload: ValidatedPolymarketDepositBatch, signer: string): void {
    try {
      const now = this.currentTime();
      if (!evidence || !evidence.deployment || evidence.payloadDigest !== polymarketDepositBatchDigest(payload)
        || evidence.deadline !== payload.message.deadline
        || evidence.signerAddress.toLowerCase() !== signer.toLowerCase()
        || !Number.isSafeInteger(evidence.deployment.checkedAt)
        || now < evidence.deployment.checkedAt
        || now - evidence.deployment.checkedAt > POLYMARKET_DEPOSIT_BATCH_EVIDENCE_MAX_AGE_MS) throw new Error('evidence mismatch');
      this.assertDeadline(payload, evidence.deployment.blockTimestamp);
      this.getProbe().assertFresh(evidence.deployment, payload, signer);
    } catch {
      throw unavailable();
    }
  }

  async verifySignature(payload: ValidatedPolymarketDepositBatch, signer: string, signature: `0x${string}`, evidence: PolymarketDepositBatchEvidence): Promise<void> {
    try {
      // Do not let async deployment re-probe/simulation start with already stale evidence.
      this.assertFresh(evidence, payload, signer);
      await this.getProbe().verifySignature(payload, signer, signature, evidence.deployment);
      // The helper checks the latest pinned snapshot during its simulation. Also require
      // the original RPC evidence to remain fresh; never refresh its checkedAt to hide age.
      this.assertFresh(evidence, payload, signer);
    } catch {
      throw unavailable();
    }
  }

  private assertDeadline(payload: ValidatedPolymarketDepositBatch, latestBlockTimestamp: bigint): void {
    const now = this.currentTime();
    const deadline = BigInt(payload.message.deadline);
    if (!Number.isSafeInteger(now) || now < 0 || deadline <= BigInt(Math.floor(now / 1000)) || deadline <= latestBlockTimestamp) {
      throw unavailable();
    }
  }

  protected createProbe(rpcUrl: string): PolymarketDepositBatchDeploymentProbe {
    return new PolymarketDepositBatchDeploymentProbe({ client: this.getClient(rpcUrl), rpcUrl });
  }

  protected currentTime(): number {
    return Date.now();
  }

  private getProbe(): PolymarketDepositBatchDeploymentProbe {
    const rpcUrl = this.config.get<string>('rpc.urls.137');
    if (typeof rpcUrl !== 'string' || !rpcUrl.trim()) throw unavailable();
    if (!this.probe || this.probeRpc !== rpcUrl) {
      this.probe = this.createProbe(rpcUrl);
      this.probeRpc = rpcUrl;
    }
    return this.probe;
  }

  private getClient(rpcUrl: string): PublicClient {
    if (!this.client || this.clientRpc !== rpcUrl) {
      this.client = createPublicClient({ chain: polygon, transport: http(rpcUrl, { timeout: RPC_TIMEOUT_MS }) });
      this.clientRpc = rpcUrl;
    }
    return this.client;
  }
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({ code: 'POLYMARKET_SIGNING_FAILED', message: GENERIC_ERROR });
}
