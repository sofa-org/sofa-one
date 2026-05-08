import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { UserWallet, WalletChainAuthorization } from '@prisma/client';
import { getAddress } from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import { AgentStatus, type AgentStatusValue } from '../../common/agent/agent-status';
import { RequestContextService } from '../../common/request-context/request-context.service';
import { ApiKeyService } from '../api-key/api-key.service';
import type { AuthorizeEmbeddedWalletDto } from './dto/authorize-embedded-wallet.dto';

type WalletResponse = {
  walletAddress: string | null;
  embeddedWalletAddress: string | null;
  status: string;
  supportedTokens: string[];
  agentWalletAddress?: string | null;
  agentKeyHash?: string | null;
  chainAuthorizations: Array<{
    chainId: number;
    status: string;
    registrationTxHash: string | null;
    expiresAt: string | null;
    updatedAt: string;
  }>;
};

type WalletWithAuthorizations = UserWallet & {
  chainAuthorizations?: WalletChainAuthorization[];
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private static readonly agentRegistrationGraceMs = 5 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly openfort: OpenfortService,
    private readonly apiKeyService: ApiKeyService,
    private readonly configService: ConfigService,
    @Optional()
    private readonly requestContext?: RequestContextService,
  ) {}

  /**
   * Handle Openfort email OTP login: upsert user and create a pending embedded-EOA record.
   * Embedded EOA creation/authorization happens client-side through Openfort React SDK.
   * API keys are created explicitly through the API-key management flow.
   */
  async syncOpenfortSession(
    openfortUserId: string,
    email?: string,
    _depth = 0,
  ): Promise<{
    userId: string;
    wallet: WalletResponse;
  }> {
    const socialProvider = 'openfort_email_otp';
    const socialId = openfortUserId;

    // 2. Look up existing user
    const existing = await this.prisma.user.findUnique({
      where: { socialId },
      include: {
        wallet: { include: { chainAuthorizations: true } },
      },
    });

    let userId: string;
    let wallet = existing?.wallet ?? null;

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
            },
            include: { chainAuthorizations: true },
          });
          return { userId: newUser.id, wallet: newWallet };
        });

        userId = result.userId;
        wallet = result.wallet;
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
          return this.syncOpenfortSession(openfortUserId, email, _depth + 1);
        }
        throw err;
      }
    } else if (!wallet) {
      // 3b. Existing user missing wallet — create a pending embedded-wallet record.
      userId = existing.id;

      try {
        wallet = await this.prisma.userWallet.create({
          data: {
            userId,
            status: 'pending_embedded_wallet',
          },
          include: { chainAuthorizations: true },
        });
      } catch (dbErr: any) {
        if (dbErr?.code === 'P2002') {
          wallet = await this.prisma.userWallet.findUnique({
            where: { userId },
            include: { chainAuthorizations: true },
          });
        }
        if (!wallet) throw dbErr;
      }
      this.logger.log(this.logContext({ message: 'Created pending wallet for existing user', userId }));
    } else {
      // 3c. Returning user with wallet — nothing to provision
      userId = existing.id;
      if (email && existing.email !== email) {
        await this.prisma.user.update({ where: { id: userId }, data: { email } });
      }
    }

    return {
      userId,
      wallet: this.toWalletResponse(wallet),
    };
  }

  /** @deprecated Use syncOpenfortSession. Kept as a compatibility alias for older callers/tests. */
  async handleSocialLogin(openfortUserId: string, _depth = 0) {
    return this.syncOpenfortSession(openfortUserId, undefined, _depth);
  }

  async authorizeEmbeddedWallet(openfortUserId: string, dto: AuthorizeEmbeddedWalletDto) {
    const user = await this.prisma.user.findUnique({
      where: { socialId: openfortUserId },
      include: { wallet: { include: { chainAuthorizations: true } } },
    });
    if (!user) throw new NotFoundException('User not found');

    const authorized = await this.openfort.authorizeEmbeddedAddress(
      dto.openfortAccessToken,
      dto.embeddedWalletAddress,
    );
    if (authorized.openfortUserId !== openfortUserId) {
      throw new NotFoundException('Openfort session does not match current user');
    }
    const chainId = dto.chainId;
    const agent = await this.ensureAgentWallet(user.wallet);
    const expiresAt = chainId ? this.agentExpiration(dto.agentExpiresAt) : null;
    const wallet = await this.prisma.$transaction(async (tx) => {
      const walletAddressChanged = Boolean(
        user.wallet?.walletAddress && user.wallet.walletAddress.toLowerCase() !== authorized.address.toLowerCase(),
      );

      const updatedWallet = await tx.userWallet.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          openfortAccountId: dto.embeddedOpenfortAccountId ?? authorized.accountId,
          walletAddress: authorized.address,
          status: 'active',
          agentOpenfortAccountId: agent.id,
          agentWalletAddress: agent.address,
          agentKeyHash: agent.keyHash,
        },
        update: {
          openfortAccountId: dto.embeddedOpenfortAccountId ?? authorized.accountId,
          walletAddress: authorized.address,
          status: 'active',
          agentOpenfortAccountId: agent.id,
          agentWalletAddress: agent.address,
          agentKeyHash: agent.keyHash,
        },
      });

      if (walletAddressChanged) {
        await tx.walletChainAuthorization.deleteMany({ where: { walletId: updatedWallet.id } });
      }

      if (chainId && expiresAt) {
        await tx.walletChainAuthorization.upsert({
          where: { walletId_chainId: { walletId: updatedWallet.id, chainId: BigInt(chainId) } },
          create: {
            walletId: updatedWallet.id,
            chainId: BigInt(chainId),
            status: AgentStatus.RegistrationRequired,
            registrationTxHash: null,
            expiresAt,
          },
          update: {
            status: AgentStatus.RegistrationRequired,
            registrationTxHash: null,
            expiresAt,
          },
        });
      }

      return tx.userWallet.findUniqueOrThrow({
        where: { userId: user.id },
        include: { chainAuthorizations: true },
      });
    });

    return {
      userId: user.id,
      wallet: this.toWalletResponse(wallet),
      agentRegistration:
        chainId && expiresAt
          ? {
              agentAddress: agent.address,
              keyHash: agent.keyHash,
              chainId,
              expiresAt: expiresAt.toISOString(),
            }
          : undefined,
    };
  }

  async markAgentRegistrationTransaction(
    openfortUserId: string,
    chainId: number,
    txHash: string,
  ): Promise<{
    userId: string;
    wallet: WalletResponse;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { socialId: openfortUserId },
      include: { wallet: { include: { chainAuthorizations: true } } },
    });
    if (!user || !user.wallet) throw new NotFoundException('User or wallet not found');

    if (!this.hasAgentRegistrationContext(user.wallet)) {
      throw new NotFoundException('Agent registration is not pending');
    }

    const authorization = this.findChainAuthorization(user.wallet, chainId);
    if (!authorization || authorization.status !== AgentStatus.RegistrationRequired) {
      throw new NotFoundException('Agent registration is not pending for this chain');
    }

    await this.prisma.walletChainAuthorization.update({
      where: { walletId_chainId: { walletId: user.wallet.id, chainId: BigInt(chainId) } },
      data: {
        status: AgentStatus.PendingRegistration,
        registrationTxHash: txHash,
      },
    });
    const wallet = await this.findWalletWithAuthorizations(user.id);

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
      wallet: this.toWalletResponse(wallet),
    };
  }

  async markAgentRegistrationResult(
    openfortUserId: string,
    chainId: number,
    reportedStatus: 'registered' | 'registration_failed',
    txHash: string,
  ): Promise<{
    userId: string;
    wallet: WalletResponse;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { socialId: openfortUserId },
      include: { wallet: { include: { chainAuthorizations: true } } },
    });
    if (!user || !user.wallet) throw new NotFoundException('User or wallet not found');

    if (!this.hasAgentRegistrationContext(user.wallet)) {
      throw new NotFoundException('Agent registration is not pending');
    }

    const authorization = this.findChainAuthorization(user.wallet, chainId);
    if (!authorization) {
      throw new NotFoundException('Agent registration is not pending for this chain');
    }

    let status: AgentStatusValue = AgentStatus.RegistrationFailed;
    if (reportedStatus === AgentStatus.Registered) {
      await this.openfort.verifyAgentKeyRegistration({
        accountAddress: user.wallet.walletAddress!,
        chainId,
        keyHash: user.wallet.agentKeyHash!,
      });
      status = AgentStatus.Registered;
    }

    await this.prisma.walletChainAuthorization.update({
      where: { walletId_chainId: { walletId: user.wallet.id, chainId: BigInt(chainId) } },
      data: { status, registrationTxHash: txHash },
    });
    const wallet = await this.findWalletWithAuthorizations(user.id);

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
      wallet: this.toWalletResponse(wallet),
    };
  }

  private logContext(extra: Record<string, unknown>) {
    return this.requestContext?.getLogContext(extra) ?? extra;
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
    return wallet.chainAuthorizations?.find((authorization) => Number(authorization.chainId) === chainId);
  }

  private async findWalletWithAuthorizations(userId: string) {
    return this.prisma.userWallet.findUniqueOrThrow({
      where: { userId },
      include: { chainAuthorizations: true },
    });
  }

  /**
   * Return the current user's wallet info from DB (no Openfort calls).
   */
  async getMe(openfortUserId: string): Promise<{
    userId: string;
    wallet: WalletResponse;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { socialId: openfortUserId },
      include: { wallet: { include: { chainAuthorizations: true } } },
    });

    if (!user || !user.wallet) throw new NotFoundException('User or wallet not found');

    const wallet = await this.selfHealAgentRegistrations(user.wallet);

    return {
      userId: user.id,
      wallet: this.toWalletResponse(wallet),
    };
  }

  private async selfHealAgentRegistrations(wallet: WalletWithAuthorizations) {
    if (!this.hasAgentRegistrationContext(wallet)) return wallet;

    let changed = false;
    for (const authorization of wallet.chainAuthorizations ?? []) {
      if (authorization.status !== AgentStatus.PendingRegistration) continue;

      if (!authorization.registrationTxHash) {
        await this.prisma.walletChainAuthorization.update({
          where: {
            walletId_chainId: { walletId: wallet.id, chainId: authorization.chainId },
          },
          data: { status: AgentStatus.RegistrationRequired },
        });
        changed = true;
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
        await this.prisma.walletChainAuthorization.update({
          where: {
            walletId_chainId: { walletId: wallet.id, chainId: authorization.chainId },
          },
          data: { status: AgentStatus.RegistrationFailed },
        });
        changed = true;
        continue;
      }

      try {
        await this.openfort.verifyAgentKeyRegistration({
          accountAddress: wallet.walletAddress!,
          chainId: Number(authorization.chainId),
          keyHash: wallet.agentKeyHash!,
        });
        await this.prisma.walletChainAuthorization.update({
          where: {
            walletId_chainId: { walletId: wallet.id, chainId: authorization.chainId },
          },
          data: { status: AgentStatus.Registered },
        });
        changed = true;
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

    return changed ? this.findWalletWithAuthorizations(wallet.userId) : wallet;
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

  private async ensureAgentWallet(wallet: UserWallet | null) {
    if (wallet?.agentOpenfortAccountId && wallet.agentWalletAddress && wallet.agentKeyHash) {
      return {
        id: wallet.agentOpenfortAccountId,
        address: getAddress(wallet.agentWalletAddress),
        keyHash: wallet.agentKeyHash,
      };
    }

    return this.openfort.createAgentWallet();
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

    return expiresAt;
  }

  private toWalletResponse(wallet: WalletWithAuthorizations): WalletResponse {
    return {
      walletAddress: wallet.walletAddress,
      embeddedWalletAddress: wallet.walletAddress,
      status: wallet.status,
      supportedTokens: ['USDC', 'ETH'],
      agentWalletAddress: wallet.agentWalletAddress,
      agentKeyHash: wallet.agentKeyHash,
      chainAuthorizations: (wallet.chainAuthorizations ?? [])
        .map((authorization) => ({
          chainId: Number(authorization.chainId),
          status: authorization.status,
          registrationTxHash: authorization.registrationTxHash,
          expiresAt: authorization.expiresAt?.toISOString() ?? null,
          updatedAt: authorization.updatedAt.toISOString(),
        }))
        .sort((a, b) => a.chainId - b.chainId),
    };
  }
}
