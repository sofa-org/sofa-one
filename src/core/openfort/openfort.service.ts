import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Openfort from '@openfort/openfort-node';

@Injectable()
export class OpenfortService {
  private readonly client: Openfort;
  private readonly logger = new Logger(OpenfortService.name);

  constructor(private readonly configService: ConfigService) {
    this.client = new Openfort(this.configService.getOrThrow<string>('openfort.apiKey'), {
      walletSecret: this.configService.getOrThrow<string>('openfort.walletSecret'),
    });
  }

  /** Create a new TEE-secured backend wallet (EOA). */
  async createBackendWallet(): Promise<{ id: string; address: string }> {
    try {
      const account = await this.client.accounts.evm.backend.create();
      return { id: account.id, address: account.address };
    } catch (error: any) {
      this.logger.error('createBackendWallet failed: ' + (error.message ?? error), { stack: error.stack });
      throw new BadGatewayException('Wallet service temporarily unavailable');
    }
  }

  /** Submit a transaction intent via Openfort bundler + paymaster. */
  async createTransactionIntent(params: {
    chainId: number;
    accountId: string;
    policyId?: string;
    interactions: Array<{
      contract: string;
      functionName: string;
      functionArgs?: string[];
    }>;
    optimistic?: boolean;
  }) {
    try {
      return await this.client.transactionIntents.create({
        chainId: params.chainId,
        account: params.accountId,
        ...(params.policyId && { policy: params.policyId }),
        optimistic: params.optimistic ?? false,
        interactions: params.interactions,
      });
    } catch (error: any) {
      this.logger.error('createTransactionIntent failed: ' + (error.message ?? error), { stack: error.stack });
      throw new BadGatewayException('Wallet service temporarily unavailable');
    }
  }

  /** Sign hex-encoded data with a backend wallet (no transaction broadcast). */
  async signData(accountId: string, data: string): Promise<string> {
    try {
      return await this.client.accounts.evm.backend.sign({ id: accountId, data });
    } catch (error: any) {
      this.logger.error('signData failed: ' + (error.message ?? error), { stack: error.stack });
      throw new BadGatewayException('Wallet service temporarily unavailable');
    }
  }
}
