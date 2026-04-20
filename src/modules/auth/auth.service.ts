import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClerkClient } from '@clerk/backend';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import { ApiKeyService } from '../api-key/api-key.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly clerkClient;

  constructor(
    private readonly prisma: PrismaService,
    private readonly openfort: OpenfortService,
    private readonly apiKeyService: ApiKeyService,
    private readonly configService: ConfigService,
  ) {
    this.clerkClient = createClerkClient({
      secretKey: this.configService.getOrThrow<string>('clerk.secretKey'),
    });
  }

  /**
   * Handle social login: upsert user, provision wallet, generate API key.
   * Returns { userId, wallet: { walletAddress, chainId, status, supportedTokens }, apiKey? }.
   * The apiKey field is only present on first login (one-time display).
   */
  async handleSocialLogin(clerkUserId: string) {
    // 1. Fetch Clerk user profile
    const clerkUser = await this.clerkClient.users.getUser(clerkUserId);
    const primaryEmail = clerkUser.emailAddresses?.[0]?.emailAddress;
    const socialProvider =
      clerkUser.externalAccounts?.[0]?.provider || 'unknown';
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

    if (!existing) {
      // 3a. New user — call Openfort first, then atomically create user + wallet
      const chainId = this.configService.get<number>(
        'chain.defaultChainId',
        84532,
      );
      const account = await this.openfort.createBackendWallet();

      const result = await this.prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: { socialProvider, socialId, email: primaryEmail },
        });
        const newWallet = await tx.userWallet.create({
          data: {
            userId: newUser.id,
            openfortAccountId: account.id,
            walletAddress: account.address,
            chainId: BigInt(chainId),
          },
        });
        return { userId: newUser.id, wallet: newWallet };
      });

      userId = result.userId;
      wallet = result.wallet;
      hasApiKeys = false;
      this.logger.log(
        `Created user ${userId} via ${socialProvider} with wallet ${wallet.walletAddress}`,
      );
    } else if (!wallet) {
      // 3b. Existing user missing wallet — provision one
      userId = existing.id;
      const chainId = this.configService.get<number>(
        'chain.defaultChainId',
        84532,
      );
      const account = await this.openfort.createBackendWallet();

      wallet = await this.prisma.userWallet.create({
        data: {
          userId,
          openfortAccountId: account.id,
          walletAddress: account.address,
          chainId: BigInt(chainId),
        },
      });
      this.logger.log(
        `Created wallet ${wallet.walletAddress} for existing user ${userId}`,
      );
    } else {
      // 3c. Returning user with wallet — nothing to provision
      userId = existing.id;
    }

    // 4. Generate API key if user has none
    let rawApiKey: string | undefined;
    if (!hasApiKeys) {
      const result = await this.apiKeyService.createApiKey(userId, 'Default');
      rawApiKey = result.rawKey;
    }

    return {
      userId,
      wallet: {
        walletAddress: wallet!.walletAddress,
        chainId: Number(wallet!.chainId),
        status: wallet!.status,
        supportedTokens: ['USDC', 'ETH'],
      },
      ...(rawApiKey && { apiKey: rawApiKey }),
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

    await this.apiKeyService.revokeAllKeys(user.id);
    const result = await this.apiKeyService.createApiKey(user.id, 'Refreshed');

    return { apiKey: result.rawKey };
  }
}
