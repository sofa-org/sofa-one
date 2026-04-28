import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Openfort from '@openfort/openfort-node';

@Injectable()
export class OpenfortService {
  private readonly client: Openfort;
  private readonly logger = new Logger(OpenfortService.name);
  private readonly timeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    this.client = new Openfort(this.configService.getOrThrow<string>('openfort.apiKey'), {
      walletSecret: this.configService.getOrThrow<string>('openfort.walletSecret'),
    });
    this.timeoutMs = this.configService.get<number>('openfort.timeoutMs', 15000);
  }

  /** Create a new TEE-secured backend wallet (EOA). */
  async createBackendWallet(): Promise<{ id: string; address: string }> {
    try {
      const account = await this.withTimeout(
        this.client.accounts.evm.backend.create(),
        'createBackendWallet',
      );
      return { id: account.id, address: account.address };
    } catch (error: any) {
      this.logger.error('createBackendWallet failed: ' + (error.message ?? error), {
        stack: error.stack,
      });
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
      return await this.withTimeout(
        this.client.transactionIntents.create({
          chainId: params.chainId,
          account: params.accountId,
          ...(params.policyId && { policy: params.policyId }),
          optimistic: params.optimistic ?? false,
          interactions: params.interactions,
        }),
        'createTransactionIntent',
      );
    } catch (error: any) {
      this.logger.error('createTransactionIntent failed: ' + (error.message ?? error), {
        stack: error.stack,
      });
      throw new BadGatewayException('Wallet service temporarily unavailable');
    }
  }

  // ─── Policy management ────────────────────────────────────────────────────

  async listPolicies() {
    return await this.withTimeout(this.client.policies.list(), 'listPolicies');
  }

  async createPolicy(params: {
    scope: string;
    accountId?: string;
    description?: string;
    enabled?: boolean;
    rules?: Array<{ action: string; operation: string; criteria?: Record<string, unknown>[] }>;
  }) {
    return await this.withTimeout(
      this.client.policies.create({
        scope: params.scope as any,
        ...(params.accountId !== undefined && { accountId: params.accountId }),
        description: params.description,
        enabled: params.enabled,
        rules: (params.rules ?? []) as any,
      }),
      'createPolicy',
    );
  }

  async getPolicy(id: string) {
    return await this.withTimeout(this.client.policies.get(id), 'getPolicy');
  }

  async updatePolicy(
    id: string,
    params: {
      description?: string;
      enabled?: boolean;
      rules?: Array<{ action: string; operation: string; criteria?: Record<string, unknown>[] }>;
    },
  ) {
    return await this.withTimeout(
      this.client.policies.update(id, {
        description: params.description,
        enabled: params.enabled,
        ...(params.rules !== undefined && { rules: params.rules as any }),
      }),
      'updatePolicy',
    );
  }

  async deletePolicy(id: string) {
    return await this.withTimeout(this.client.policies.delete(id), 'deletePolicy');
  }

  async enablePolicy(id: string) {
    return await this.withTimeout(
      this.client.policies.update(id, { enabled: true }),
      'enablePolicy',
    );
  }

  async disablePolicy(id: string) {
    return await this.withTimeout(
      this.client.policies.update(id, { enabled: false }),
      'disablePolicy',
    );
  }

  // ─── Policy rules management ──────────────────────────────────────────────

  async listPolicyRules(policyId: string): Promise<any> {
    const policy = await this.withTimeout(this.client.policies.get(policyId), 'listPolicyRules');
    return (policy as any).rules ?? [];
  }

  async createPolicyRule(
    policyId: string,
    rule: { action: string; operation: string; criteria?: Record<string, unknown>[] },
  ): Promise<any> {
    const policy = await this.withTimeout(
      this.client.policies.get(policyId),
      'getPolicyForRuleCreate',
    );
    const existingRules: any[] = (policy as any).rules ?? [];
    return await this.withTimeout(
      this.client.policies.update(policyId, {
        rules: [...existingRules, rule] as any,
      }),
      'createPolicyRule',
    );
  }

  async deletePolicyRule(policyId: string, ruleIndex: number): Promise<any> {
    const policy = await this.withTimeout(
      this.client.policies.get(policyId),
      'getPolicyForRuleDelete',
    );
    const existingRules: any[] = (policy as any).rules ?? [];
    const filteredRules = existingRules.filter((_: any, i: number) => i !== ruleIndex);
    return await this.withTimeout(
      this.client.policies.update(policyId, { rules: filteredRules as any }),
      'deletePolicyRule',
    );
  }

  /** Send a raw transaction via a backend wallet (EIP-7702 auto-delegation). */
  async sendTransaction(params: {
    accountId: string;
    chainId: number;
    interactions: Array<{ to: string; data: string; value?: string }>;
    policyId?: string;
  }): Promise<{ intentId: string | null; transactionHash: string | null }> {
    try {
      const account = await this.withTimeout(
        this.client.accounts.evm.backend.get({ id: params.accountId }),
        'getBackendWallet',
      );
      const result = await this.withTimeout(
        this.client.accounts.evm.backend.sendTransaction({
          account,
          chainId: params.chainId,
          interactions: params.interactions as any,
          ...(params.policyId && { policy: params.policyId }),
        }),
        'sendTransaction',
      );
      const rawResult = result as any;
      return {
        intentId: rawResult.id ?? rawResult.intentId ?? rawResult.response?.id ?? null,
        transactionHash: rawResult.response?.transactionHash ?? rawResult.transactionHash ?? null,
      };
    } catch (error: any) {
      this.logger.error('sendTransaction failed: ' + (error.message ?? error), {
        stack: error.stack,
      });
      throw new BadGatewayException('Wallet service temporarily unavailable');
    }
  }

  /** Retrieve a transaction intent for status reconciliation. */
  async getTransactionIntent(intentId: string): Promise<any> {
    try {
      return await this.withTimeout(
        this.client.transactionIntents.get(intentId),
        'getTransactionIntent',
      );
    } catch (error: any) {
      this.logger.error('getTransactionIntent failed: ' + (error.message ?? error), {
        stack: error.stack,
      });
      throw new BadGatewayException('Wallet service temporarily unavailable');
    }
  }

  /** Sign hex-encoded data with a backend wallet (no transaction broadcast). */
  async signData(accountId: string, data: string): Promise<string> {
    try {
      return await this.withTimeout(
        this.client.accounts.evm.backend.sign({ id: accountId, data }),
        'signData',
      );
    } catch (error: any) {
      this.logger.error('signData failed: ' + (error.message ?? error), { stack: error.stack });
      throw new BadGatewayException('Wallet service temporarily unavailable');
    }
  }

  private async withTimeout<T>(operation: Promise<T>, operationName: string): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`${operationName} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([operation, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
