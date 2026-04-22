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

  // ─── Policy management ────────────────────────────────────────────────────

  async listPolicies() {
    return await this.client.policies.list();
  }

  async createPolicy(params: {
    scope: string;
    description?: string;
    enabled?: boolean;
    priority?: number;
    rules?: any[];
  }) {
    return await this.client.policies.create({
      scope: params.scope as any,
      description: params.description,
      enabled: params.enabled,
      priority: params.priority,
      rules: (params.rules ?? []) as any,
    });
  }

  async getPolicy(id: string) {
    return await this.client.policies.get(id);
  }

  async updatePolicy(id: string, params: { description?: string; enabled?: boolean; priority?: number; rules?: any[] }) {
    return await this.client.policies.update(id, {
      description: params.description,
      enabled: params.enabled,
      priority: params.priority,
      ...(params.rules !== undefined && { rules: params.rules as any }),
    });
  }

  async deletePolicy(id: string) {
    return await this.client.policies.delete(id);
  }

  async enablePolicy(id: string) {
    return await this.client.policies.update(id, { enabled: true });
  }

  async disablePolicy(id: string) {
    return await this.client.policies.update(id, { enabled: false });
  }

  // ─── Policy rules management ──────────────────────────────────────────────

  async listPolicyRules(policyId: string): Promise<any> {
    const policy = await this.client.policies.get(policyId);
    return (policy as any).rules ?? [];
  }

  async createPolicyRule(
    policyId: string,
    params: {
      type: string;
      contract?: string;
      functionName?: string;
      wildcard?: boolean;
      gasLimit?: string;
      countLimit?: number;
      timeIntervalType?: string;
      timeIntervalValue?: number;
    },
  ): Promise<any> {
    const policy = await this.client.policies.get(policyId);
    const existingRules: any[] = (policy as any).rules ?? [];
    const newRule: any = {
      type: params.type,
      ...(params.contract && { contract: params.contract }),
      ...(params.functionName && { functionName: params.functionName }),
      ...(params.wildcard !== undefined && { wildcard: params.wildcard }),
      ...(params.gasLimit && { gasLimit: params.gasLimit }),
      ...(params.countLimit !== undefined && { countLimit: params.countLimit }),
      ...(params.timeIntervalType && { timeIntervalType: params.timeIntervalType }),
      ...(params.timeIntervalValue !== undefined && { timeIntervalValue: params.timeIntervalValue }),
    };
    return await this.client.policies.update(policyId, { rules: [...existingRules, newRule] as any });
  }

  async deletePolicyRule(policyId: string, ruleId: string): Promise<any> {
    const policy = await this.client.policies.get(policyId);
    const existingRules: any[] = (policy as any).rules ?? [];
    const filteredRules = existingRules.filter((r: any) => r.id !== ruleId);
    return await this.client.policies.update(policyId, { rules: filteredRules as any });
  }

  /** Send a raw transaction via a backend wallet (EIP-7702 auto-delegation). */
  async sendTransaction(params: {
    accountId: string;
    chainId: number;
    interactions: Array<{ to: string; data: string; value?: string }>;
    policyId?: string;
  }): Promise<{ transactionHash: string | null }> {
    try {
      const account = await this.client.accounts.evm.backend.get({ id: params.accountId });
      const result = await this.client.accounts.evm.backend.sendTransaction({
        account,
        chainId: params.chainId,
        interactions: params.interactions as any,
        ...(params.policyId && { policy: params.policyId }),
      });
      return { transactionHash: result.response?.transactionHash ?? null };
    } catch (error: any) {
      this.logger.error('sendTransaction failed: ' + (error.message ?? error), { stack: error.stack });
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
