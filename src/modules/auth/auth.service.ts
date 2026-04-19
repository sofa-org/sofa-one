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
   * Returns { userId, walletAddress, apiKey? }.
   * The apiKey field is only present on first login (one-time display).
   */
  async handleSocialLogin(clerkUserId: string) {
    // 1. Fetch Clerk user profile
    const clerkUser = await this.clerkClient.users.getUser(clerkUserId);
    const primaryEmail = clerkUser.emailAddresses?.[0]?.emailAddress;
    const socialAccount = clerkUser.externalAccounts?.[0];
    const socialProvider = socialAccount?.provider || 'unknown';
    const socialId = clerkUserId;

    // 2. Upsert platform user
    let user = await this.prisma.user.findUnique({
      where: { socialId },
      include: {
        wallet: true,
        apiKeys: { where: { revoked: false } },
      },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          socialProvider,
          socialId,
          email: primaryEmail,
        },
        include: {
          wallet: true,
          apiKeys: { where: { revoked: false } },
        },
      });
      this.logger.log(`Created user ${user.id} via ${socialProvider}`);
    }

    // 3. Provision Openfort backend wallet if absent
    let wallet = user.wallet;
    if (!wallet) {
      const chainId = this.configService.get<number>('chain.defaultChainId', 84532);
      const account = await this.openfort.createBackendWallet();

      wallet = await this.prisma.userWallet.create({
        data: {
          userId: user.id,
          openfortAccountId: account.id,
          walletAddress: account.address,
          chainId: BigInt(chainId),
        },
      });
      this.logger.log(`Created wallet ${wallet.walletAddress} for user ${user.id}`);
    }

    // 4. Generate API key if user has none
    let rawApiKey: string | undefined;
    if (user.apiKeys.length === 0) {
      const result = await this.apiKeyService.createApiKey(user.id, 'Default');
      rawApiKey = result.rawKey;
    }

    return {
      userId: user.id,
      walletAddress: wallet.walletAddress,
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
