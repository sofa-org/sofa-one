import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { UserWallet, WalletChainAuthorization } from '@prisma/client';
import { getAddress, isAddress } from 'viem';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import { AgentStatus, type AgentStatusValue } from '../../common/agent/agent-status';
import { getSupportedChain } from '../../common/chains/supported-chains';
import { RequestContextService } from '../../common/request-context/request-context.service';
import { SecurityEventService } from '../security-events/security-event.service';
import { ApiKeyService } from '../api-key/api-key.service';
import { BillingEntitlementService } from '../billing/billing-entitlement.service';
import { BillingWalletLifecycleService } from '../billing/billing-wallet-lifecycle.service';
import type { AuthorizeEmbeddedWalletDto } from './dto/authorize-embedded-wallet.dto';

type WalletResponse = {
  id: string;
  isDefault: boolean;
  provisioningStatus: string | null;
  walletAddress: string | null;
  status: string;
  agentWalletAddress?: string | null;
  agentKeyHash?: string | null;
  chainAuthorizations: Array<{
    chainId: number;
    status: string;
    registrationTxHash: string | null;
    expiresAt: string | null;
  }>;
};

type WalletWithAuthorizations = UserWallet & {
  chainAuthorizations?: WalletChainAuthorization[];
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private static readonly agentRegistrationGraceMs = 5 * 60 * 1000;
  private static readonly agentAuthorizationMaxTtlMs = 30 * 24 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly openfort: OpenfortService,
    private readonly apiKeyService: ApiKeyService,
    private readonly configService: ConfigService,
    private readonly billingEntitlements: BillingEntitlementService,
    private readonly walletLifecycle: BillingWalletLifecycleService,
    @Optional()
    private readonly requestContext?: RequestContextService,
    @Optional()
    private readonly securityEvents?: SecurityEventService,
  ) {}

  /**
   * Handle Openfort email OTP login: upsert user and create a pending embedded-EOA record.
   * Embedded EOA creation/authorization happens client-side through Openfort React SDK.
   * API keys are created explicitly through the API-key management flow.
   */
  async syncOpenfortSession(
    openfortUserId: string,
    email?: string,
    clientIp?: string,
    userAgent?: string,
    _depth = 0,
  ): Promise<{
    userId: string;
    wallet: WalletResponse;
    wallets: WalletResponse[];
  }> {
    const socialProvider = 'openfort_email_otp';
    const socialId = openfortUserId;

    // 2. Look up existing user
    const existing = await this.prisma.user.findUnique({
      where: { socialId },
    include: { wallets: { include: { chainAuthorizations: true, provisioningIntent: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] } },
    });

    let userId: string;
    let wallets: any[] = existing?.wallets ?? [];

    if (!existing) {
      try {
        const result = await this.prisma.$transaction(async (tx) => {
          const newUser = await tx.user.create({
            data: { socialProvider, socialId, email },
          });
          const newWallet = await tx.userWallet.create({
            data: {
              userId: newUser.id,
              status: 'pending_embedded_wallet',
              isDefault: true,
            },
            include: { chainAuthorizations: true },
          });
          return { userId: newUser.id, wallet: newWallet };
        });

        userId = result.userId;
        wallets = [result.wallet];
        this.logger.log(
          this.logContext({ message: 'Created Openfort IAM user', userId, socialProvider }),
        );
      } catch (err: any) {
        if (err?.code === 'P2002') {
          if (_depth >= 3) {
            throw new InternalServerErrorException('User creation conflict could not be resolved');
          }
          this.logger.warn(
            this.logContext({
              message: 'Race condition on user creation, retrying as existing user',
              socialProvider,
              depth: _depth,
            }),
          );
          return this.syncOpenfortSession(openfortUserId, email, clientIp, userAgent, _depth + 1);
        }
        throw err;
      }
    } else if (!wallets.length) {
      // 3b. Existing user missing wallet — create a pending embedded-wallet record.
      userId = existing.id;
      let wallet: any;

      try {
        wallet = await this.prisma.userWallet.create({
          data: {
            userId,
            status: 'pending_embedded_wallet',
            isDefault: true,
          },
          include: { chainAuthorizations: true },
        });
      } catch (dbErr: any) {
        if (dbErr?.code === 'P2002') {
          wallet = await this.prisma.userWallet.findFirst({
            where: { userId },
            include: { chainAuthorizations: true },
          });
        }
        if (!wallet) throw dbErr;
      }
      wallets = [wallet];
      this.logger.log(
        this.logContext({ message: 'Created pending wallet for existing user', userId }),
      );
    } else {
      // 3c. Returning user with wallet — nothing to provision
      userId = existing.id;
      if (email && existing.email !== email) {
        await this.prisma.user.update({ where: { id: userId }, data: { email } });
      }
    }

    wallets = await this.repairAndLoadDefault(userId);
    const projected = wallets.map((row) => this.toWalletResponse(row));

    // Track login IP: record a security event if this IP is new for the user.
    await this.trackLoginIp(userId, clientIp, userAgent);

    return {
      userId,
      wallet: projected[0],
      wallets: projected,
    };
  }

  /** @deprecated Use syncOpenfortSession. Kept as a compatibility alias for older callers/tests. */
  async handleSocialLogin(openfortUserId: string, _depth = 0) {
    return this.syncOpenfortSession(openfortUserId, undefined, undefined, undefined, _depth);
  }

  async authorizeEmbeddedWallet(
    openfortUserId: string,
    openfortAccessToken: string,
    dto: AuthorizeEmbeddedWalletDto,
  ) {
    const user = await this.prisma.user.findUnique({ where: { socialId: openfortUserId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.frozenAt) throw new ConflictException('User is frozen');

    const authorized = await this.openfort.authorizeEmbeddedAddress(
      openfortAccessToken,
      dto.embeddedWalletAddress,
    );
    if (authorized.openfortUserId !== openfortUserId || !authorized.accountId) {
      throw new NotFoundException('Openfort session does not match current user');
    }
    if (dto.embeddedOpenfortAccountId && dto.embeddedOpenfortAccountId !== authorized.accountId) {
      throw new ConflictException('Embedded account identity does not match provider verification');
    }
    const chainId = dto.chainId;
    if (chainId) getSupportedChain(chainId);
    const expiresAt = chainId ? this.agentExpiration(dto.agentExpiresAt) : null;
    const address = authorized.address.toLowerCase();
    const claims = await this.prisma.userWallet.findMany({ where: { OR: [{ openfortAccountId: authorized.accountId }, { walletAddress: { equals: address, mode: 'insensitive' } }] }, select: { userId: true } });
    if (claims.some((claim) => claim.userId !== user.id)) throw new ConflictException('Embedded wallet identity is already bound');
    const reservation = await this.walletLifecycle.withWalletAccountLock(user.id, async (tx, accountId, now) => {
      await this.walletLifecycle.initializeWalletCount(tx, accountId, user.id, now);
      const matches = await tx.userWallet.findMany({ where: { userId: user.id, OR: [{ openfortAccountId: authorized.accountId }, { walletAddress: { equals: address, mode: 'insensitive' } }] }, include: { provisioningIntent: true, chainAuthorizations: true } });
      if (matches.length > 1) throw new ConflictException('Embedded wallet identity conflicts with existing wallet records');
      let wallet = matches[0];
      const wasEligible = Boolean(wallet && wallet.status === 'active' && wallet.walletAddress && !wallet.frozenAt);
      if (wallet && ((wallet.openfortAccountId && wallet.openfortAccountId !== authorized.accountId) || (wallet.walletAddress && wallet.walletAddress.toLowerCase() !== address))) throw new ConflictException('Wallet identity is immutable');
      if (wallet && (!wallet.openfortAccountId || !wallet.walletAddress)) {
        const result = await tx.userWallet.updateMany({ where: { id: wallet.id, userId: user.id, ...(wallet.openfortAccountId ? { openfortAccountId: wallet.openfortAccountId } : { openfortAccountId: null }), ...(wallet.walletAddress ? { walletAddress: wallet.walletAddress } : { walletAddress: null }), frozenAt: null }, data: { ...(!wallet.openfortAccountId ? { openfortAccountId: authorized.accountId } : {}), ...(!wallet.walletAddress ? { walletAddress: authorized.address } : {}) } });
        if (result.count !== 1) throw new ConflictException('Wallet identity changed during binding');
        wallet = { ...wallet, openfortAccountId: authorized.accountId!, walletAddress: authorized.address };
      }
      if (!wallet) {
        const placeholder = await tx.userWallet.findFirst({ where: { userId: user.id, status: 'pending_embedded_wallet', openfortAccountId: null, walletAddress: null, agentOpenfortAccountId: null, agentWalletAddress: null, agentKeyHash: null, frozenAt: null, provisioningIntent: null, chainAuthorizations: { none: {} } } });
        const reservedWalletId = placeholder?.id ?? randomUUID();
        await this.walletLifecycle.assertWalletReservationAllowed(tx, user.id, reservedWalletId, new Date());
        if (placeholder) wallet = await tx.userWallet.update({ where: { id: placeholder.id }, data: { openfortAccountId: authorized.accountId, walletAddress: authorized.address }, include: { provisioningIntent: true, chainAuthorizations: true } });
        else wallet = await tx.userWallet.create({ data: { id: reservedWalletId, userId: user.id, openfortAccountId: authorized.accountId, walletAddress: authorized.address, status: 'pending_embedded_wallet', isDefault: false }, include: { provisioningIntent: true, chainAuthorizations: true } });
      }
      if (wallet.frozenAt) throw new ConflictException('Wallet is frozen');
      const parts = [wallet.agentOpenfortAccountId, wallet.agentWalletAddress, wallet.agentKeyHash];
      if (parts.some(Boolean) && !parts.every(Boolean)) throw new ConflictException('Incomplete agent wallet identity requires review');
      if (wallet.status === 'active' && !wallet.agentOpenfortAccountId) throw new ConflictException('Active wallet agent identity requires review');
      if (parts.every(Boolean) && !wallet.provisioningIntent) {
        if (wallet.status === 'active') {
          const isEligible = Boolean(wallet.walletAddress && !wallet.frozenAt);
          if (!wasEligible && isEligible) await this.walletLifecycle.recordWalletActivation(tx, accountId, user.id, now);
          return { wallet, intent: null, accountId };
        }
        return { wallet, intent: null, accountId, legacyAgent: true };
      }
      if (wallet.status === 'active' && wallet.agentOpenfortAccountId && wallet.agentWalletAddress && wallet.agentKeyHash) {
        const isEligible = Boolean(wallet.walletAddress && !wallet.frozenAt);
        if (!wasEligible && isEligible) await this.walletLifecycle.recordWalletActivation(tx, accountId, user.id, now);
        return { wallet, intent: null, accountId };
      }
      let intent = wallet.provisioningIntent;
      if (!intent) {
        await this.walletLifecycle.assertWalletReservationAllowed(tx, user.id, wallet.id, new Date());
        intent = await tx.walletProvisioningIntent.create({ data: { walletId: wallet.id } });
      }
      return { wallet, intent, accountId };
    });
    if ((reservation as any).legacyAgent) {
      await this.walletLifecycle.withWalletAccountLock(user.id, async (tx, accountId, now) => {
        const latestUser = await tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { frozenAt: true } });
        const current = await tx.userWallet.findUniqueOrThrow({ where: { id: reservation.wallet.id } });
        if (latestUser.frozenAt || current.frozenAt) throw new ConflictException('User or wallet is frozen');
        if (current.openfortAccountId !== authorized.accountId || current.walletAddress?.toLowerCase() !== address) throw new ConflictException('Wallet identity changed during activation');
        if (current.agentOpenfortAccountId !== reservation.wallet.agentOpenfortAccountId || current.agentWalletAddress !== reservation.wallet.agentWalletAddress || current.agentKeyHash !== reservation.wallet.agentKeyHash) throw new ConflictException('Legacy agent identity changed during activation');
        if (current.status !== 'active') {
          await tx.userWallet.update({ where: { id: current.id }, data: { status: 'active' } });
          await this.walletLifecycle.recordWalletActivation(tx, accountId, user.id, now);
        }
      });
    }
    if (reservation.intent) {
      let intent = await this.prisma.walletProvisioningIntent.findUniqueOrThrow({ where: { walletId: reservation.wallet.id } });
      if (intent.status === 'pending') {
        const token = randomUUID();
        const dispatch = await this.walletLifecycle.withWalletAccountLock(user.id, async (tx, _accountId, now) => {
          const latestUser = await tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { frozenAt: true } });
          const latestWallet = await tx.userWallet.findUniqueOrThrow({ where: { id: reservation.wallet.id } });
          if (latestUser.frozenAt || latestWallet.frozenAt) throw new ConflictException('User or wallet is frozen');
          if (latestWallet.openfortAccountId !== authorized.accountId || latestWallet.walletAddress?.toLowerCase() !== address) throw new ConflictException('Wallet identity changed during provisioning');
          await this.walletLifecycle.assertWalletReservationAllowed(tx, user.id, latestWallet.id, now);
          return tx.walletProvisioningIntent.updateMany({ where: { id: intent.id, status: 'pending', dispatchToken: null, agentOpenfortAccountId: null, agentWalletAddress: null, agentKeyHash: null }, data: { status: 'dispatched', dispatchToken: token, dispatchedAt: now } });
        });
        if (dispatch.count === 1) {
          let agent: { id: string; address: string; keyHash: string };
          try {
            agent = await this.openfort.createAgentWallet();
            if (!agent.id || !isAddress(agent.address) || !/^0x[0-9a-fA-F]{64}$/.test(agent.keyHash)) throw new Error('Provider returned malformed agent identity');
          } catch (error) {
            await this.prisma.walletProvisioningIntent.updateMany({ where: { id: intent.id, dispatchToken: token, status: 'dispatched' }, data: { status: 'uncertain' } });
            throw error;
          }
          const saved = await this.prisma.walletProvisioningIntent.updateMany({ where: { id: intent.id, dispatchToken: token, status: 'dispatched', agentOpenfortAccountId: null, agentWalletAddress: null, agentKeyHash: null, wallet: { agentOpenfortAccountId: null, agentWalletAddress: null, agentKeyHash: null } }, data: { status: 'provisioned', agentOpenfortAccountId: agent.id, agentWalletAddress: getAddress(agent.address), agentKeyHash: agent.keyHash } });
          if (saved.count !== 1) throw new ConflictException('Provisioning result could not be safely recorded');
        } else { intent = await this.prisma.walletProvisioningIntent.findUniqueOrThrow({ where: { walletId: reservation.wallet.id } }); }
      }
      intent = await this.prisma.walletProvisioningIntent.findUniqueOrThrow({ where: { walletId: reservation.wallet.id } });
      if (intent.status !== 'provisioned') throw new ConflictException('Wallet provisioning is pending review');
      if (!intent.dispatchToken || !intent.agentOpenfortAccountId || !intent.agentWalletAddress || !isAddress(intent.agentWalletAddress) || !intent.agentKeyHash || !/^0x[0-9a-fA-F]{64}$/.test(intent.agentKeyHash)) throw new ConflictException('Provisioned agent identity is incomplete or malformed');
      await this.walletLifecycle.withWalletAccountLock(user.id, async (tx, accountId, now) => {
        const latestUser = await tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { frozenAt: true } });
        const current = await tx.userWallet.findUniqueOrThrow({ where: { id: reservation.wallet.id } });
        if (latestUser.frozenAt || current.frozenAt) throw new ConflictException('User or wallet is frozen');
        if (current.openfortAccountId !== authorized.accountId || current.walletAddress?.toLowerCase() !== address) throw new ConflictException('Wallet identity changed during provisioning');
        const currentAgent = [current.agentOpenfortAccountId, current.agentWalletAddress, current.agentKeyHash];
        if (currentAgent.some(Boolean) && (current.agentOpenfortAccountId !== intent.agentOpenfortAccountId || current.agentWalletAddress?.toLowerCase() !== intent.agentWalletAddress!.toLowerCase() || current.agentKeyHash !== intent.agentKeyHash)) throw new ConflictException('Wallet agent identity conflicts with provisioned intent');
        if (current.status === 'active' && !currentAgent.every(Boolean)) throw new ConflictException('Active wallet agent identity requires review');
        if (current.status !== 'active') {
          await tx.userWallet.update({ where: { id: current.id }, data: { status: 'active', agentOpenfortAccountId: intent.agentOpenfortAccountId!, agentWalletAddress: intent.agentWalletAddress!, agentKeyHash: intent.agentKeyHash! } });
          await this.walletLifecycle.recordWalletActivation(tx, accountId, user.id, now);
        }
        await tx.walletProvisioningIntent.updateMany({ where: { id: intent.id, status: 'provisioned' }, data: { status: 'completed' } });
      });
    }
    let wallet = await this.prisma.userWallet.findFirstOrThrow({ where: { id: reservation.wallet.id }, include: { chainAuthorizations: true } });
    if (chainId && expiresAt) {
      const prior = wallet.chainAuthorizations.find((a) => Number(a.chainId) === chainId);
      if (!prior) await this.prisma.walletChainAuthorization.create({ data: { walletId: wallet.id, chainId: BigInt(chainId), status: AgentStatus.RegistrationRequired, expiresAt } });
      else if (prior.status === AgentStatus.RegistrationRequired && !prior.registrationTxHash) await this.prisma.walletChainAuthorization.updateMany({ where: { walletId: wallet.id, chainId: BigInt(chainId), status: AgentStatus.RegistrationRequired, registrationTxHash: null, wallet: { is: { frozenAt: null, user: { is: { frozenAt: null } } } } }, data: { expiresAt } });
      else if (dto.agentExpiresAt && (prior.status === AgentStatus.Registered || prior.status === AgentStatus.Expired || (prior.status === AgentStatus.RegistrationFailed && prior.expiresAt && prior.expiresAt <= new Date()))) {
        const renewed = await this.prisma.walletChainAuthorization.updateMany({
          where: { walletId: wallet.id, chainId: BigInt(chainId), status: prior.status, registrationTxHash: prior.registrationTxHash, wallet: { is: { frozenAt: null, user: { is: { frozenAt: null } } } } },
          data: { status: AgentStatus.RegistrationRequired, registrationTxHash: null, expiresAt },
        });
        if (renewed.count !== 1) throw new ConflictException('Registration renewal raced with another wallet update');
      }
      wallet = await this.findWalletWithAuthorizations(wallet.id);
    }

    return {
      userId: user.id,
      wallet: this.toWalletResponse(wallet),
    };
  }

  async markAgentRegistrationTransaction(
    openfortUserId: string,
    chainId: number,
    txHash: string,
    walletId?: string,
  ): Promise<{
    userId: string;
    wallet: WalletResponse;
  }> {
    const user = await this.prisma.user.findUnique({ where: { socialId: openfortUserId }, select: { id: true, frozenAt: true } });
    if (!user) throw new NotFoundException('User or wallet not found');
    if (user.frozenAt) throw new ConflictException('User is frozen');
    const wallet = await this.resolveRegistrationWallet(user.id, walletId);
    if (wallet.frozenAt) throw new ConflictException('Wallet is frozen');

    if (!this.hasAgentRegistrationContext(wallet)) {
      throw new NotFoundException('Agent registration is not pending');
    }

    const authorization = this.findChainAuthorization(wallet, chainId);
    if (!authorization || (authorization.status !== AgentStatus.RegistrationRequired && authorization.status !== AgentStatus.RegistrationFailed)) {
      throw new NotFoundException('Agent registration is not pending for this chain');
    }

    const changed = await this.prisma.walletChainAuthorization.updateMany({
      where: { walletId: wallet.id, chainId: BigInt(chainId), status: authorization.status, registrationTxHash: authorization.registrationTxHash, wallet: { is: { frozenAt: null, user: { is: { frozenAt: null } } } } },
      data: {
        status: AgentStatus.PendingRegistration,
        registrationTxHash: txHash,
      },
    });
    if (changed.count !== 1) throw new ConflictException('Agent registration changed; reload wallet state');
    const updatedWallet = await this.findWalletWithAuthorizations(wallet.id);

    this.logger.log(
      this.logContext({
        message: 'Agent registration transaction hash recorded',
        userId: user.id,
        chainId,
        txHash,
      }),
    );

    return {
      userId: user.id,
      wallet: this.toWalletResponse(updatedWallet),
    };
  }

  async markAgentRegistrationResult(
    openfortUserId: string,
    chainId: number,
    reportedStatus: 'registered' | 'registration_failed',
    txHash: string,
    walletId?: string,
  ): Promise<{
    userId: string;
    wallet: WalletResponse;
  }> {
    const user = await this.prisma.user.findUnique({ where: { socialId: openfortUserId }, select: { id: true, frozenAt: true } });
    if (!user) throw new NotFoundException('User or wallet not found');
    if (user.frozenAt) throw new ConflictException('User is frozen');
    const wallet = await this.resolveRegistrationWallet(user.id, walletId);
    if (wallet.frozenAt) throw new ConflictException('Wallet is frozen');

    if (!this.hasAgentRegistrationContext(wallet)) {
      throw new NotFoundException('Agent registration is not pending');
    }

    const authorization = this.findChainAuthorization(wallet, chainId);
    if (!authorization || authorization.status !== AgentStatus.PendingRegistration || authorization.registrationTxHash !== txHash) {
      throw new NotFoundException('Agent registration is not pending for this chain');
    }

    let status: AgentStatusValue = AgentStatus.RegistrationFailed;
    if (reportedStatus === AgentStatus.Registered) {
      await this.openfort.verifyAgentKeyRegistration({
          accountAddress: wallet.walletAddress!,
        chainId,
          keyHash: wallet.agentKeyHash!,
      });
      status = AgentStatus.Registered;
    }

    const changed = await this.prisma.walletChainAuthorization.updateMany({
      where: { walletId: wallet.id, chainId: BigInt(chainId), status: AgentStatus.PendingRegistration, registrationTxHash: txHash, wallet: { is: { frozenAt: null, user: { is: { frozenAt: null } } } } },
      data: { status },
    });
    if (changed.count !== 1) throw new ConflictException('Agent registration changed; reload wallet state');
    const updatedWallet = await this.findWalletWithAuthorizations(wallet.id);

    this.logger.log(
      this.logContext({
        message: 'Agent registration transaction result recorded',
        userId: user.id,
        chainId,
        status,
        txHash,
      }),
    );

    return {
      userId: user.id,
      wallet: this.toWalletResponse(updatedWallet),
    };
  }

  private logContext(extra: Record<string, unknown>) {
    return this.requestContext?.getLogContext(extra) ?? extra;
  }

  /**
   * Track login IP: if this IP has not been seen for this user before,
   * record it and emit a login.new_ip security event.
   */
  private async trackLoginIp(userId: string, clientIp?: string, userAgent?: string) {
    if (!clientIp || !this.securityEvents) return;

    try {
      const existing = await this.prisma.userKnownIp.findUnique({
        where: { userId_ip: { userId, ip: clientIp } },
      });

      if (!existing) {
        await this.prisma.userKnownIp.create({
          data: { userId, ip: clientIp },
        });

        await this.securityEvents.record({
          actorType: 'user',
          eventType: 'login.new_ip',
          userId,
          riskLevel: 'medium',
          ip: clientIp,
          userAgent: userAgent ?? null,
          result: 'allowed',
          reason: 'new_ip_login',
          metadata: { ip: clientIp },
        });
      }
    } catch (error) {
      this.logger.warn(
        this.logContext({ message: 'Failed to track login IP', userId, ip: clientIp, error }),
      );
    }
  }

  private hasAgentRegistrationContext(wallet: UserWallet) {
    return Boolean(
      wallet.status === 'active' &&
      wallet.walletAddress &&
      wallet.agentOpenfortAccountId &&
      wallet.agentWalletAddress &&
      wallet.agentKeyHash,
    );
  }

  private findChainAuthorization(wallet: WalletWithAuthorizations, chainId: number) {
    return wallet.chainAuthorizations?.find(
      (authorization) => Number(authorization.chainId) === chainId,
    );
  }

  private async findWalletWithAuthorizations(walletId: string) {
    return this.prisma.userWallet.findUniqueOrThrow({
      where: { id: walletId },
      include: { chainAuthorizations: true },
    });
  }

  private async repairAndLoadDefault(userId: string) {
    return this.walletLifecycle.withWalletAccountLock(userId, async (tx) => {
      const rows = await tx.userWallet.findMany({ where: { userId }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }] });
      if (rows.length) {
        const keeper = rows.find((row) => row.isDefault) ?? rows[0];
        await tx.userWallet.updateMany({ where: { userId, id: { not: keeper.id }, isDefault: true }, data: { isDefault: false } });
        if (!keeper.isDefault) await tx.userWallet.updateMany({ where: { id: keeper.id, userId, isDefault: false }, data: { isDefault: true } });
      }
      return tx.userWallet.findMany({ where: { userId }, include: { chainAuthorizations: true, provisioningIntent: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }] });
    });
  }

  private async resolveRegistrationWallet(userId: string, requestedWalletId?: string) {
    if (requestedWalletId) {
      const wallet = await this.prisma.userWallet.findFirst({
        where: { id: requestedWalletId, userId },
        include: { chainAuthorizations: true },
      });
      if (!wallet) throw new NotFoundException('Wallet not found');
      return wallet;
    }
    const wallets = await this.prisma.userWallet.findMany({
      where: { userId },
      include: { chainAuthorizations: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    if (wallets.length > 1) throw new BadRequestException('walletId is required when multiple wallets exist');
    if (!wallets.length) throw new NotFoundException('User or wallet not found');
    return wallets[0];
  }

  /**
   * Return the current user's wallet info from DB (no Openfort calls).
   */
  async getMe(openfortUserId: string): Promise<{
    userId: string;
    wallet: WalletResponse;
    wallets: WalletResponse[];
  }> {
    const user = await this.prisma.user.findUnique({
      where: { socialId: openfortUserId },
      include: { wallets: { include: { chainAuthorizations: true, provisioningIntent: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] } },
    });

    if (!user || !user.wallets.length) throw new NotFoundException('User or wallet not found');

    await Promise.all(user.wallets.map((row) => this.selfHealAgentRegistrations(row)));
    const wallets = await this.repairAndLoadDefault(user.id);
    const projected = wallets.map((row) => this.toWalletResponse(row));

    return {
      userId: user.id,
      wallet: projected[0], wallets: projected,
    };
  }

  private async selfHealAgentRegistrations(wallet: WalletWithAuthorizations) {
    if (!this.hasAgentRegistrationContext(wallet)) return wallet;

    let changed = false;
    for (const authorization of wallet.chainAuthorizations ?? []) {
      if (authorization.status !== AgentStatus.PendingRegistration) continue;

      if (!authorization.registrationTxHash) {
        const result = await this.prisma.walletChainAuthorization.updateMany({ where: { walletId: wallet.id, chainId: authorization.chainId, status: AgentStatus.PendingRegistration, registrationTxHash: null }, data: { status: AgentStatus.RegistrationRequired } });
        changed ||= result.count === 1;
        continue;
      }

      let receiptStatus: 'success' | 'reverted' | null;
      try {
        receiptStatus = await this.openfort.getTransactionReceiptStatus(
          Number(authorization.chainId),
          authorization.registrationTxHash,
        );
      } catch (error: any) {
        this.logger.warn(
          this.logContext({
            message: 'Agent registration receipt check pending',
            userId: wallet.userId,
            chainId: Number(authorization.chainId),
            txHash: authorization.registrationTxHash,
            error: error?.message ?? String(error),
          }),
        );
        continue;
      }

      if (!receiptStatus) continue;

      if (receiptStatus === 'reverted') {
        const result = await this.prisma.walletChainAuthorization.updateMany({ where: { walletId: wallet.id, chainId: authorization.chainId, status: AgentStatus.PendingRegistration, registrationTxHash: authorization.registrationTxHash }, data: { status: AgentStatus.RegistrationFailed } });
        changed ||= result.count === 1;
        continue;
      }

      try {
        await this.openfort.verifyAgentKeyRegistration({
          accountAddress: wallet.walletAddress!,
          chainId: Number(authorization.chainId),
          keyHash: wallet.agentKeyHash!,
        });
        const result = await this.prisma.walletChainAuthorization.updateMany({ where: { walletId: wallet.id, chainId: authorization.chainId, status: AgentStatus.PendingRegistration, registrationTxHash: authorization.registrationTxHash }, data: { status: AgentStatus.Registered } });
        changed ||= result.count === 1;
      } catch (error: any) {
        this.logger.warn(
          this.logContext({
            message: 'Agent registration verification pending',
            userId: wallet.userId,
            chainId: Number(authorization.chainId),
            txHash: authorization.registrationTxHash,
            error: error?.message ?? String(error),
          }),
        );
      }
    }

    return changed ? this.findWalletWithAuthorizations(wallet.id) : wallet;
  }

  /**
   * Revoke all existing keys and issue a fresh one.
   */
  async refreshApiKey(openfortUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { socialId: openfortUserId },
    });
    if (!user) throw new NotFoundException('User not found');

    const result = await this.apiKeyService.rotateApiKey(user.id, 'Refreshed');

    return { apiKey: result.rawKey };
  }

  private agentExpiration(requestedExpiresAt?: string): Date {
    if (!requestedExpiresAt) {
      return new Date(Date.now() + AuthService.agentRegistrationGraceMs);
    }

    const expiresAt = new Date(requestedExpiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new BadRequestException('Agent expiry time must be a valid ISO date');
    }
    if (expiresAt <= new Date()) {
      throw new BadRequestException('Agent expiry time must be in the future');
    }
    if (expiresAt.getTime() - Date.now() > AuthService.agentAuthorizationMaxTtlMs) {
      throw new BadRequestException('Agent expiry time must be within 30 days');
    }

    return expiresAt;
  }

  private toWalletResponse(wallet: WalletWithAuthorizations): WalletResponse {
    return {
      id: wallet.id,
      isDefault: wallet.isDefault,
      provisioningStatus: (wallet as any).provisioningIntent?.status ?? null,
      walletAddress: wallet.walletAddress,
      status: wallet.status,
      agentWalletAddress: wallet.agentWalletAddress,
      agentKeyHash: wallet.agentKeyHash,
      chainAuthorizations: (wallet.chainAuthorizations ?? [])
        .map((authorization) => ({
          chainId: Number(authorization.chainId),
          status: authorization.status,
          registrationTxHash: authorization.registrationTxHash,
          expiresAt: authorization.expiresAt?.toISOString() ?? null,
        }))
        .sort((a, b) => a.chainId - b.chainId),
    };
  }
}
