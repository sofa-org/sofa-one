import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClerkClient } from '@clerk/backend';
import type { UserWallet } from '@prisma/client';
import { getAddress } from 'viem';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import { RequestContextService } from '../../common/request-context/request-context.service';
import { ApiKeyService } from '../api-key/api-key.service';
import type { AuthorizeEmbeddedWalletDto } from './dto/authorize-embedded-wallet.dto';

type WalletResponse = {
  walletAddress: string | null;
  embeddedWalletAddress: string | null;
  chainId: number;
  status: string;
  supportedTokens: string[];
  agentWalletAddress?: string | null;
  agentStatus?: string | null;
  agentKeyHash?: string | null;
  agentExpiresAt?: string | null;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly clerkClient;

  constructor(
    private readonly prisma: PrismaService,
    private readonly openfort: OpenfortService,
    private readonly apiKeyService: ApiKeyService,
    private readonly configService: ConfigService,
    @Optional()
    private readonly requestContext?: RequestContextService,
  ) {
    this.clerkClient = createClerkClient({
      secretKey: this.configService.getOrThrow<string>('clerk.secretKey'),
    });
  }

  /**
   * Handle social login: upsert user, create a pending embedded-wallet record, generate API key.
   * Embedded wallet creation/authorization happens client-side through Openfort React SDK.
   * The apiKey field is only present on first login (one-time display).
   */
  async handleSocialLogin(
    clerkUserId: string,
    _depth = 0,
  ): Promise<{
    userId: string;
    wallet: WalletResponse;
    apiKey?: string;
  }> {
    // 1. Fetch Clerk user profile
    const clerkUser = await this.clerkClient.users.getUser(clerkUserId);
    const primaryEmail = clerkUser.emailAddresses?.[0]?.emailAddress;
    const socialProvider = clerkUser.externalAccounts?.[0]?.provider || 'unknown';
    const socialId = clerkUserId;

    // 2. Look up existing user
    const existing = await this.prisma.user.findUnique({
      where: { socialId },
      include: {
        wallet: true,
        apiKeys: { where: { revoked: false } },
      },
    });

    let userId: string;
    let wallet = existing?.wallet ?? null;
    let hasApiKeys = (existing?.apiKeys.length ?? 0) > 0;
    const chainId = this.configService.get<number>('chain.defaultChainId', 84532);

    if (!existing) {
      try {
        const result = await this.prisma.$transaction(async (tx) => {
          const newUser = await tx.user.create({
            data: { socialProvider, socialId, email: primaryEmail },
          });
          const newWallet = await tx.userWallet.create({
            data: {
              userId: newUser.id,
              chainId: BigInt(chainId),
              status: 'pending_embedded_wallet',
            },
          });
          return { userId: newUser.id, wallet: newWallet };
        });

        userId = result.userId;
        wallet = result.wallet;
        hasApiKeys = false;
        this.logger.log(
          this.logContext({ message: 'Created social login user', userId, socialProvider }),
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
          return this.handleSocialLogin(clerkUserId, _depth + 1);
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
            chainId: BigInt(chainId),
            status: 'pending_embedded_wallet',
          },
        });
      } catch (dbErr: any) {
        if (dbErr?.code === 'P2002') {
          wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
        }
        if (!wallet) throw dbErr;
      }
      this.logger.log(this.logContext({ message: 'Created pending wallet for existing user', userId }));
    } else {
      // 3c. Returning user with wallet — nothing to provision
      userId = existing.id;
    }

    // 4. Generate API key if user has none
    let rawApiKey: string | undefined;
    if (!hasApiKeys) {
      const result = await this.apiKeyService.createApiKey(userId, { name: 'Default' });
      rawApiKey = result.rawKey;
    }

    return {
      userId,
      wallet: this.toWalletResponse(wallet),
      ...(rawApiKey && { apiKey: rawApiKey }),
    };
  }

  async authorizeEmbeddedWallet(clerkUserId: string, dto: AuthorizeEmbeddedWalletDto) {
    const user = await this.prisma.user.findUnique({
      where: { socialId: clerkUserId },
      include: { wallet: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const authorized = await this.openfort.authorizeEmbeddedAddress(
      dto.openfortAccessToken,
      dto.embeddedWalletAddress,
    );
    const chainId = dto.chainId ?? this.configService.get<number>('chain.defaultChainId', 84532);
    const agent = await this.ensureAgentWallet(user.wallet);
    const expiresAt = this.agentExpiration();
    const wallet = await this.prisma.userWallet.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        openfortAccountId: dto.embeddedOpenfortAccountId ?? authorized.accountId,
        walletAddress: authorized.address,
        chainId: BigInt(chainId),
        status: 'active',
        agentOpenfortAccountId: agent.id,
        agentWalletAddress: agent.address,
        agentKeyHash: agent.keyHash,
        agentStatus: 'pending_registration',
        agentExpiresAt: expiresAt,
      },
      update: {
        openfortAccountId: dto.embeddedOpenfortAccountId ?? authorized.accountId,
        walletAddress: authorized.address,
        chainId: BigInt(chainId),
        status: 'active',
        agentOpenfortAccountId: agent.id,
        agentWalletAddress: agent.address,
        agentKeyHash: agent.keyHash,
        agentStatus: 'pending_registration',
        agentExpiresAt: expiresAt,
      },
    });

    return {
      userId: user.id,
      wallet: this.toWalletResponse(wallet),
      agentRegistration: {
        agentAddress: agent.address,
        keyHash: agent.keyHash,
        expiresAt: expiresAt.toISOString(),
      },
    };
  }

  private logContext(extra: Record<string, unknown>) {
    return this.requestContext?.getLogContext(extra) ?? extra;
  }

  /**
   * Return the current user's wallet info from DB (no Openfort calls).
   */
  async getMe(clerkUserId: string): Promise<{
    userId: string;
    wallet: WalletResponse;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { socialId: clerkUserId },
      include: { wallet: true },
    });

    if (!user || !user.wallet) throw new NotFoundException('User or wallet not found');

    return {
      userId: user.id,
      wallet: this.toWalletResponse(user.wallet),
    };
  }

  /**
   * Revoke all existing keys and issue a fresh one.
   */
  async refreshApiKey(clerkUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { socialId: clerkUserId },
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

  private agentExpiration(): Date {
    return new Date(Date.now() + 5 * 60 * 1000);
  }

  private toWalletResponse(wallet: UserWallet): WalletResponse {
    return {
      walletAddress: wallet.walletAddress,
      embeddedWalletAddress: wallet.walletAddress,
      chainId: Number(wallet.chainId),
      status: wallet.status,
      supportedTokens: ['USDC', 'ETH'],
      agentWalletAddress: wallet.agentWalletAddress,
      agentStatus: wallet.agentStatus,
      agentKeyHash: wallet.agentKeyHash,
      agentExpiresAt: wallet.agentExpiresAt?.toISOString() ?? null,
    };
  }
}
