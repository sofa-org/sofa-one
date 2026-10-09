import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  formatUnits,
  hashMessage,
  hashTypedData,
  http,
  type Hex,
  type PublicClient,
  recoverAddress,
} from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import { getSupportedChain, type SupportedChain } from '../../common/chains/supported-chains';
import { API_ERROR_CODES } from '../../common/errors/api-error-codes';
import { hashRequest } from '../../common/utils/request-hash';
import { RequestContextService } from '../../common/request-context/request-context.service';
import { AgentStatus } from '../../common/agent/agent-status';
import type { ExecutionMode, SignDto, SignMessage } from './dto/sign.dto';
import { ListSigningRequestsQueryDto } from './dto/list-signing-requests-query.dto';
import type { WithdrawDto } from './dto/withdraw.dto';
import type { CreateWithdrawalAddressDto } from './dto/withdrawal-address.dto';
import { WithdrawalPolicyService } from './withdrawal-policy.service';
import { isDeferredDestinationPolicyDenial } from '../withdrawal-destination/withdrawal-destination-policy.service';
import { EoaExecutionPolicyService } from '../eoa-execution/eoa-execution-policy.service';
import { SigningPolicyService } from './signing-policy.service';
import { RiskEvaluationService } from '../security-events/risk-evaluation.service';
import { SecurityEventService } from '../security-events/security-event.service';
import { SessionKeyPolicyService } from '../session-key/session-key-policy.service';
import { BillingDebtService } from '../billing/billing-debt.service';
import { DefiPolicyService, DefiPolicyDenial } from '../defi';
import { POLYMARKET_CLOB_ORDER_CAPABILITY_ID, validatePolymarketClobOrder, polymarketDepositWalletAddress, polymarketOrderDigest, polymarketWrapperDigest, type ValidatedPolymarketOrder } from '../defi/signing/polymarket-clob-order';
import { buildPolymarketPoly1271Envelope } from '../defi/signing/polymarket-poly1271-envelope';
import { PolymarketDepositWalletVerifierService, type DepositWalletEvidence } from './polymarket-deposit-wallet-verifier.service';
import { PolymarketSigningBudgetService } from './polymarket-signing-budget.service';

/** Fixed public reason for BILL-016 sign blocks (no payload fields). */
const SIGNING_BLOCKED_BY_DESTINATION_PROTECTION_REASON =
  'API-key signing is not allowed while destination protection is enabled';

type SigningDestinationProtectionAudit = {
  userId: string;
  apiKeyId?: string;
  apiKeyPrefix?: string;
  walletId?: string;
  chainId: number;
  type: string;
  executionMode: ExecutionMode;
};

/**
 * Thrown inside the interactive create TX so advisory lock is released before
 * SecurityEvent write. Caller audits once after rollback, then rethrows HTTP.
 */
class DeferredSigningDestinationProtectionDenial extends Error {
  readonly httpException: ForbiddenException;
  readonly audit: SigningDestinationProtectionAudit;

  constructor(httpException: ForbiddenException, audit: SigningDestinationProtectionAudit) {
    super('DeferredSigningDestinationProtectionDenial');
    this.name = 'DeferredSigningDestinationProtectionDenial';
    this.httpException = httpException;
    this.audit = audit;
  }
}

const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

type ApiKeySigningContext = {
  id?: string;
  keyPrefix?: string;
  name?: string | null;
  allowedIps?: string[] | null;
  expiresAt?: Date | string | null;
  canSign?: boolean;
  canUseEoaExecution?: boolean;
  allowedCapabilityIds?: string[];
  capabilityMode?: 'all' | 'custom';
};

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  private readonly publicClients = new Map<number, PublicClient>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly openfort: OpenfortService,
    private readonly withdrawalPolicy: WithdrawalPolicyService,
    private readonly billingDebt: BillingDebtService,
    private readonly defiPolicy: DefiPolicyService,
    @Optional()
    private readonly eoaExecutionPolicy?: EoaExecutionPolicyService,
    @Optional()
    private readonly signingPolicy?: SigningPolicyService,
    @Optional()
    private readonly requestContext?: RequestContextService,
    @Optional()
    private readonly riskEvaluation?: RiskEvaluationService,
    @Optional()
    private readonly sessionKeyPolicy?: SessionKeyPolicyService,
    /**
     * Audit only for destination-protection sign denials. Optional so missing
     * wiring never blocks the 403/503 fail-closed path; never used to gate the
     * protection check itself.
     */
    @Optional()
    private readonly securityEvents?: SecurityEventService,
    @Optional() private readonly polymarketVerifier?: PolymarketDepositWalletVerifierService,
    @Optional() private readonly polymarketBudget?: PolymarketSigningBudgetService,
  ) {}

  private getPublicClient(chainId: number): PublicClient {
    const existing = this.publicClients.get(chainId);
    if (existing) return existing;
    const { chain } = getSupportedChain(chainId);
    const client = createPublicClient({ chain, transport: http() });
    this.publicClients.set(chainId, client);
    return client;
  }

  private async selectWallet(userId: string, walletId?: string) {
    const wallets = await this.prisma.userWallet.findMany({ where: { userId } });
    if (wallets.length === 0) throw new NotFoundException('Wallet not found');
    if (walletId) {
      const wallet = wallets.find((candidate) => candidate.id === walletId);
      if (!wallet) throw new NotFoundException('Wallet not found');
      return wallet;
    }
    if (wallets.length === 1) return wallets[0];
    const eligible = wallets.filter((wallet) => wallet.status === 'active' && wallet.walletAddress && !wallet.frozenAt);
    if (eligible.length !== 1) throw new ConflictException('walletId is required when multiple wallets are available');
    return eligible[0];
  }

  /** Return the user's EOA address and supported deposit tokens. */
  async getDepositInfo(userId: string, chainId: number, walletId?: string) {
    const wallet = await this.selectWallet(userId, walletId);
    this.assertWalletNotFrozen(wallet);
    if (wallet.status !== 'active' || !wallet.walletAddress) {
      throw new BadRequestException(`Wallet is not active (status: ${wallet.status})`);
    }
    const walletAddress = wallet.walletAddress;
    const supportedChain = getSupportedChain(chainId);

    return {
      walletAddress,
      chainId,
      chainName: supportedChain.name,
      status: wallet.status,
      supportedTokens: [
        ...(supportedChain.usdcAddress ? ['USDC'] : []),
        ...(supportedChain.usdtAddress ? ['USDT'] : []),
        supportedChain.nativeCurrencySymbol,
      ],
    };
  }

  async listWithdrawalAddresses(userId: string) {
    return this.withdrawalPolicy.listWithdrawalAddresses(userId);
  }

  async addWithdrawalAddress(userId: string, dto: CreateWithdrawalAddressDto) {
    return this.withdrawalPolicy.addWithdrawalAddress(userId, dto);
  }

  async removeWithdrawalAddress(userId: string, addressId: string) {
    return this.withdrawalPolicy.removeWithdrawalAddress(userId, addressId);
  }

  /** Sign data with the user's backend agent signer (no transaction broadcast). */
  async sign(userId: string, params: SignDto, apiKeyRecord?: ApiKeySigningContext) {
    if (!apiKeyRecord) {
      throw new UnauthorizedException('API key is required for signing');
    }
    const apiKey = apiKeyRecord!;
    this.assertPermission(apiKey.canSign, 'API key is not allowed to sign messages');
    if (params.type !== 'typed_data') {
      throw new ForbiddenException('API-key signing is limited to Polymarket ClobAuth typed data');
    }

    const resolvedChainId = this.resolveSigningChainId(params);
    if (resolvedChainId === undefined) {
      throw new BadRequestException('chainId is required for API-key signing');
    }
    const chainId: number = resolvedChainId;
    getSupportedChain(chainId);
    const executionMode = this.resolveExecutionMode(params.executionMode);
    const isPolymarketOrder = params.typedData?.primaryType === 'TypedDataSign';
    if (isPolymarketOrder && (chainId !== 137 || executionMode !== 'eoa')) throw new ForbiddenException('Polymarket order signing requires EOA mode on Polygon');
    const orderPayload: ValidatedPolymarketOrder | undefined = isPolymarketOrder ? validatePolymarketClobOrder(params.typedData) : undefined;
    const policyContext = {
      userId,
      chainId,
      type: params.type,
      executionMode,
      apiKeyId: apiKey.id,
      apiKeyPrefix: apiKey.keyPrefix,
      deferAllowedAudit: true,
    };

    // BILL-016 root preflight: after API-key permission, before EOA / SigningPolicy /
    // risk / session-key / Openfort. requireAddressAllowlist === true → fail closed
    // for all message/typed_data × session_key/eoa. Empty allowlist / allowlisted
    // contracts / cooldown / reauth cannot bypass. Query failures → 503.
    // Does not revoke signatures already accepted before protection was enabled.
    const destinationProtectionEnabled = await this.isDestinationProtectionEnabled(userId);
    if (destinationProtectionEnabled) {
      await this.throwSigningBlockedByDestinationProtection({
        userId,
        apiKeyId: apiKey.id,
        apiKeyPrefix: apiKey.keyPrefix,
        chainId,
        type: params.type,
        executionMode,
      });
    }

    const selected = await this.selectWallet(userId, params.walletId);
    const selectedForPolicy = await this.prisma.userWallet.findFirst({ where: { id: selected.id, userId }, include: { chainAuthorizations: { where: { chainId: BigInt(chainId) } } } });
    if (!selectedForPolicy) throw new NotFoundException('Wallet not found');
    this.assertWalletNotFrozen(selectedForPolicy);
    if (selectedForPolicy.status !== 'active' || !selectedForPolicy.walletAddress) throw new BadRequestException(`Wallet is not active (status: ${selectedForPolicy.status})`);
    let signingAuthorization: Awaited<ReturnType<DefiPolicyService['authorizeSigning']>>;
    try {
      signingAuthorization = await this.defiPolicy.authorizeSigning(orderPayload ?? params.typedData, {
        userId, apiKeyId: apiKey.id!, apiKeyPrefix: apiKey.keyPrefix,
        walletId: selectedForPolicy.id, chainId, executionMode,
        executionOwner: executionMode === 'session_key' ? selectedForPolicy.walletAddress! : selectedForPolicy.agentWalletAddress!,
        allowedCapabilityIds: apiKey.allowedCapabilityIds ?? [], capabilityMode: apiKey.capabilityMode,
        walletAddress: selectedForPolicy.walletAddress!, agentWalletAddress: selectedForPolicy.agentWalletAddress!, agentOpenfortAccountId: selectedForPolicy.agentOpenfortAccountId!,
      });
    } catch (error) {
      if (error instanceof DefiPolicyDenial) {
        try { await this.defiPolicy.recordDenied(error); } catch { /* audit must not mask stable denial */ }
        throw error.httpException;
      }
      throw error;
    }

    if (executionMode === 'eoa') {
      this.assertPermission(
        apiKey.canUseEoaExecution,
        'API key is not allowed to use EOA execution',
      );
      if (isPolymarketOrder) {
        if (!this.eoaExecutionPolicy) throw new ForbiddenException('EOA execution policy is not available');
        await this.eoaExecutionPolicy.assertPolymarketOrderPrerequisites({ operation: 'polymarket_order_sign', userId, apiKeyId: apiKey.id, apiKeyPrefix: apiKey.keyPrefix, allowedIps: apiKey.allowedIps, clientIp: this.requestContext?.getClientIp(), expiresAt: apiKey.expiresAt, chainId: 137, metadata: { type: 'typed_data' } });
      } else {
        await this.assertEoaExecutionAllowed(userId, apiKey, { operation: 'sign', chainId, metadata: { type: params.type } });
      }
      this.logSecurityWarning({
        message: 'Privileged EOA signing requested',
        userId,
        chainId,
        type: params.type,
        executionMode,
        apiKeyPrefix: apiKey.keyPrefix,
      });
    }

    // Apply signing policy checks
    if (!this.signingPolicy) throw new ForbiddenException('Signing policy is not available');
    const typedDataSummary = await this.signingPolicy.assertTypedDataSigningPolicy(
      signingAuthorization.payload as any,
      policyContext,
    );

    // Evaluate multi-factor risk before proceeding
    const activeWallet = selectedForPolicy;
    this.assertWalletNotFrozen(activeWallet);
    if (activeWallet.status !== 'active' || !activeWallet.walletAddress) throw new BadRequestException(`Wallet is not active (status: ${activeWallet.status})`);
    const riskAssessment = await this.riskEvaluation?.evaluateRisk({
      userId,
      apiKeyId: apiKey.id,
      walletId: activeWallet.id,
      operationType: 'signing',
    });
    if (riskAssessment && riskAssessment!.action !== 'allow') {
      await this.riskEvaluation!.enforceRiskAction(riskAssessment!, {
        userId,
        apiKeyId: apiKey.id,
        walletId: activeWallet.id,
        operationType: 'signing',
      });
    }

    if (executionMode === 'session_key') {
      this.assertAgentWalletReady(activeWallet);
      this.assertChainAuthorizationReady(activeWallet.chainAuthorizations?.[0]);
      await this.sessionKeyPolicy?.assertSessionKeyAllowed({
        userId,
        walletId: activeWallet.id,
        apiKeyId: apiKey.id,
        apiKeyPrefix: apiKey.keyPrefix,
        chainId,
        accountAddress: activeWallet.walletAddress!,
        keyHash: activeWallet.agentKeyHash!,
        operation: 'sign',
        apiKeyExpiresAt: apiKey.expiresAt,
      });
    } else {
      this.assertBackendWalletReady(activeWallet);
    }
    const signingWalletAddress =
      executionMode === 'eoa' ? activeWallet.agentWalletAddress! : activeWallet.walletAddress!;

    const data = signingAuthorization.typedDataDigest;
    let depositEvidence: DepositWalletEvidence | undefined;
    if (isPolymarketOrder) {
      if (!this.polymarketVerifier || !this.polymarketBudget || !orderPayload) throw new ServiceUnavailableException('Polymarket order signing is unavailable');
      depositEvidence = await this.polymarketVerifier.verify(activeWallet.agentWalletAddress!, orderPayload);
    }

    // BILL-016 final check: same withdrawal_dest:<userId> advisory lock as address
    // policy mutations. Final requireAddressAllowlist read + SigningRequest.create
    // share one interactive TX (READ COMMITTED). Openfort/RPC stay outside lock/TX.
    // Race: entry false → final true rejects with zero create/signData (mutation
    // committed first wins). Sign already accepted before enablement is out of scope.
    const signingBlockedAudit: SigningDestinationProtectionAudit = {
      userId,
      apiKeyId: apiKey.id,
      apiKeyPrefix: apiKey.keyPrefix,
      walletId: activeWallet.id,
      chainId,
      type: params.type,
      executionMode,
    };
    let signingRequest: { id: string };
    let allowedEvent: unknown;
    try {
      signingRequest = await this.prisma.$transaction(async (txClient) => {
        await this.withdrawalPolicy.acquireUserDestinationLock(userId, txClient);
        if (isPolymarketOrder) await this.polymarketBudget!.acquireWalletLock(txClient, activeWallet.id);
        if (isPolymarketOrder) this.polymarketVerifier!.assertFresh(depositEvidence!, activeWallet.agentWalletAddress!, orderPayload!);
        const protectionOn = await this.isDestinationProtectionEnabled(userId, txClient);
        if (protectionOn) {
          throw new DeferredSigningDestinationProtectionDenial(
            this.buildSigningBlockedException(),
            signingBlockedAudit,
          );
        }
        await this.defiPolicy.assertSigningStillAuthorized(txClient, signingAuthorization, {
          userId, apiKeyId: apiKey.id!, chainId, executionMode, type: params.type,
          digest: data, walletId: activeWallet.id, walletAddress: activeWallet.walletAddress!,
          agentWalletAddress: activeWallet.agentWalletAddress!, agentOpenfortAccountId: activeWallet.agentOpenfortAccountId!,
        });
        allowedEvent = isPolymarketOrder
          ? await this.polymarketBudget!.recordAcceptedInTransaction(txClient, { walletId: activeWallet.id, userId, apiKeyId: apiKey.id!, apiKeyPrefix: apiKey.keyPrefix })
          : await this.defiPolicy.recordSigningAllowedInTx(txClient, signingAuthorization);
        return txClient.signingRequest.create({
          data: {
            userId,
            apiKeyId: apiKey.id,
            authMethod: 'api_key',
            apiKeyPrefix: apiKey.keyPrefix,
            apiKeyName: apiKey.name,
            type: params.type,
            chainId: BigInt(chainId),
            walletAddress: signingWalletAddress,
            requestHash: hashRequest({
              type: params.type,
              chainId,
              digest: data,
              executionMode,
              ...(typedDataSummary ? { typedData: typedDataSummary } : {}),
            }),
            digest: data,
            status: 'submitting',
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      // After TX rollback: destination advisory released — safe to audit once.
      if (error instanceof DeferredSigningDestinationProtectionDenial) {
        await this.recordSigningBlockedByDestinationProtection(error.audit);
        throw error.httpException;
      }
      if (error instanceof DefiPolicyDenial) {
        try { await this.defiPolicy.recordDenied(error); } catch { /* denial audit must not mask policy result */ }
        throw error.httpException;
      }
      throw error;
    }
    if (allowedEvent) {
      if (isPolymarketOrder) await this.polymarketBudget!.exportAccepted(allowedEvent);
      else await this.defiPolicy.exportSigningAllowed(allowedEvent);
    }

    this.logger.log(
      this.logContext({
        message: 'Created signing request',
        signingRequestId: signingRequest.id,
        userId,
        chainId,
        type: params.type,
        executionMode,
        ...(!isPolymarketOrder ? typedDataSummary ?? {} : {}),
        apiKeyPrefix: apiKey.keyPrefix,
      }),
    );

    let signature: string;
    try {
      const accountId = activeWallet.agentOpenfortAccountId!;
      const rawSignature = await this.openfort.signData(accountId, data);
      if (isPolymarketOrder) {
        if (!orderPayload || !depositEvidence) throw new Error('order evidence unavailable');
        const recovered = await recoverAddress({ hash: polymarketWrapperDigest(orderPayload), signature: rawSignature as Hex });
        if (recovered.toLowerCase() !== activeWallet.agentWalletAddress!.toLowerCase()) throw new Error('signer mismatch');
        const envelope = buildPolymarketPoly1271Envelope(orderPayload, rawSignature as Hex);
        this.polymarketVerifier!.assertFresh(depositEvidence, activeWallet.agentWalletAddress!, orderPayload);
        const finalEvidence = await this.polymarketVerifier!.verify(activeWallet.agentWalletAddress!, orderPayload);
        if (finalEvidence.codeHash.toLowerCase() !== depositEvidence.codeHash.toLowerCase()) throw new Error('deposit wallet code changed');
        await this.polymarketVerifier!.verify1271(orderPayload, polymarketOrderDigest(orderPayload), envelope);
        signature = rawSignature;
      } else {
      signature =
        executionMode === 'session_key'
          ? this.wrapCaliburSignature(activeWallet.agentKeyHash!, rawSignature)
          : rawSignature;
      }
    } catch (err) {
      this.logger.error(
        this.logContext({
          message: 'Signing request failed',
          signingRequestId: signingRequest.id,
          userId,
          chainId,
          type: params.type,
          executionMode,
          apiKeyPrefix: apiKey.keyPrefix,
        }),
        isPolymarketOrder ? undefined : err instanceof Error ? err.stack : undefined,
      );
      await this.updateSigningRequestStatus(signingRequest.id, 'failed');
      if (isPolymarketOrder) {
        throw new ServiceUnavailableException({ code: 'POLYMARKET_SIGNING_FAILED', message: 'Polymarket order signing could not be verified' });
      }
      throw err;
    }

    await this.updateSigningRequestStatus(signingRequest.id, 'signed');

    this.logger.log(
      this.logContext({
        message: 'Signing request completed',
        signingRequestId: signingRequest.id,
        userId,
        chainId,
        type: params.type,
        executionMode,
        apiKeyPrefix: apiKey.keyPrefix,
      }),
    );

    return {
      signature,
      walletAddress: signingWalletAddress,
      ...(executionMode === 'eoa' ? { agentWalletAddress: signingWalletAddress } : {}),
      type: params.type,
      executionMode,
    };
  }

  /** Return detail for a single signing request (dashboard-only, ownership-enforced). */
  async getSigningRequestDetail(userId: string, signingRequestId: string, walletId?: string) {
    const wallet = walletId ? await this.selectWallet(userId, walletId) : undefined;
    if (walletId && !wallet?.walletAddress && !wallet?.agentWalletAddress) {
      throw new NotFoundException('Signing request not found');
    }
    const addresses = wallet ? [wallet.walletAddress, wallet.agentWalletAddress].filter((x): x is string => !!x) : [];
    const sr = await this.prisma.signingRequest.findFirst({
      where: { id: signingRequestId, userId, ...(wallet ? { walletAddress: { in: addresses } } : {}) },
    });
    if (!sr) throw new NotFoundException('Signing request not found');

    return {
      id: sr.id,
      type: sr.type,
      chainId: sr.chainId ? Number(sr.chainId) : null,
      walletAddress: sr.walletAddress,
      status: sr.status,
      authMethod: sr.authMethod,
      apiKeyPrefix: sr.apiKeyPrefix,
      apiKeyName: sr.apiKeyName,
      createdAt: sr.createdAt,
      completedAt: sr.completedAt,
    };
  }

  /** List signing requests for a user with optional filtering and pagination. */
  async listSigningRequests(userId: string, query: ListSigningRequestsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { userId };
    if (query.walletId) {
      const wallet = await this.selectWallet(userId, query.walletId);
      const addresses = [wallet.walletAddress, wallet.agentWalletAddress].filter((x): x is string => !!x);
      if (addresses.length === 0) return { items: [], total: 0, page, limit };
      where.walletAddress = { in: addresses };
    }

    if (query.type) {
      where.type = query.type;
    }
    if (query.status) {
      where.status = query.status;
    }
    if (query.chainId) {
      where.chainId = BigInt(query.chainId);
    }

    const [items, total] = await Promise.all([
      this.prisma.signingRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.signingRequest.count({ where }),
    ]);

    return {
      items: items.map((sr) => ({
        id: sr.id,
        type: sr.type,
        chainId: sr.chainId ? Number(sr.chainId) : null,
        walletAddress: sr.walletAddress,
        status: sr.status,
        apiKeyPrefix: sr.apiKeyPrefix,
        apiKeyName: sr.apiKeyName,
        createdAt: sr.createdAt,
        completedAt: sr.completedAt,
      })),
      total,
      page,
      limit,
    };
  }

  private resolveExecutionMode(mode?: ExecutionMode): ExecutionMode {
    return mode ?? 'session_key';
  }

  private assertPermission(allowed: boolean | undefined, message: string): void {
    if (allowed !== true) {
      throw new ForbiddenException(message);
    }
  }

  /**
   * BILL-016: whether the user's withdrawal destination allowlist is enforced.
   * Missing policy or requireAddressAllowlist !== true → protection off (legacy
   * SigningPolicy path). DB failures fail closed (503) — never assume off.
   */
  private async isDestinationProtectionEnabled(
    userId: string,
    db: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<boolean> {
    try {
      const policy = await db.withdrawalPolicy.findUnique({
        where: { userId },
        select: { requireAddressAllowlist: true },
      });
      return policy?.requireAddressAllowlist === true;
    } catch (err) {
      this.logger.error(
        {
          message: 'Destination protection policy lookup failed',
          userId,
        },
        err instanceof Error ? err.stack : undefined,
      );
      throw new ServiceUnavailableException({
        code: API_ERROR_CODES.WITHDRAWAL_DESTINATION_POLICY_UNAVAILABLE,
        message: 'Withdrawal destination policy is temporarily unavailable',
      });
    }
  }

  private buildSigningBlockedException(): ForbiddenException {
    return new ForbiddenException({
      code: API_ERROR_CODES.SIGNING_BLOCKED_BY_DESTINATION_PROTECTION,
      message: SIGNING_BLOCKED_BY_DESTINATION_PROTECTION_REASON,
    });
  }

  /**
   * Preflight denial: audit once (best-effort), then 403. Never logs message,
   * typedData, domain, primaryType, calldata, digest, requestHash, or signature.
   */
  private async throwSigningBlockedByDestinationProtection(
    audit: SigningDestinationProtectionAudit,
  ): Promise<never> {
    this.logger.warn(
      this.logContext({
        message: 'Signing blocked by destination protection',
        userId: audit.userId,
        chainId: audit.chainId,
        type: audit.type,
        executionMode: audit.executionMode,
        apiKeyPrefix: audit.apiKeyPrefix,
        code: API_ERROR_CODES.SIGNING_BLOCKED_BY_DESTINATION_PROTECTION,
      }),
    );
    await this.recordSigningBlockedByDestinationProtection(audit);
    throw this.buildSigningBlockedException();
  }

  /**
   * Best-effort `signing.policy_denied` audit. Failures never change 403/503.
   * Metadata is safe fields only (code, fixed reason, type, chainId, executionMode,
   * apiKeyPrefix, walletId) — no payload/digest/signature.
   */
  private async recordSigningBlockedByDestinationProtection(
    audit: SigningDestinationProtectionAudit,
  ): Promise<void> {
    if (!this.securityEvents) {
      this.logger.warn(
        this.logContext({
          message: 'Signing blocked by destination protection (no security event service)',
          userId: audit.userId,
          chainId: audit.chainId,
          type: audit.type,
          executionMode: audit.executionMode,
          apiKeyPrefix: audit.apiKeyPrefix,
          code: API_ERROR_CODES.SIGNING_BLOCKED_BY_DESTINATION_PROTECTION,
        }),
      );
      return;
    }

    try {
      await this.securityEvents.record({
        actorType: 'api_key',
        eventType: 'signing.policy_denied',
        userId: audit.userId,
        apiKeyId: audit.apiKeyId ?? null,
        walletId: audit.walletId ?? null,
        result: 'denied',
        reason: SIGNING_BLOCKED_BY_DESTINATION_PROTECTION_REASON,
        metadata: {
          code: API_ERROR_CODES.SIGNING_BLOCKED_BY_DESTINATION_PROTECTION,
          reason: SIGNING_BLOCKED_BY_DESTINATION_PROTECTION_REASON,
          type: audit.type,
          chainId: audit.chainId,
          executionMode: audit.executionMode,
          apiKeyPrefix: audit.apiKeyPrefix ?? null,
          walletId: audit.walletId ?? null,
        },
      });
    } catch (error) {
      this.logger.error(
        this.logContext({
          message: 'Failed to record destination-protection signing denial',
          userId: audit.userId,
          chainId: audit.chainId,
          type: audit.type,
          executionMode: audit.executionMode,
          apiKeyPrefix: audit.apiKeyPrefix,
          code: API_ERROR_CODES.SIGNING_BLOCKED_BY_DESTINATION_PROTECTION,
        }),
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async assertEoaExecutionAllowed(
    userId: string,
    apiKeyRecord: ApiKeySigningContext,
    context: { operation: 'sign'; chainId: number; metadata?: Record<string, unknown> },
  ) {
    if (!this.eoaExecutionPolicy) {
      throw new ForbiddenException('EOA execution policy is not available');
    }
    await this.eoaExecutionPolicy.assertAllowed({
      operation: context.operation,
      userId,
      apiKeyId: apiKeyRecord.id,
      apiKeyPrefix: apiKeyRecord.keyPrefix,
      allowedIps: apiKeyRecord.allowedIps,
      clientIp: this.requestContext?.getClientIp(),
      expiresAt: apiKeyRecord.expiresAt,
      chainId: context.chainId,
      metadata: context.metadata as any,
    });
  }

  private assertAgentWalletReady(wallet: {
    status: string;
    agentOpenfortAccountId?: string | null;
    agentWalletAddress?: string | null;
    agentKeyHash?: string | null;
  }): void {
    if (!wallet.agentOpenfortAccountId || !wallet.agentWalletAddress || !wallet.agentKeyHash) {
      throw new BadRequestException(`Wallet is not active (status: ${wallet.status})`);
    }
  }

  private assertBackendWalletReady(wallet: {
    status: string;
    agentOpenfortAccountId?: string | null;
    agentWalletAddress?: string | null;
  }): void {
    if (
      wallet.status !== 'active' ||
      !wallet.agentOpenfortAccountId ||
      !wallet.agentWalletAddress
    ) {
      throw new BadRequestException(`Wallet is not active (status: ${wallet.status})`);
    }
  }

  private wrapCaliburSignature(keyHash: string, signature: string): Hex {
    return encodeAbiParameters(
      [
        { name: 'keyHash', type: 'bytes32' },
        { name: 'signature', type: 'bytes' },
        { name: 'hookData', type: 'bytes' },
      ],
      [keyHash as Hex, signature as Hex, '0x'],
    );
  }

  private async updateSigningRequestStatus(id: string, status: 'signed' | 'failed'): Promise<void> {
    try {
      await this.prisma.signingRequest.update({
        where: { id },
        data: { status, completedAt: new Date() },
      });
    } catch (err) {
      this.logger.error(
        this.logContext({
          message: 'Failed to update signing request status',
          signingRequestId: id,
          status,
        }),
        err instanceof Error ? err.stack : err,
      );
    }
  }

  private logContext(extra: Record<string, unknown>) {
    return this.requestContext?.getLogContext(extra) ?? extra;
  }

  private logSecurityWarning(extra: Record<string, unknown>): void {
    this.logger.warn(this.logContext({ event: 'security', ...extra }));
  }

  private assertWalletNotFrozen(wallet: {
    frozenAt?: Date | string | null;
    frozenReason?: string | null;
  }): void {
    if (wallet.frozenAt) {
      throw new ForbiddenException(wallet.frozenReason ?? 'Wallet is frozen');
    }
  }

  private assertChainAuthorizationReady(
    authorization?: { status: string; expiresAt?: Date | string | null } | null,
  ) {
    if (authorization?.status !== AgentStatus.Registered) {
      throw new BadRequestException('API access is not authorized for this chain');
    }

    const expiresAt = authorization.expiresAt ? new Date(authorization.expiresAt) : null;
    if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
      throw new BadRequestException('API access authorization is expired for this chain');
    }
  }

  /** Return native token and stablecoin balances for the user's wallet on the requested chain. */
  async getBalances(userId: string, chainId: number, walletId?: string) {
    const wallet = await this.selectWallet(userId, walletId);
    this.assertWalletNotFrozen(wallet);
    if (wallet.status !== 'active' || !wallet.walletAddress) {
      throw new BadRequestException(`Wallet is not active (status: ${wallet.status})`);
    }

    const walletAddress = wallet.walletAddress as `0x${string}`;

    const supportedChain = getSupportedChain(chainId);
    const publicClient = this.getPublicClient(chainId);
    const stablecoins = [
      ...(supportedChain.usdcAddress
        ? [{ token: 'USDC', address: supportedChain.usdcAddress }]
        : []),
      ...(supportedChain.usdtAddress
        ? [{ token: 'USDT', address: supportedChain.usdtAddress }]
        : []),
    ];

    type BalanceEntry =
      | { token: string; formatted: string }
      | { token: string; formatted: null; error: string };

    const [ethResult, ...stablecoinResults] = await Promise.all([
      publicClient
        .getBalance({ address: walletAddress })
        .then(
          (raw): BalanceEntry => ({
            token: supportedChain.nativeCurrencySymbol,
            formatted: formatEther(raw),
          }),
        )
        .catch(
          (): BalanceEntry => ({
            token: supportedChain.nativeCurrencySymbol,
            formatted: null,
            error: 'fetch failed',
          }),
        ),

      ...stablecoins.map(({ token, address }) =>
        publicClient
          .readContract({
            address,
            abi: ERC20_BALANCE_ABI,
            functionName: 'balanceOf',
            args: [walletAddress],
          })
          .then(
            (raw): BalanceEntry => ({
              token,
              formatted: formatUnits(raw, 6),
            }),
          )
          .catch(
            (): BalanceEntry => ({
              token,
              formatted: null,
              error: 'fetch failed',
            }),
          ),
      ),
    ]);

    const balances: BalanceEntry[] = [ethResult, ...stablecoinResults];

    const chains = [{ chainId, chainName: supportedChain.name, balances }];

    return { chains };
  }

  /** Submit a withdrawal transaction. */
  async withdraw(userId: string, params: WithdrawDto, options?: { stepUpVerified?: boolean }) {
    const chainId = params.chainId;
    const supportedChain = getSupportedChain(chainId);
    const selected = await this.selectWallet(userId, params.walletId);
    const wallet = await this.prisma.userWallet.findFirst({
      where: { userId, id: selected.id },
      include: {
        chainAuthorizations: { where: { chainId: BigInt(chainId) } },
      },
    });
    if (!wallet) throw new NotFoundException('Wallet not found');
    this.assertWalletNotFrozen(wallet);

    // Guard: wallet must be active before any outbound transfer
    if (
      wallet.status !== 'active' ||
      !wallet.walletAddress ||
      !wallet.agentOpenfortAccountId ||
      !wallet.agentWalletAddress ||
      !wallet.agentKeyHash
    ) {
      throw new BadRequestException(`Wallet is not active (status: ${wallet.status})`);
    }
    this.assertChainAuthorizationReady(wallet.chainAuthorizations?.[0]);

    // Guard: prevent self-withdrawal (sending to own wallet address)
    if (params.to.toLowerCase() === wallet.walletAddress.toLowerCase()) {
      throw new BadRequestException('Cannot withdraw to your own wallet address');
    }

    await this.assertWithdrawalPolicy(
      params,
      {
        userId,
        chainId,
        walletId: wallet.id,
        walletAddress: wallet.walletAddress,
        stepUpVerified: options?.stepUpVerified,
      },
      { skipDailyLimit: true },
    );

    // Evaluate multi-factor risk before proceeding
    const riskAssessment = await this.riskEvaluation?.evaluateRisk({
      userId,
      walletId: wallet.id,
      operationType: 'withdrawal',
    });
    const riskStepUpSatisfied =
      riskAssessment?.action === 'require_step_up' && options?.stepUpVerified === true;
    if (riskAssessment && riskAssessment.action !== 'allow' && !riskStepUpSatisfied) {
      await this.riskEvaluation!.enforceRiskAction(riskAssessment, {
        userId,
        walletId: wallet.id,
        operationType: 'withdrawal',
      });
    }

    const isNativeWithdrawal = params.token === 'NATIVE';
    const tokenAddress = this.getWithdrawalTokenAddress(params.token, supportedChain);
    const walletAddress = wallet.walletAddress as `0x${string}`;

    const requestHash = hashRequest({
      operationType: 'withdraw',
      walletId: wallet.id,
      chainId,
      to: params.to,
      amount: params.amount,
      token: params.token,
      contractAddress: tokenAddress,
    });

    const existingWithdrawal = await this.findExistingWithdrawal(userId, {
      idempotencyKey: params.idempotencyKey!,
      chainId,
      requestHash,
      walletAddress,
      legacyFingerprint: hashRequest({ operationType: 'withdraw', chainId, to: params.to, amount: params.amount, token: params.token, contractAddress: tokenAddress }),
    });
    if (existingWithdrawal) {
      return this.toWithdrawalResponse(existingWithdrawal);
    }

    // Explicit external withdraw: block new submissions while billing debt is open.
    // Idempotent hits above bypass this gate so retries of already-accepted withdraws still return.
    await this.assertNoBillingDebtForOutbound(userId, {
      chainId,
      walletId: wallet.id,
      operation: 'withdraw',
    });

    // Guard: verify on-chain balance is sufficient before submitting intent
    {
      const publicClient = this.getPublicClient(chainId);
      let balance: bigint;
      try {
        balance = isNativeWithdrawal
          ? await publicClient.getBalance({ address: walletAddress })
          : await publicClient.readContract({
              address: tokenAddress!,
              abi: ERC20_BALANCE_ABI,
              functionName: 'balanceOf',
              args: [walletAddress],
            });
      } catch {
        throw new BadRequestException(
          `Unable to verify ${this.getWithdrawalTokenLabel(params.token, supportedChain.nativeCurrencySymbol)} balance — please retry`,
        );
      }

      const requestedAmount = BigInt(params.amount);
      if (balance < requestedAmount) {
        throw new BadRequestException(
          `Insufficient ${this.getWithdrawalTokenLabel(params.token, supportedChain.nativeCurrencySymbol)} balance: have ${balance.toString()} units, requested ${params.amount} units`,
        );
      }
    }

    // Interactive transaction: inner idempotency + debt recheck + daily limit + create.
    // On unique-key race (P2002) the interactive tx aborts — recover outside with root
    // PrismaService after rollback (never re-query on the failed txClient).
    let tx: any;
    let created: boolean;
    try {
      ({ tx, created } = await this.prisma.$transaction(async (txClient) => {
        const existing = await this.findExistingWithdrawal(
          userId,
          {
            idempotencyKey: params.idempotencyKey!,
            chainId,
            requestHash,
            walletAddress,
            legacyFingerprint: hashRequest({ operationType: 'withdraw', chainId, to: params.to, amount: params.amount, token: params.token, contractAddress: tokenAddress }),
          },
          txClient,
        );
        if (existing) {
          return { tx: existing, created: false };
        }

        // Re-check debt under the same tx snapshot before destination lock / create.
        await this.assertNoBillingDebtForOutbound(
          userId,
          {
            chainId,
            walletId: wallet.id,
            operation: 'withdraw',
          },
          txClient,
        );

        // BILL-016 order (no RPC/Openfort under lock):
        // 1) user destination advisory lock
        // 2) final allowlist/cooldown on params.to (fail closed)
        // 3) daily-limit policy row FOR UPDATE
        // 4) create pending withdrawal
        await this.withdrawalPolicy.acquireUserDestinationLock(userId, txClient);
        await this.withdrawalPolicy.assertDestinationAllowedInTx(
          userId,
          params.to,
          {
            chainId,
            walletId: wallet.id,
            walletAddress,
          },
          txClient,
        );

        await this.withdrawalPolicy.assertDailyLimitWithUserLock(
          userId,
          params,
          {
            chainId,
            walletId: wallet.id,
            walletAddress,
          },
          txClient,
        );

        return this.createPendingWithdrawal(
          userId,
          {
            idempotencyKey: params.idempotencyKey!,
            chainId,
            requestHash,
            walletAddress,
            details: {
              type: 'withdraw',
              execution: 'calibur_agent_user_operation',
              executionMode: 'session_key',
              to: params.to,
              amount: params.amount,
              token: params.token,
              contractAddress: tokenAddress,
              agentWalletAddress: wallet.agentWalletAddress,
              agentKeyHash: wallet.agentKeyHash,
              idempotencyKey: params.idempotencyKey,
              requestHash,
            },
          },
          txClient,
        );
      }));
    } catch (error: any) {
      // After TX rollback: destination advisory released — safe to audit once.
      if (isDeferredDestinationPolicyDenial(error)) {
        await this.withdrawalPolicy.recordDeferredDestinationDenial(error);
        throw error.httpException;
      }
      if (error?.code !== 'P2002') throw error;

      const existing = await this.findExistingWithdrawal(userId, {
        idempotencyKey: params.idempotencyKey!,
        chainId,
        requestHash,
        walletAddress,
        legacyFingerprint: hashRequest({ operationType: 'withdraw', chainId, to: params.to, amount: params.amount, token: params.token, contractAddress: tokenAddress }),
      });
      if (!existing) throw error;
      tx = existing;
      created = false;
    }

    if (!created || tx.txHash || tx.status !== 'submitting') {
      return this.toWithdrawalResponse(tx);
    }

    let observedUserOpHash: string | null =
      (tx as any).userOpHash ??
      (tx.details &&
      typeof tx.details === 'object' &&
      !Array.isArray(tx.details) &&
      typeof (tx.details as Record<string, unknown>).userOpHash === 'string'
        ? ((tx.details as Record<string, unknown>).userOpHash as string)
        : null);
    try {
      const interaction = isNativeWithdrawal
        ? {
            to: params.to as `0x${string}`,
            data: '0x' as Hex,
            value: params.amount,
          }
        : {
            to: tokenAddress!,
            data: encodeFunctionData({
              abi: [
                {
                  inputs: [
                    { name: 'to', type: 'address' },
                    { name: 'amount', type: 'uint256' },
                  ],
                  name: 'transfer',
                  outputs: [{ type: 'bool' }],
                  type: 'function',
                },
              ],
              functionName: 'transfer',
              args: [params.to, BigInt(params.amount)],
            }),
            value: '0',
          };

      const submitted = await this.openfort.submitUserOperation({
        chainId,
        agentAccountId: wallet.agentOpenfortAccountId,
        accountAddress: wallet.walletAddress,
        keyHash: wallet.agentKeyHash,
        interactions: [interaction],
        onUserOperationHash: async (userOpHash) => {
          observedUserOpHash = userOpHash;
          await this.prisma.transaction.updateMany({
            where: this.withdrawalCasWhere(
              tx,
              userId,
              chainId,
              params.idempotencyKey!,
              requestHash,
              {
                billingReconciledAt: null,
                userOpHash: null,
                status: { in: ['submitting', 'unknown', 'pending'] },
              },
            ),
            data: { userOpHash, status: 'pending', completedAt: null },
          });
        },
      });

      // Persist the UserOperation identity before waiting so a provider timeout
      // remains recoverable and cannot trigger a duplicate submission.
      observedUserOpHash = submitted.userOpHash;
      await this.prisma.transaction.updateMany({
        where: this.withdrawalCasWhere(tx, userId, chainId, params.idempotencyKey!, requestHash, {
          status: { in: ['submitting', 'unknown', 'pending'] },
          userOpHash: null,
          billingReconciledAt: null,
        }),
        data: {
          userOpHash: submitted.userOpHash,
          status: 'pending',
          completedAt: null,
          details: {
            ...((tx.details as Record<string, unknown>) ?? {}),
            userOpHash: submitted.userOpHash,
          } as any,
        },
      });
      const receipt = await this.openfort.waitForUserOperationReceipt({
        chainId,
        userOpHash: submitted.userOpHash,
      });

      const finalData = {
        ...(receipt.transactionHash ? { txHash: receipt.transactionHash } : {}),
        userOpSuccess:
          receipt.success === false
            ? false
            : receipt.success === true && receipt.transactionHash
              ? true
              : null,
        status: receipt.success === false || !receipt.transactionHash ? 'unknown' : 'pending',
        completedAt: null,
        details: {
          ...((tx.details as Record<string, unknown>) ?? {}),
          userOpHash: submitted.userOpHash,
          userOperationSuccess: receipt.success,
        } as any,
      };
      const finalWrite = await this.prisma.transaction.updateMany({
        where: this.withdrawalCasWhere(tx, userId, chainId, params.idempotencyKey!, requestHash, {
          status: { in: ['submitting', 'pending', 'unknown'] },
          userOpHash: submitted.userOpHash,
          userOpSuccess: null,
          billingReconciledAt: null,
        }),
        data: finalData,
      });
      if (finalWrite.count !== 1) return this.toWithdrawalResponse(tx);
      const updated = { ...tx, ...finalData } as any;

      return {
        transactionId: updated.id,
        transactionHash: updated.txHash,
        status: updated.status,
      };
    } catch (error) {
      await this.prisma.transaction.updateMany({
        where: this.withdrawalCasWhere(tx, userId, chainId, params.idempotencyKey!, requestHash, {
          status: { in: ['submitting', 'pending', 'unknown'] },
          userOpSuccess: null,
          billingReconciledAt: null,
          ...(observedUserOpHash
            ? { OR: [{ userOpHash: observedUserOpHash }, { userOpHash: null }] }
            : {}),
        }),
        data: observedUserOpHash
          ? { userOpHash: observedUserOpHash, status: 'unknown', completedAt: null }
          : { status: 'unknown', completedAt: null },
      });
      throw error;
    }
  }

  private withdrawalCasWhere(
    tx: any,
    userId: string,
    chainId: number,
    idempotencyKey: string,
    requestHash: string,
    extra: Record<string, unknown>,
  ) {
    return {
      id: tx.id,
      userId,
      operationType: 'withdraw',
      chainId: BigInt(chainId),
      idempotencyKey,
      requestHash,
      ...extra,
    };
  }

  private async assertWithdrawalPolicy(
    params: WithdrawDto,
    context: {
      userId: string;
      chainId: number;
      walletId?: string;
      walletAddress?: string;
      stepUpVerified?: boolean;
    },
    options: { skipDailyLimit?: boolean } = {},
  ): Promise<void> {
    await this.withdrawalPolicy.assertWithdrawalAllowed(context.userId, params, context, options);
  }

  /**
   * Fail-closed billing gate for explicit external withdrawals.
   * DB/query failures map to 503 — never fail-open as "no debt".
   */
  private async assertNoBillingDebtForOutbound(
    userId: string,
    context: { chainId: number; walletId?: string; operation: 'withdraw' },
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    let snapshot: { hasDebt: boolean; invoiceIds: string[] };
    try {
      snapshot = await this.billingDebt.getDebt(userId, db);
    } catch (error) {
      this.logger.error({
        message: 'Billing debt check unavailable',
        userId,
        walletId: context.walletId,
        chainId: context.chainId,
        operation: context.operation,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw new ServiceUnavailableException({
        code: API_ERROR_CODES.BILLING_DEBT_CHECK_UNAVAILABLE,
        message: 'Billing debt check is temporarily unavailable',
      });
    }

    if (!snapshot.hasDebt) {
      return;
    }

    this.logger.warn({
      message: 'Outbound withdrawal blocked by billing debt',
      userId,
      walletId: context.walletId,
      chainId: context.chainId,
      operation: context.operation,
      invoiceCount: snapshot.invoiceIds.length,
    });
    throw new ForbiddenException({
      code: API_ERROR_CODES.BILLING_OUTBOUND_BLOCKED,
      message: 'Withdrawals are blocked until outstanding invoices are settled',
    });
  }

  /** Create a pending withdrawal row. Callers own P2002 recovery after tx rollback. */
  private async createPendingWithdrawal(
    userId: string,
    params: {
      idempotencyKey: string;
      chainId: number;
      requestHash: string;
      walletAddress: string;
      details: Record<string, unknown>;
    },
    prisma: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const createdAt = new Date();
    const billingPeriodStart = new Date(
      Date.UTC(createdAt.getUTCFullYear(), createdAt.getUTCMonth(), 1),
    );
    const tx = await prisma.transaction.create({
      data: {
        userId,
        status: 'submitting',
        chainId: BigInt(params.chainId),
        walletAddress: params.walletAddress,
        operationType: 'withdraw',
        idempotencyKey: params.idempotencyKey,
        requestHash: params.requestHash,
        createdAt,
        billingPeriodStart,
        details: params.details as any,
      },
    });
    return { tx, created: true as const };
  }

  private async findExistingWithdrawal(
    userId: string,
    params: { idempotencyKey: string; chainId: number; requestHash: string; walletAddress: string; legacyFingerprint: string },
    prisma: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const existing = await prisma.transaction.findFirst({
      where: {
        userId,
        operationType: 'withdraw',
        chainId: BigInt(params.chainId),
        idempotencyKey: params.idempotencyKey,
      },
    });

    if (!existing) return null;
    if (existing.walletAddress?.toLowerCase() !== params.walletAddress.toLowerCase()) {
      throw new BadRequestException('Idempotency key was already used for a different request');
    }
    const legacyDetails = existing.details && typeof existing.details === 'object' ? existing.details as Record<string, unknown> : {};
    const legacyEquivalent = existing.requestHash == null &&
      legacyDetails.requestHash === params.legacyFingerprint;
    if (
      existing.requestHash != null &&
      existing.requestHash !== params.requestHash &&
      existing.requestHash !== params.legacyFingerprint
    ) {
      throw new BadRequestException('Idempotency key was already used for a different request');
    }
    if (existing.requestHash == null && !legacyEquivalent) {
      throw new BadRequestException('Idempotency key was already used for a different request');
    }

    return existing;
  }

  private toWithdrawalResponse(tx: any) {
    return {
      transactionId: tx.id,
      transactionHash: tx.txHash,
      status: tx.status,
    };
  }

  private getWithdrawalTokenLabel(token: WithdrawDto['token'], nativeCurrencySymbol: string) {
    return token === 'NATIVE' ? nativeCurrencySymbol : token;
  }

  private getWithdrawalTokenAddress(
    token: WithdrawDto['token'],
    chain: SupportedChain,
  ): `0x${string}` | null {
    if (token === 'NATIVE') return null;
    if (token === 'USDC' && chain.usdcAddress) return chain.usdcAddress;
    if (token === 'USDC') throw new BadRequestException(`USDC is not supported on ${chain.name}`);
    if (chain.usdtAddress) return chain.usdtAddress;
    throw new BadRequestException(`USDT is not supported on ${chain.name}`);
  }

  private resolveSigningChainId(params: SignDto): number | undefined {
    if ((params as { type: string }).type === 'hash') {
      throw new BadRequestException('hash signing is not allowed');
    }

    const typedDataChainId = params.typedData?.domain?.chainId;

    if (params.type === 'typed_data') {
      if (typeof typedDataChainId !== 'number') {
        throw new BadRequestException(
          'typedData.domain.chainId is required when signing typed data with an API key',
        );
      }
      if (params.chainId !== undefined && typedDataChainId !== params.chainId) {
        throw new BadRequestException('typedData.domain.chainId must match chainId');
      }
    }

    const chainId =
      params.chainId ?? (typeof typedDataChainId === 'number' ? typedDataChainId : undefined);
    if (chainId === undefined) {
      throw new BadRequestException('chainId is required when signing with an API key');
    }
    return chainId;
  }

  private hashSignMessage(message: SignMessage): string {
    if (typeof message === 'string') {
      return hashMessage(message);
    }

    return hashMessage({ raw: message.raw });
  }
}
