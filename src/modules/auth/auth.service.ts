import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
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
  async handleSocialLogin(
    clerkUserId: string,
    _depth = 0,
  ): Promise<{
    userId: string;
    wallet: { walletAddress: string; chainId: number; status: string; supportedTokens: string[] };
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

    if (!existing) {
      try {
        const chainId = this.configService.get<number>('chain.defaultChainId', 84532);
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
        this.logger.log(`Created user ${userId} via ${socialProvider}`);
      } catch (err: any) {
        if (err?.code === 'P2002') {
          if (_depth >= 3) {
            throw new InternalServerErrorException('User creation conflict could not be resolved');
          }
          this.logger.warn(
            `Race condition on user creation for ${socialProvider}, retrying as existing user`,
          );
          return this.handleSocialLogin(clerkUserId, _depth + 1);
        }
        throw err;
      }
    } else if (!wallet) {
      // 3b. Existing user missing wallet — provision one
      userId = existing.id;
      const chainId = this.configService.get<number>('chain.defaultChainId', 84532);
      const account = await this.openfort.createBackendWallet();

      try {
        wallet = await this.prisma.userWallet.create({
          data: {
            userId,
            openfortAccountId: account.id,
            walletAddress: account.address,
            chainId: BigInt(chainId),
          },
        });
      } catch (dbErr: any) {
        // Openfort wallet created but DB write failed — log for manual recovery
        this.logger.error(
          `Orphaned Openfort wallet: accountId=${account.id} address=${account.address} userId=${userId}`,
          dbErr,
        );
        throw dbErr;
      }
      this.logger.log(`Provisioned wallet for existing user ${userId}`);
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
   * Return the current user's wallet info from DB (no Openfort calls).
   */
  async getMe(clerkUserId: string): Promise<{
    userId: string;
    wallet: { walletAddress: string; chainId: number; status: string; supportedTokens: string[] };
  }> {
    const user = await this.prisma.user.findUnique({
      where: { socialId: clerkUserId },
      include: { wallet: true },
    });

    if (!user || !user.wallet) throw new NotFoundException('User or wallet not found');

    return {
      userId: user.id,
      wallet: {
        walletAddress: user.wallet.walletAddress,
        chainId: Number(user.wallet.chainId),
        status: user.wallet.status,
        supportedTokens: ['USDC', 'ETH'],
      },
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
}
