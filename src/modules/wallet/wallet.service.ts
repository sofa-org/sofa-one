import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
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
} from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import { getSupportedChain } from '../../common/chains/supported-chains';
import { hashRequest } from '../../common/utils/request-hash';
import { RequestContextService } from '../../common/request-context/request-context.service';
import { AgentStatus } from '../../common/agent/agent-status';
import type { ExecutionMode, SignDto, SignMessage } from './dto/sign.dto';
import { ListSigningRequestsQueryDto } from './dto/list-signing-requests-query.dto';
import { USDC_HIGH_VALUE_AMOUNT, USDC_MAX_AMOUNT, type WithdrawDto } from './dto/withdraw.dto';
import type { CreateWithdrawalAddressDto } from './dto/withdrawal-address.dto';
import { WithdrawalPolicyService } from './withdrawal-policy.service';
import { EoaExecutionPolicyService } from '../eoa-execution/eoa-execution-policy.service';
import { SigningPolicyService } from './signing-policy.service';

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
  allowedContracts?: string[];
  allowedFunctionSelectors?: string[];
};

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  private readonly publicClients = new Map<number, PublicClient>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly openfort: OpenfortService,
    @Optional()
    private readonly withdrawalPolicy?: WithdrawalPolicyService,
    @Optional()
    private readonly eoaExecutionPolicy?: EoaExecutionPolicyService,
    @Optional()
    private readonly signingPolicy?: SigningPolicyService,
    @Optional()
    private readonly requestContext?: RequestContextService,
  ) {}

  private getPublicClient(chainId: number): PublicClient {
    const existing = this.publicClients.get(chainId);
    if (existing) return existing;
    const { chain } = getSupportedChain(chainId);
    const client = createPublicClient({ chain, transport: http() });
    this.publicClients.set(chainId, client);
    return client;
  }

  /** Return the user's EOA address and supported deposit tokens. */
  async getDepositInfo(userId: string, chainId: number) {
    const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    this.assertWalletNotFrozen(wallet);
    if (wallet.status !== 'active' || !wallet.walletAddress) {
      throw new BadRequestException(`Wallet is not active (status: ${wallet.status})`);
    }
    const supportedChain = getSupportedChain(chainId);

    return {
      walletAddress: wallet.walletAddress,
      chainId,
      chainName: supportedChain.name,
      status: wallet.status,
      supportedTokens: ['USDC', supportedChain.nativeCurrencySymbol],
    };
  }

  async listWithdrawalAddresses(userId: string) {
    if (!this.withdrawalPolicy) {
      throw new BadRequestException('Withdrawal policy service is not available');
    }
    return this.withdrawalPolicy.listWithdrawalAddresses(userId);
  }

  async addWithdrawalAddress(userId: string, dto: CreateWithdrawalAddressDto) {
    if (!this.withdrawalPolicy) {
      throw new BadRequestException('Withdrawal policy service is not available');
    }
    return this.withdrawalPolicy.addWithdrawalAddress(userId, dto);
  }

  async removeWithdrawalAddress(userId: string, addressId: string) {
    if (!this.withdrawalPolicy) {
      throw new BadRequestException('Withdrawal policy service is not available');
    }
    return this.withdrawalPolicy.removeWithdrawalAddress(userId, addressId);
  }

  /** Sign data with the user's backend agent signer (no transaction broadcast). */
  async sign(userId: string, params: SignDto, apiKeyRecord?: ApiKeySigningContext) {
    if (!apiKeyRecord) {
      throw new UnauthorizedException('API key is required for signing');
    }
    this.assertPermission(apiKeyRecord.canSign, 'API key is not allowed to sign messages');

    const chainId = this.resolveSigningChainId(params);
    if (chainId === undefined) {
      throw new BadRequestException('chainId is required for API-key signing');
    }
    getSupportedChain(chainId);
    const executionMode = this.resolveExecutionMode(params.executionMode);
    const policyContext = {
      userId,
      chainId,
      type: params.type,
      executionMode,
      apiKeyId: apiKeyRecord.id,
      apiKeyPrefix: apiKeyRecord.keyPrefix,
      allowedContracts: apiKeyRecord.allowedContracts,
      allowedFunctionSelectors: apiKeyRecord.allowedFunctionSelectors,
    };

    if (executionMode === 'eoa') {
      this.assertPermission(
        apiKeyRecord.canUseEoaExecution,
        'API key is not allowed to use EOA execution',
      );
      await this.assertEoaExecutionAllowed(userId, apiKeyRecord, {
        operation: 'sign',
        chainId,
        metadata: { type: params.type },
      });
      this.logSecurityWarning({
        message: 'Privileged EOA signing requested',
        userId,
        chainId,
        type: params.type,
        executionMode,
        apiKeyPrefix: apiKeyRecord.keyPrefix,
      });
    }

    // Apply signing policy checks
    let typedDataSummary: { typedDataPrimaryType?: string; typedDataVerifyingContract?: string; typedDataDomainName?: string } | undefined = undefined;
    if (params.type === 'message') {
      await this.signingPolicy?.assertMessageSigningPolicy(params.message!, policyContext);
    } else if (params.type === 'typed_data') {
      typedDataSummary = await this.signingPolicy?.assertTypedDataSigningPolicy(
        params.typedData!,
        policyContext,
      );
    }

    const wallet = await this.prisma.userWallet.findUnique({
      where: { userId },
      include: {
        chainAuthorizations: { where: { chainId: BigInt(chainId) } },
      },
    });
    if (!wallet) throw new NotFoundException('Wallet not found');
    this.assertWalletNotFrozen(wallet);
    if (wallet.status !== 'active' || !wallet.walletAddress) {
      throw new BadRequestException(`Wallet is not active (status: ${wallet.status})`);
    }
    if (executionMode === 'session_key') {
      this.assertAgentWalletReady(wallet);
      this.assertChainAuthorizationReady(wallet.chainAuthorizations?.[0]);
      await this.openfort.verifyAgentKeyRegistration({
        accountAddress: wallet.walletAddress,
        chainId,
        keyHash: wallet.agentKeyHash!,
      });
    } else {
      this.assertBackendWalletReady(wallet);
    }
    const signingWalletAddress =
      executionMode === 'eoa' ? wallet.agentWalletAddress! : wallet.walletAddress;

    let data: string;
    switch (params.type) {
      case 'message':
        // Compute EIP-191 personal message hash → raw ECDSA sign
        data = this.hashSignMessage(params.message!);
        break;
      case 'typed_data': {
        // Compute EIP-712 struct hash → raw ECDSA sign
        const { domain, types, primaryType, message } = params.typedData!;
        data = hashTypedData({ domain, types, primaryType, message } as any);
        break;
      }
    }

    const signingRequest = await this.prisma.signingRequest.create({
      data: {
        userId,
        apiKeyId: apiKeyRecord?.id,
        authMethod: 'api_key',
        apiKeyPrefix: apiKeyRecord?.keyPrefix,
        apiKeyName: apiKeyRecord?.name,
        type: params.type,
        chainId: chainId === undefined ? undefined : BigInt(chainId),
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

    this.logger.log(
      this.logContext({
        message: 'Created signing request',
        signingRequestId: signingRequest.id,
        userId,
        chainId,
        type: params.type,
        executionMode,
        ...(typedDataSummary ?? {}),
        apiKeyPrefix: apiKeyRecord.keyPrefix,
      }),
    );

    let signature: string;
    try {
      const accountId = wallet.agentOpenfortAccountId!;
      const rawSignature = await this.openfort.signData(accountId, data);
      signature =
        executionMode === 'session_key'
          ? this.wrapCaliburSignature(wallet.agentKeyHash!, rawSignature)
          : rawSignature;
    } catch (err) {
      this.logger.error(
        this.logContext({
          message: 'Signing request failed',
          signingRequestId: signingRequest.id,
          userId,
          chainId,
          type: params.type,
          executionMode,
          apiKeyPrefix: apiKeyRecord.keyPrefix,
        }),
        err instanceof Error ? err.stack : undefined,
      );
      await this.updateSigningRequestStatus(signingRequest.id, 'failed');
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
        apiKeyPrefix: apiKeyRecord.keyPrefix,
      }),
    );

    return {
      signature,
      walletAddress: signingWalletAddress,
      type: params.type,
      executionMode,
    };
  }

  /** Return detail for a single signing request (dashboard-only, ownership-enforced). */
  async getSigningRequestDetail(userId: string, signingRequestId: string) {
    const sr = await this.prisma.signingRequest.findFirst({
      where: { id: signingRequestId, userId },
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
    if (wallet.status !== 'active' || !wallet.agentOpenfortAccountId || !wallet.agentWalletAddress) {
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

  private assertWalletNotFrozen(wallet: { frozenAt?: Date | string | null; frozenReason?: string | null }): void {
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

  /** Return native token and USDC balances for the user's wallet on the requested chain. */
  async getBalances(userId: string, chainId: number) {
    const wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('Wallet not found');
    this.assertWalletNotFrozen(wallet);
    if (wallet.status !== 'active' || !wallet.walletAddress) {
      throw new BadRequestException(`Wallet is not active (status: ${wallet.status})`);
    }

    const walletAddress = wallet.walletAddress as `0x${string}`;

    const supportedChain = getSupportedChain(chainId);
    const publicClient = this.getPublicClient(chainId);
    const usdcAddress = supportedChain.usdcAddress;

    type BalanceEntry =
      | { token: string; formatted: string }
      | { token: string; formatted: null; error: string };

    const [ethResult, usdcResult] = await Promise.all([
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

      usdcAddress
        ? publicClient
            .readContract({
              address: usdcAddress,
              abi: ERC20_BALANCE_ABI,
              functionName: 'balanceOf',
              args: [walletAddress],
            })
            .then(
              (raw): BalanceEntry => ({
                token: 'USDC',
                formatted: formatUnits(raw, 6),
              }),
            )
            .catch(
              (): BalanceEntry => ({
                token: 'USDC',
                formatted: null,
                error: 'fetch failed',
              }),
            )
        : Promise.resolve(null),
    ]);

    const balances: BalanceEntry[] = [ethResult];
    if (usdcResult !== null) balances.push(usdcResult);

    const chains = [{ chainId, chainName: supportedChain.name, balances }];

    return { chains };
  }

  /** Submit a withdrawal transaction. */
  async withdraw(userId: string, params: WithdrawDto) {
    const chainId = params.chainId;
    const supportedChain = getSupportedChain(chainId);
    const wallet = await this.prisma.userWallet.findUnique({
      where: { userId },
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

    await this.assertWithdrawalPolicy(params, {
      userId,
      chainId,
      walletId: wallet.id,
      walletAddress: wallet.walletAddress,
    });

    const usdcAddressHex = supportedChain.usdcAddress;
    const walletAddress = wallet.walletAddress as `0x${string}`;

    const requestHash = hashRequest({
      operationType: 'withdraw',
      chainId,
      to: params.to,
      amount: params.amount,
      token: params.token,
      contractAddress: usdcAddressHex,
    });

    const existingWithdrawal = await this.findExistingWithdrawal(userId, {
      idempotencyKey: params.idempotencyKey!,
      chainId,
      requestHash,
    });
    if (existingWithdrawal) {
      return this.toWithdrawalResponse(existingWithdrawal);
    }

    // Guard: verify on-chain USDC balance is sufficient before submitting intent
    {
      const publicClient = this.getPublicClient(chainId);
      let usdcBalance: bigint;
      try {
        usdcBalance = await publicClient.readContract({
          address: usdcAddressHex,
          abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf',
          args: [walletAddress],
        });
      } catch {
        throw new BadRequestException('Unable to verify USDC balance — please retry');
      }

      const requestedAmount = BigInt(params.amount);
      if (usdcBalance < requestedAmount) {
        throw new BadRequestException(
          `Insufficient USDC balance: have ${usdcBalance.toString()} units, requested ${params.amount} units`,
        );
      }
    }

    const { tx, created } = await this.createPendingWithdrawalOrReturnExisting(userId, {
      idempotencyKey: params.idempotencyKey!,
      chainId,
      requestHash,
      walletAddress: wallet.walletAddress,
      details: {
        type: 'withdraw',
        execution: 'calibur_agent_user_operation',
        to: params.to,
        amount: params.amount,
        token: params.token,
        contractAddress: usdcAddressHex,
        agentWalletAddress: wallet.agentWalletAddress,
        agentKeyHash: wallet.agentKeyHash,
        idempotencyKey: params.idempotencyKey,
        requestHash,
      },
    });

    if (!created || tx.txHash || tx.status !== 'submitting') {
      return this.toWithdrawalResponse(tx);
    }

    try {
      const transferData = encodeFunctionData({
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
      });

      const submission = await this.openfort.sendUserOperation({
        chainId,
        agentAccountId: wallet.agentOpenfortAccountId,
        accountAddress: wallet.walletAddress,
        keyHash: wallet.agentKeyHash,
        interactions: [
          {
            to: usdcAddressHex,
            data: transferData,
            value: '0',
          },
        ],
      });

      const updated = await this.prisma.transaction.update({
        where: { id: tx.id },
        data: {
          txHash: submission.transactionHash,
          status: 'pending',
          details: {
            ...((tx.details as Record<string, unknown>) ?? {}),
            userOpHash: submission.userOpHash,
          } as any,
        },
      });

      return {
        transactionId: updated.id,
        transactionHash: updated.txHash,
        status: updated.status,
      };
    } catch (error) {
      await this.prisma.transaction.update({
        where: { id: tx.id },
        data: { status: 'unknown' },
      });
      throw error;
    }
  }

  private async assertWithdrawalPolicy(
    params: WithdrawDto,
    context: { userId: string; chainId: number; walletId?: string; walletAddress?: string },
  ): Promise<void> {
    if (this.withdrawalPolicy) {
      await this.withdrawalPolicy.assertWithdrawalAllowed(context.userId, params, context);
      return;
    }

    const amount = BigInt(params.amount);
    if (amount > USDC_MAX_AMOUNT) {
      this.logSecurityWarning({
        message: 'Withdrawal policy rejected request',
        reason: 'Withdrawal amount exceeds single-withdrawal limit',
        ...context,
        token: params.token,
        amountUnits: params.amount,
        maxAmountUnits: USDC_MAX_AMOUNT.toString(),
      });
      throw new BadRequestException('Withdrawal amount exceeds single-withdrawal limit');
    }

    if (amount >= USDC_HIGH_VALUE_AMOUNT) {
      this.logSecurityWarning({
        message: 'High-value withdrawal requested',
        ...context,
        token: params.token,
        amountUnits: params.amount,
        thresholdUnits: USDC_HIGH_VALUE_AMOUNT.toString(),
      });
    }
  }

  private async createPendingWithdrawalOrReturnExisting(
    userId: string,
    params: {
      idempotencyKey: string;
      chainId: number;
      requestHash: string;
      walletAddress: string;
      details: Record<string, unknown>;
    },
  ) {
    try {
      const tx = await this.prisma.transaction.create({
        data: {
          userId,
          status: 'submitting',
          chainId: BigInt(params.chainId),
          walletAddress: params.walletAddress,
          operationType: 'withdraw',
          idempotencyKey: params.idempotencyKey,
          requestHash: params.requestHash,
          details: params.details as any,
        },
      });
      return { tx, created: true };
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error;

      const existing = await this.findExistingWithdrawal(userId, {
        idempotencyKey: params.idempotencyKey,
        chainId: params.chainId,
        requestHash: params.requestHash,
      });
      if (!existing) throw error;
      return { tx: existing, created: false };
    }
  }

  private async findExistingWithdrawal(
    userId: string,
    params: { idempotencyKey: string; chainId: number; requestHash: string },
  ) {
    const existing = await this.prisma.transaction.findFirst({
      where: {
        userId,
        operationType: 'withdraw',
        chainId: BigInt(params.chainId),
        idempotencyKey: params.idempotencyKey,
      },
    });

    if (!existing) return null;
    if (existing.requestHash && existing.requestHash !== params.requestHash) {
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
