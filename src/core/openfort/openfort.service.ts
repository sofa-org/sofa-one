import {
  BadGatewayException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Openfort from '@openfort/openfort-node';
import { createClient, getAddress, http, padHex, type Address, type Hex } from 'viem';
import { createBundlerClient, createPaymasterClient } from 'viem/account-abstraction';
import { toAccount } from 'viem/accounts';
import { RequestContextService } from '../../common/request-context/request-context.service';
import { getSupportedChain } from '../../common/chains/supported-chains';
import {
  createCaliburSessionAccount,
  getAgentKeyUsabilityFailure,
  getCaliburKeySettings,
  hashKey,
  isCaliburKeyRegistered,
  KeyType,
} from '../../common/calibur/calibur';

@Injectable()
export class OpenfortService {
  private readonly client: Openfort;
  private readonly logger = new Logger(OpenfortService.name);
  private readonly timeoutMs: number;

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly requestContext?: RequestContextService,
  ) {
    this.client = new Openfort(this.configService.getOrThrow<string>('openfort.apiKey'), {
      walletSecret: this.configService.getOrThrow<string>('openfort.walletSecret'),
      ...(this.configService.get<string>('openfort.publishableKey') && {
        publishableKey: this.configService.get<string>('openfort.publishableKey'),
      }),
    } as any);
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
      this.logOpenfortError('createBackendWallet', error);
      throw new BadGatewayException('Wallet service temporarily unavailable');
    }
  }

  /** Create a backend agent wallet that will act as a Calibur session key. */
  async createAgentWallet(): Promise<{ id: string; address: string; keyHash: Hex }> {
    const account = await this.createBackendWallet();
    return {
      ...account,
      keyHash: this.computeSecp256k1KeyHash(account.address),
    };
  }

  async verifyIamSession(accessToken: string): Promise<{
    openfortUserId: string;
    email?: string;
    session: unknown;
  }> {
    try {
      const session = (await this.withTimeout(
        (this.client as any).iam.getSession({ accessToken }),
        'getOpenfortIamSession',
      )) as any;
      const openfortUserId = session?.user?.id ?? session?.id;
      if (!openfortUserId) throw new ForbiddenException('Invalid Openfort session');

      const email =
        session?.user?.email ??
        session?.user?.emailAddress ??
        session?.email ??
        session?.emailAddress ??
        undefined;

      return { openfortUserId, email, session };
    } catch (error: any) {
      if (error instanceof ForbiddenException) throw error;
      this.logOpenfortError('verifyIamSession', error);
      throw new BadGatewayException('Wallet service temporarily unavailable');
    }
  }

  async authorizeEmbeddedAddress(
    accessToken: string,
    walletAddress: string,
  ): Promise<{ openfortUserId: string; accountId?: string; address: Address }> {
    try {
      const { openfortUserId } = await this.verifyIamSession(accessToken);

      const normalizedAddress = getAddress(walletAddress);
      const accountsResult = (await this.withTimeout(
        (this.client as any).accounts.list({ user: openfortUserId }),
        'listOpenfortUserAccounts',
      )) as { data?: Array<{ id?: string; address?: string }> } | Array<{ id?: string; address?: string }>;
      const accounts = Array.isArray(accountsResult) ? accountsResult : (accountsResult.data ?? []);
      const account = accounts.find((candidate) => {
        if (!candidate.address) return false;
        try {
          return getAddress(candidate.address) === normalizedAddress;
        } catch {
          return false;
        }
      });

      if (!account) throw new ForbiddenException('Embedded wallet is not owned by Openfort user');
      return { openfortUserId, accountId: account.id, address: normalizedAddress };
    } catch (error: any) {
      if (error instanceof ForbiddenException) throw error;
      this.logOpenfortError('authorizeEmbeddedAddress', error);
      throw new BadGatewayException('Wallet service temporarily unavailable');
    }
  }

  computeSecp256k1KeyHash(agentAddress: string): Hex {
    return hashKey({
      keyType: KeyType.Secp256k1,
      publicKey: padHex(getAddress(agentAddress), { size: 32 }),
    });
  }

  async verifyAgentKeyRegistration(params: {
    accountAddress: string;
    chainId: number;
    keyHash: string;
  }): Promise<void> {
    try {
      const { chain } = getSupportedChain(params.chainId);
      const client = createClient({ chain, transport: http() });
      const accountAddress = getAddress(params.accountAddress);
      const keyHash = params.keyHash as Hex;

      const registered = await isCaliburKeyRegistered(client, accountAddress, keyHash);
      if (!registered) {
        throw new ForbiddenException('Agent key is not registered on Calibur account');
      }

      const settings = await getCaliburKeySettings(client, accountAddress, keyHash);
      const failure = getAgentKeyUsabilityFailure(settings);
      if (failure) throw new ForbiddenException(failure);
    } catch (error: any) {
      if (error instanceof ForbiddenException) throw error;
      this.logOpenfortError('verifyAgentKeyRegistration', error, {
        chainId: params.chainId,
      });
      throw new BadGatewayException('Wallet service temporarily unavailable');
    }
  }

  /** Execute calls from the user's Calibur account with the registered backend agent key. */
  async sendUserOperation(params: {
    agentAccountId: string;
    accountAddress: string;
    chainId: number;
    keyHash: string;
    interactions: Array<{ to: string; data: string; value?: string }>;
  }): Promise<{ userOpHash: string; transactionHash: string | null }> {
    const publishableKey = this.configService.get<string>('openfort.publishableKey');
    if (!publishableKey) {
      throw new ServiceUnavailableException('Openfort publishable key is required for UserOps');
    }

    try {
      const { chain } = getSupportedChain(params.chainId);
      const backendAccount = (await this.withTimeout(
        this.client.accounts.evm.backend.get({ id: params.agentAccountId }),
        'getAgentWallet',
      )) as any;
      const signer = toAccount({
        address: getAddress(backendAccount.address),
        sign: ({ hash }: { hash: Hex }) => backendAccount.sign({ hash }),
        signMessage: (args) => backendAccount.signMessage(args),
        signTransaction: (args) => backendAccount.signTransaction(args),
        signTypedData: (typedData) => backendAccount.signTypedData(typedData),
      });
      const client = createClient({ chain, transport: http() });
      const sessionAccount = await createCaliburSessionAccount({
        client,
        signer,
        accountAddress: getAddress(params.accountAddress),
        keyHash: params.keyHash as Hex,
      });
      const openfortRpcTransport = http(`https://api.openfort.io/rpc/${params.chainId}`, {
        fetchOptions: {
          headers: { Authorization: `Bearer ${publishableKey}` },
        },
      });
      const paymaster = createPaymasterClient({ transport: openfortRpcTransport });
      const bundlerClient = createBundlerClient({
        account: sessionAccount,
        chain,
        client,
        paymaster,
        transport: openfortRpcTransport,
      } as any);
      const hash = await bundlerClient.sendUserOperation({
        account: sessionAccount,
        calls: params.interactions.map((interaction) => ({
          to: getAddress(interaction.to),
          data: interaction.data as Hex,
          value: interaction.value ? BigInt(interaction.value) : 0n,
        })),
      } as any);
      const receipt = (await bundlerClient.waitForUserOperationReceipt({ hash })) as any;
      return {
        userOpHash: hash,
        transactionHash: receipt.receipt?.transactionHash ?? receipt.transactionHash ?? null,
      };
    } catch (error: any) {
      this.logOpenfortError('sendUserOperation', error, {
        chainId: params.chainId,
        interactionCount: params.interactions.length,
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
      this.logOpenfortError('signData', error);
      throw new BadGatewayException('Wallet service temporarily unavailable');
    }
  }

  private logOpenfortError(
    operation: string,
    error: any,
    extra: Record<string, unknown> = {},
  ): void {
    this.logger.error(
      this.logContext({
        message: 'Openfort operation failed',
        operation,
        error: error?.message ?? String(error),
        ...extra,
      }),
      error?.stack,
    );
  }

  private logContext(extra: Record<string, unknown>) {
    return this.requestContext?.getLogContext(extra) ?? extra;
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
