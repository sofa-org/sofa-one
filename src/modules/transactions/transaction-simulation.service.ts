import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  createPublicClient,
  ethAddress,
  getAddress,
  http,
  isAddress,
  type Hex,
  type PublicClient,
} from 'viem';
import { getSupportedChain } from '../../common/chains/supported-chains';
import { getErrorText, sanitizeErrorMessage } from '../../common/utils/sanitize';
// getErrorText/sanitizeErrorMessage are used only by assertSimulatable (legacy path).
// Asset-flow evidence failures log a fixed category only — never provider text.
import { SecurityEventService } from '../security-events/security-event.service';
import type { ExecutionMode, SendTransactionDto } from './dto/send-transaction.dto';
import {
  ASSET_FLOW_EVIDENCE_SCHEMA_VERSION,
  ASSET_FLOW_RULE_VERSION,
  buildAssetKey,
  computeAssetFlowPlanDigest,
  type AssetChangeEvidence,
  type AssetFlowEvidence,
  type AssetFlowExecutionMode,
  type AssetKind,
} from './transaction-asset-flow.verifier';

type TransactionSimulationContext = {
  userId: string;
  apiKeyId?: string;
  apiKeyPrefix?: string;
  chainId: number;
  executionMode: ExecutionMode;
  from: string;
};

export type SimulateAssetFlowEvidenceInput = {
  /** Full ordered interaction plan. */
  interactions: ReadonlyArray<{
    to: string;
    data: string;
    value?: string;
  }>;
  /** Trusted execution owner bound as simulateCalls account. */
  ownerAddress: string;
  chainId: number;
  executionMode: AssetFlowExecutionMode;
  /**
   * Explicit RPC endpoint. Required — default public `http()` transport is not
   * accepted as a safe dependency for asset-flow evidence.
   */
  rpcUrl: string;
};

/**
 * Production adapter evidence envelope.
 * Always sealed as `eth_simulateV1_non_atomic` with incomplete coverage unless
 * a future Phase 2 path supplies trusted atomic + complete coverage inputs.
 */
export type AssetFlowSimulationEvidence = AssetFlowEvidence;

/**
 * Identifiable failure for asset-flow evidence simulation.
 * Fixed category/message — never carries raw RPC text, stack, or calldata.
 * Callers must fail closed.
 */
export class AssetFlowSimulationUnavailableError extends Error {
  readonly code = 'ASSET_FLOW_SIMULATION_UNAVAILABLE' as const;
  readonly category = 'asset_flow_simulation_unavailable' as const;

  constructor() {
    super('Asset flow simulation unavailable');
    this.name = 'AssetFlowSimulationUnavailableError';
  }
}

const NATIVE_SENTINEL = ethAddress.toLowerCase();

@Injectable()
export class TransactionSimulationService {
  private readonly logger = new Logger(TransactionSimulationService.name);
  private readonly publicClients = new Map<number, PublicClient>();

  constructor(private readonly securityEvents?: SecurityEventService) {}

  async assertSimulatable(
    dto: SendTransactionDto,
    context: TransactionSimulationContext,
  ): Promise<void> {
    if (dto.interactions.length > 1) {
      await this.recordAllowedSimulation(dto, context, 'batch_simulation_deferred_to_bundler');
      return;
    }

    const client = this.getPublicClient(context.chainId);
    const account = getAddress(context.from);

    for (const [index, interaction] of dto.interactions.entries()) {
      try {
        await client.call({
          account,
          to: getAddress(interaction.to),
          data: interaction.data as Hex,
          value: BigInt(interaction.value ?? '0'),
        });
      } catch (error) {
        await this.rejectSimulation(error, context, index);
      }
    }

    await this.recordAllowedSimulation(dto, context, 'simulation_passed');
  }

  /**
   * Simulate the full interaction batch and seal owner-bound asset-flow evidence.
   *
   * Uses viem `simulateCalls` with `traceAssetChanges: true` and
   * `traceTransfers: true`. Production evidence is always:
   * - `simulationMode: eth_simulateV1_non_atomic` (not Calibur/EntryPoint atomic)
   * - coverage incomplete/unknown (simulateCalls is observation, not a completeness proof)
   * - empty relations (never invented)
   *
   * Must not be invoked inside a DB transaction. Throws
   * {@link AssetFlowSimulationUnavailableError} on missing rpcUrl, provider
   * failure, or malformed payload. Does not log raw RPC bodies or calldata.
   */
  async simulateAssetFlowEvidence(
    input: SimulateAssetFlowEvidenceInput,
  ): Promise<AssetFlowSimulationEvidence> {
    const rpcUrl = typeof input.rpcUrl === 'string' ? input.rpcUrl.trim() : '';
    if (!rpcUrl) {
      throw new AssetFlowSimulationUnavailableError();
    }

    if (!input.ownerAddress || !isAddress(input.ownerAddress)) {
      throw new AssetFlowSimulationUnavailableError();
    }

    if (input.executionMode !== 'session_key' && input.executionMode !== 'eoa') {
      throw new AssetFlowSimulationUnavailableError();
    }

    const interactions = Array.isArray(input.interactions) ? [...input.interactions] : [];
    if (interactions.length === 0) {
      throw new AssetFlowSimulationUnavailableError();
    }

    let chain: ReturnType<typeof getSupportedChain>['chain'];
    try {
      ({ chain } = getSupportedChain(input.chainId));
    } catch {
      throw new AssetFlowSimulationUnavailableError();
    }

    const ownerAddress = getAddress(input.ownerAddress);
    const planDigest = computeAssetFlowPlanDigest({
      ownerAddress,
      chainId: input.chainId,
      executionMode: input.executionMode,
      interactions,
    });
    if (!planDigest) {
      throw new AssetFlowSimulationUnavailableError();
    }

    const calls = interactions.map((interaction) => {
      if (!interaction?.to || !isAddress(interaction.to)) {
        throw new AssetFlowSimulationUnavailableError();
      }
      if (typeof interaction.data !== 'string') {
        throw new AssetFlowSimulationUnavailableError();
      }
      let value = 0n;
      try {
        value = BigInt(interaction.value ?? '0');
      } catch {
        throw new AssetFlowSimulationUnavailableError();
      }
      return {
        to: getAddress(interaction.to),
        data: interaction.data as Hex,
        value,
      };
    });

    // Fresh client bound to the explicit rpcUrl — never the default public http().
    const client = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });

    if (typeof client.simulateCalls !== 'function') {
      throw new AssetFlowSimulationUnavailableError();
    }

    let raw: unknown;
    try {
      raw = await client.simulateCalls({
        account: ownerAddress,
        calls,
        traceAssetChanges: true,
        traceTransfers: true,
      });
    } catch (error) {
      this.logAssetFlowSimulationFailure(error, {
        chainId: input.chainId,
        interactionCount: interactions.length,
      });
      throw new AssetFlowSimulationUnavailableError();
    }

    try {
      return this.toAssetFlowEvidence(raw, {
        chainId: input.chainId,
        ownerAddress,
        executionMode: input.executionMode,
        planDigest,
        expectedCallCount: interactions.length,
      });
    } catch (error) {
      if (error instanceof AssetFlowSimulationUnavailableError) {
        throw error;
      }
      this.logAssetFlowSimulationFailure(error, {
        chainId: input.chainId,
        interactionCount: interactions.length,
      });
      throw new AssetFlowSimulationUnavailableError();
    }
  }

  /**
   * Seal production evidence from a raw simulateCalls payload.
   *
   * Important: never mark coverage complete from simulateCalls alone.
   * Asset rows are best-effort observations; missing evidence is not zero-change.
   */
  private toAssetFlowEvidence(
    raw: unknown,
    meta: {
      chainId: number;
      ownerAddress: string;
      executionMode: AssetFlowExecutionMode;
      planDigest: string;
      expectedCallCount: number;
    },
  ): AssetFlowSimulationEvidence {
    if (!raw || typeof raw !== 'object') {
      throw new AssetFlowSimulationUnavailableError();
    }

    const payload = raw as {
      results?: unknown;
      assetChanges?: unknown;
      block?: { number?: unknown; hash?: unknown } | null;
    };

    if (!Array.isArray(payload.results)) {
      throw new AssetFlowSimulationUnavailableError();
    }
    if (payload.results.length !== meta.expectedCallCount) {
      throw new AssetFlowSimulationUnavailableError();
    }

    const results = (payload.results as unknown[]).map((entry: unknown) => {
      if (!entry || typeof entry !== 'object') {
        throw new AssetFlowSimulationUnavailableError();
      }
      const status = (entry as { status?: unknown }).status;
      if (typeof status !== 'string') {
        throw new AssetFlowSimulationUnavailableError();
      }
      // Status only — strip data / logs / error objects.
      return { status };
    });

    // Asset changes are optional observations. Absence → empty array with incomplete coverage
    // (never invent "complete zero-change").
    const assetChanges: AssetChangeEvidence[] = [];
    let assetCoverageCompleteness: 'incomplete' | 'unknown' = 'incomplete';
    const probedAssetKeys: string[] = [];
    const seenKeys = new Set<string>();

    if (payload.assetChanges == null) {
      assetCoverageCompleteness = 'unknown';
    } else if (!Array.isArray(payload.assetChanges)) {
      throw new AssetFlowSimulationUnavailableError();
    } else {
      for (const change of payload.assetChanges as unknown[]) {
        const parsed = this.parseObservedAssetChange(change, seenKeys);
        if (!parsed) {
          throw new AssetFlowSimulationUnavailableError();
        }
        probedAssetKeys.push(parsed.assetKey);
        // Keep zero-diff rows out of the change list but record probe key.
        if (parsed.diff !== 0n) {
          assetChanges.push(parsed);
        }
      }
      // Observations present still do not prove completeness (no full inventory probe).
      assetCoverageCompleteness = 'incomplete';
    }

    const simulatedBlock = this.extractBlockIdentity(payload.block);
    // M3: never copy simulated → base. eth_simulateV1 has no trusted baseline fork id.
    // Production baseline stays unavailable (null/null); missing baseline cannot be verified.
    const baseBlock = { number: null, hash: null };
    // Require a well-formed simulated block identity from the provider payload.
    if (simulatedBlock.number == null || simulatedBlock.hash == null) {
      throw new AssetFlowSimulationUnavailableError();
    }

    // Collect sanitized log presence only (count of log arrays if present on results).
    // Never copy log data / topics / calldata.
    let logCount = 0;
    let sawLogField = false;
    for (const entry of payload.results as unknown[]) {
      if (entry && typeof entry === 'object' && 'logs' in (entry as object)) {
        sawLogField = true;
        const logs = (entry as { logs?: unknown }).logs;
        if (Array.isArray(logs)) {
          logCount += logs.length;
        }
      }
    }

    const ownerNormalized = getAddress(meta.ownerAddress).toLowerCase();

    return {
      simulationMode: 'eth_simulateV1_non_atomic',
      binding: {
        ownerAddress: ownerNormalized,
        chainId: meta.chainId,
        executionMode: meta.executionMode,
        planDigest: meta.planDigest,
        schemaVersion: ASSET_FLOW_EVIDENCE_SCHEMA_VERSION,
        ruleVersion: ASSET_FLOW_RULE_VERSION,
        baseBlock,
        simulatedBlock,
      },
      coverage: {
        // Production simulateCalls cannot attest complete observation / call tree / permissions.
        assetObservation: {
          completeness: assetCoverageCompleteness,
          ...(probedAssetKeys.length > 0 ? { probedAssetKeys: [...probedAssetKeys] } : {}),
        },
        internalCalls: {
          completeness: 'unknown',
          observed: false,
        },
        permissions: {
          completeness: 'unknown',
        },
      },
      results,
      assetChanges,
      relations: [],
      logs: {
        completeness: sawLogField ? 'incomplete' : 'unknown',
        ...(sawLogField ? { count: logCount } : {}),
      },
    };
  }

  private parseObservedAssetChange(
    change: unknown,
    seenKeys: Set<string>,
  ): AssetChangeEvidence | null {
    if (!change || typeof change !== 'object') return null;
    const typed = change as {
      token?: { address?: unknown; decimals?: unknown; symbol?: unknown };
      value?: { pre?: unknown; post?: unknown; diff?: unknown };
    };
    if (!typed.token || !typed.value) return null;

    const addressRaw = typed.token.address;
    if (typeof addressRaw !== 'string' || !isAddress(addressRaw)) return null;
    const tokenAddress = getAddress(addressRaw).toLowerCase();

    const pre = asNonNegativeBigInt(typed.value.pre);
    const post = asNonNegativeBigInt(typed.value.post);
    const diff = asBigInt(typed.value.diff);
    if (pre == null || post == null || diff == null) return null;
    if (diff !== post - pre) return null;

    // viem uses eth sentinel for native; otherwise treat as ERC-20-like balanceOf.
    // ERC-721 tokenId is NOT provided by simulateCalls balanceOf inventory → cannot claim erc721.
    // Arbitrary balanceOf targets are not auto-trusted as complete inventory; they are
    // incomplete observations labeled erc20 when non-native (best-effort kind only).
    let kind: AssetKind;
    let tokenId: string | undefined;
    if (tokenAddress === NATIVE_SENTINEL) {
      kind = 'native';
    } else {
      kind = 'erc20';
    }

    const assetKey = buildAssetKey({ kind, tokenAddress, tokenId });
    if (!assetKey) return null;
    if (seenKeys.has(assetKey)) return null;
    seenKeys.add(assetKey);

    // Observation-only entry id — production evidence never carries verified authority.
    const entryId = `obs:${seenKeys.size}:${assetKey}`;

    return {
      entryId,
      assetKey,
      kind,
      tokenAddress: kind === 'native' ? ethAddress : getAddress(tokenAddress),
      pre,
      post,
      diff,
    };
  }

  private extractBlockIdentity(block: unknown): {
    number: bigint | null;
    hash: string | null;
  } {
    if (!block || typeof block !== 'object') {
      return { number: null, hash: null };
    }
    const b = block as { number?: unknown; hash?: unknown };
    let number: bigint | null = null;
    if (typeof b.number === 'bigint' && b.number >= 0n) {
      number = b.number;
    } else if (typeof b.number === 'number' && Number.isSafeInteger(b.number) && b.number >= 0) {
      number = BigInt(b.number);
    }
    const hash =
      typeof b.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(b.hash) ? b.hash.toLowerCase() : null;
    return { number, hash };
  }

  private logAssetFlowSimulationFailure(
    _error: unknown,
    context: { chainId: number; interactionCount: number },
  ): void {
    // M4: fixed category + safe metadata only. Never log provider text, calldata, or secrets.
    this.logger.warn({
      event: 'security',
      message: 'Asset flow simulation unavailable',
      category: 'asset_flow_simulation_unavailable',
      chainId: context.chainId,
      interactionCount: context.interactionCount,
    });
  }

  private async recordAllowedSimulation(
    dto: SendTransactionDto,
    context: TransactionSimulationContext,
    reason: 'simulation_passed' | 'batch_simulation_deferred_to_bundler',
  ): Promise<void> {
    await this.securityEvents?.record({
      actorType: 'api_key',
      eventType: 'transaction.simulation_allowed',
      userId: context.userId,
      apiKeyId: context.apiKeyId ?? null,
      riskLevel: 'low',
      result: 'allowed',
      reason,
      metadata: {
        chainId: context.chainId,
        executionMode: context.executionMode,
        apiKeyPrefix: context.apiKeyPrefix ?? null,
        interactionCount: dto.interactions.length,
        ...(dto.interactions.length > 1 ? { simulationMode: 'bundler_batch' } : {}),
      },
    });
  }

  private getPublicClient(chainId: number): PublicClient {
    const existing = this.publicClients.get(chainId);
    if (existing) return existing;
    const { chain } = getSupportedChain(chainId);
    const client = createPublicClient({ chain, transport: http() });
    this.publicClients.set(chainId, client);
    return client;
  }

  private async rejectSimulation(
    error: unknown,
    context: TransactionSimulationContext,
    interactionIndex: number,
  ): Promise<never> {
    const reason = sanitizeErrorMessage(getErrorText(error), 240);
    this.logger.warn({
      event: 'security',
      message: 'Transaction simulation rejected request',
      reason: reason || 'simulation_failed',
      userId: context.userId,
      apiKeyId: context.apiKeyId,
      apiKeyPrefix: context.apiKeyPrefix,
      chainId: context.chainId,
      executionMode: context.executionMode,
      interactionIndex,
    });

    await this.securityEvents?.record({
      actorType: 'api_key',
      eventType: 'transaction.simulation_denied',
      userId: context.userId,
      apiKeyId: context.apiKeyId ?? null,
      riskLevel: 'high',
      result: 'denied',
      reason: reason || 'simulation_failed',
      metadata: {
        chainId: context.chainId,
        executionMode: context.executionMode,
        apiKeyPrefix: context.apiKeyPrefix ?? null,
        interactionIndex,
      },
    });

    throw new BadRequestException('Transaction simulation failed. Check target contract calldata and permissions.');
  }
}

function asBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null;
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

function asNonNegativeBigInt(value: unknown): bigint | null {
  const n = asBigInt(value);
  if (n == null || n < 0n) return null;
  return n;
}
