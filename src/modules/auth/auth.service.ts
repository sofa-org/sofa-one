import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClerkClient } from '@clerk/backend';
import type { UserWallet } from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { OpenfortService } from '../../core/openfort/openfort.service';
import { RequestContextService } from '../../common/request-context/request-context.service';
import { ApiKeyService } from '../api-key/api-key.service';

type ActiveUserWallet = UserWallet & {
  openfortAccountId: string;
  walletAddress: string;
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
              status: 'provisioning',
            },
          });
          return { userId: newUser.id, wallet: newWallet };
        });

        userId = result.userId;
        wallet = await this.provisionWallet(result.wallet.id, userId);
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
      // 3b. Existing user missing wallet — provision one
      userId = existing.id;

      try {
        wallet = await this.prisma.userWallet.create({
          data: {
            userId,
            chainId: BigInt(chainId),
            status: 'provisioning',
          },
        });
      } catch (dbErr: any) {
        if (dbErr?.code === 'P2002') {
          wallet = await this.prisma.userWallet.findUnique({ where: { userId } });
        }
        if (!wallet) throw dbErr;
      }
      wallet = await this.provisionWallet(wallet.id, userId);
      this.logger.log(this.logContext({ message: 'Provisioned wallet for existing user', userId }));
    } else {
      // 3c. Returning user with wallet — nothing to provision
      userId = existing.id;
    }

    const activeWallet = await this.ensureActiveWallet(wallet, userId);

    // 4. Generate API key if user has none
    let rawApiKey: string | undefined;
    if (!hasApiKeys) {
      const result = await this.apiKeyService.createApiKey(userId, { name: 'Default' });
      rawApiKey = result.rawKey;
    }

    return {
      userId,
      wallet: {
        walletAddress: activeWallet.walletAddress,
        chainId: Number(activeWallet.chainId),
        status: activeWallet.status,
        supportedTokens: ['USDC', 'ETH'],
      },
      ...(rawApiKey && { apiKey: rawApiKey }),
    };
  }

  private async ensureActiveWallet(
    wallet: UserWallet | null,
    userId: string,
  ): Promise<ActiveUserWallet> {
    if (!wallet) throw new NotFoundException('Wallet not found');

    if (wallet.status === 'active' && wallet.walletAddress && wallet.openfortAccountId) {
      return wallet as ActiveUserWallet;
    }

    if (wallet.status === 'provisioning_failed') {
      return this.provisionWallet(wallet.id, userId);
    }

    throw new ServiceUnavailableException(`Wallet is not ready (status: ${wallet.status})`);
  }

  private async provisionWallet(walletId: string, userId: string): Promise<ActiveUserWallet> {
    try {
      const account = await this.openfort.createBackendWallet();
      const wallet = await this.prisma.userWallet.update({
        where: { id: walletId },
        data: {
          openfortAccountId: account.id,
          walletAddress: account.address,
          status: 'active',
        },
      });
      if (!wallet.walletAddress || !wallet.openfortAccountId) {
        throw new InternalServerErrorException('Provisioned wallet is missing identifiers');
      }
      this.logger.log(
        this.logContext({ message: 'Wallet provisioning completed', walletId, userId }),
      );
      return wallet as ActiveUserWallet;
    } catch (err) {
      await this.markWalletProvisioningFailed(walletId, userId, err);
      throw err;
    }
  }

  private async markWalletProvisioningFailed(walletId: string, userId: string, err: unknown) {
    try {
      await this.prisma.userWallet.update({
        where: { id: walletId },
        data: { status: 'provisioning_failed' },
      });
    } catch (updateErr) {
      this.logger.error(
        this.logContext({
          message: 'Failed to mark wallet provisioning as failed',
          walletId,
          userId,
        }),
        updateErr instanceof Error ? updateErr.stack : updateErr,
      );
    }

    this.logger.error(
      this.logContext({ message: 'Wallet provisioning failed', walletId, userId }),
      err instanceof Error ? err.stack : err,
    );
  }

  private logContext(extra: Record<string, unknown>) {
    return this.requestContext?.getLogContext(extra) ?? extra;
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
    if (user.wallet.status !== 'active' || !user.wallet.walletAddress) {
      throw new ServiceUnavailableException(`Wallet is not ready (status: ${user.wallet.status})`);
    }

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
