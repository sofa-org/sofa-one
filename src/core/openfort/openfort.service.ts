import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Openfort, {
  type SponsorSchema,
  type PolicyRuleType,
} from '@openfort/openfort-node';

@Injectable()
export class OpenfortService {
  private readonly client: Openfort;

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
      throw new BadGatewayException(`Openfort error: ${error.message}`);
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
      throw new BadGatewayException(`Openfort error: ${error.message}`);
    }
  }

  /** Look up status of an existing transaction intent. */
  async getTransactionIntent(intentId: string) {
    try {
      return await this.client.transactionIntents.get(intentId);
    } catch (error: any) {
      throw new BadGatewayException(`Openfort error: ${error.message}`);
    }
  }

  /** Register a smart-contract address with Openfort. */
  async createContract(params: { name: string; chainId: number; address: string }) {
    try {
      return await this.client.contracts.create(params);
    } catch (error: any) {
      throw new BadGatewayException(`Openfort error: ${error.message}`);
    }
  }

  /** Create a gas-sponsorship / charge_custom_tokens policy. */
  async createPolicy(params: {
    name: string;
    chainId: number;
    strategy: {
      sponsorSchema: SponsorSchema;
      tokenContract: string;
      tokenContractAmount: string;
    };
  }) {
    try {
      return await this.client.policies.create(params);
    } catch (error: any) {
      throw new BadGatewayException(`Openfort error: ${error.message}`);
    }
  }

  /** Attach an allowed-function rule to a policy. */
  async createPolicyRule(params: {
    policy: string;
    type: PolicyRuleType;
    contract: string;
    functionName: string;
  }) {
    try {
      return await this.client.policyRules.create(params);
    } catch (error: any) {
      throw new BadGatewayException(`Openfort error: ${error.message}`);
    }
  }
}
