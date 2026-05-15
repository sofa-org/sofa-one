import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Openfort from '@openfort/openfort-node';
import { createClient, getAddress, http, padHex, type Address, type Hex } from 'viem';
import { createBundlerClient, createPaymasterClient } from 'viem/account-abstraction';
import { estimateFeesPerGas, getTransactionReceipt } from 'viem/actions';
import { toAccount } from 'viem/accounts';
import { RequestContextService } from '../../common/request-context/request-context.service';
import { getSupportedChain } from '../../common/chains/supported-chains';
import { API_ERROR_CODES } from '../../common/errors/api-error-codes';
import {
  createCaliburSessionAccount,
  getAgentKeyUsabilityFailure,
  getCaliburKeySettings,
  hasCaliburDelegation,
  hashKey,
  isCaliburKeyRegistered,
  KeyType,
} from '../../common/calibur/calibur';

const POLYGON_MAINNET_CHAIN_ID = 137;
const POLYGON_GAS_STATION_URL = 'https://gasstation.polygon.technology/v2';

interface PolygonGasStationResponse {
  fast?: {
    maxFee?: number | string;
    maxPriorityFee?: number | string;
  };
}

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

  /** Create a backend agent signer that will act as a Calibur session key. */
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
      )) as
        | { data?: Array<{ id?: string; address?: string }> }
        | Array<{ id?: string; address?: string }>;
      const accounts = Array.isArray(accountsResult) ? accountsResult : (accountsResult.data ?? []);
      const account = accounts.find((candidate) => {
        if (!candidate.address) return false;
        try {
          return getAddress(candidate.address) === normalizedAddress;
        } catch {
          return false;
        }
      });

      if (!account) throw new ForbiddenException('Embedded EOA is not owned by Openfort user');
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

      const delegatedToCalibur = await hasCaliburDelegation(client, accountAddress);
      if (!delegatedToCalibur) {
        throw new ConflictException({
          code: API_ERROR_CODES.AGENT_REGISTRATION_PENDING,
          message: 'Agent registration is still pending on-chain',
        });
      }

      const registered = await isCaliburKeyRegistered(client, accountAddress, keyHash);
      if (!registered) {
        throw new ForbiddenException('Agent key is not registered on Calibur account');
      }

      const settings = await getCaliburKeySettings(client, accountAddress, keyHash);
      const failure = getAgentKeyUsabilityFailure(settings);
      if (failure) throw new ForbiddenException(failure);
    } catch (error: any) {
      if (error instanceof ConflictException || error instanceof ForbiddenException) throw error;
      this.logOpenfortError('verifyAgentKeyRegistration', error, {
        chainId: params.chainId,
      });
      throw new BadGatewayException('Wallet service temporarily unavailable');
    }
  }

  async getTransactionReceiptStatus(
    chainId: number,
    txHash: string,
  ): Promise<'success' | 'reverted' | null> {
    try {
      const { chain } = getSupportedChain(chainId);
      const client = createClient({ chain, transport: http() });
      const receipt = await getTransactionReceipt(client, { hash: txHash as Hex });
      return receipt.status ?? null;
    } catch (error: any) {
      const message = String(error?.message ?? '');
      if (message.includes('Transaction receipt not found') || message.includes('not found')) {
        return null;
      }
      this.logOpenfortError('getTransactionReceiptStatus', error, { chainId, txHash });
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
    sponsorship?: 'required' | 'none';
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
      const sponsorshipMode = params.sponsorship ?? 'none';
      const openfortRpcUrl = `https://api.openfort.io/rpc/${params.chainId}`;
      const gasPrice = await this.estimateUserOperationFees(client);
      const openfortRpcTransport = http(openfortRpcUrl, {
        fetchOptions: {
          headers: { Authorization: `Bearer ${publishableKey}` },
        },
      });
      const submission = await this.sendUserOperationWithSponsorship({
        account: sessionAccount,
        chain,
        client,
        transport: openfortRpcTransport,
        interactions: params.interactions,
        sponsorshipMode,
        chainId: params.chainId,
        gasPrice,
      });
      const receipt = (await submission.bundlerClient.waitForUserOperationReceipt({
        hash: submission.hash as Hex,
      })) as any;
      return {
        userOpHash: submission.hash,
        transactionHash: receipt.receipt?.transactionHash ?? receipt.transactionHash ?? null,
      };
    } catch (error: any) {
      if (params.sponsorship === 'required' && this.isMissingPaymasterPolicyError(error)) {
        throw this.createPaymasterPolicyException(params.chainId);
      }
      this.logOpenfortError('sendUserOperation', error, {
        chainId: params.chainId,
        interactionCount: params.interactions.length,
      });
      throw this.createOpenfortApiException('sendUserOperation', error);
    }
  }

  private createBundlerClient(params: {
    account: any;
    chain: any;
    client: any;
    transport: any;
    includePaymaster: boolean;
  }) {
    return createBundlerClient({
      account: params.account,
      chain: params.chain,
      client: params.client,
      ...(params.includePaymaster
        ? { paymaster: createPaymasterClient({ transport: params.transport }) }
        : {}),
      transport: params.transport,
    } as any);
  }

  private async sendUserOperationWithSponsorship(params: {
    account: any;
    chain: any;
    client: any;
    transport: any;
    interactions: Array<{ to: string; data: string; value?: string }>;
    sponsorshipMode: 'required' | 'none';
    chainId: number;
    gasPrice: UserOperationGasPrice;
  }): Promise<{ hash: string; bundlerClient: any }> {
    const calls = params.interactions.map((interaction) => ({
      to: getAddress(interaction.to),
      data: interaction.data as Hex,
      value: interaction.value ? BigInt(interaction.value) : 0n,
    }));
    if (params.sponsorshipMode === 'none') {
      const bundlerClient = this.createBundlerClient({ ...params, includePaymaster: false });
      return {
        hash: await bundlerClient.sendUserOperation({
          account: params.account,
          calls,
          maxFeePerGas: params.gasPrice.maxFeePerGas,
          maxPriorityFeePerGas: params.gasPrice.maxPriorityFeePerGas,
        } as any),
        bundlerClient,
      };
    }

    try {
      const bundlerClient = this.createBundlerClient({ ...params, includePaymaster: true });
      return {
        hash: await bundlerClient.sendUserOperation({
          account: params.account,
          calls,
          maxFeePerGas: params.gasPrice.maxFeePerGas,
          maxPriorityFeePerGas: params.gasPrice.maxPriorityFeePerGas,
        } as any),
        bundlerClient,
      };
    } catch (error: any) {
      throw error;
    }
  }

  private async estimateUserOperationFees(client: any): Promise<UserOperationGasPrice> {
    if (client.chain?.id === POLYGON_MAINNET_CHAIN_ID) {
      return this.estimatePolygonUserOperationFees();
    }

    const fees = (await this.withTimeout(
      estimateFeesPerGas(client, { chain: client.chain, type: 'eip1559' }),
      'estimateUserOperationFees',
    )) as { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint };

    if (!fees.maxFeePerGas || !fees.maxPriorityFeePerGas) {
      throw new Error('Unable to estimate UserOperation fee parameters from chain RPC');
    }

    return {
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
  }

  private async estimatePolygonUserOperationFees(): Promise<UserOperationGasPrice> {
    const response = (await this.withTimeout(
      fetch(POLYGON_GAS_STATION_URL),
      'estimatePolygonUserOperationFees',
    )) as Response;

    if (!response.ok) {
      throw new Error('Unable to estimate UserOperation fee parameters from Polygon Gas Station');
    }

    const gasStation = (await response.json()) as PolygonGasStationResponse;
    const maxFeePerGas = this.gweiToWei(gasStation.fast?.maxFee);
    const maxPriorityFeePerGas = this.gweiToWei(gasStation.fast?.maxPriorityFee);

    if (!maxFeePerGas || !maxPriorityFeePerGas) {
      throw new Error('Unable to estimate UserOperation fee parameters from Polygon Gas Station');
    }

    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  private gweiToWei(value?: number | string): bigint | null {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    if (!/^\d+(\.\d+)?$/.test(text)) return null;

    const [whole, fractional = ''] = text.split('.');
    const fractionalWei = fractional.slice(0, 9).padEnd(9, '0');
    return BigInt(whole) * 1_000_000_000n + BigInt(fractionalWei);
  }

  private isMissingPaymasterPolicyError(error: any): boolean {
    const text =
      `${error?.message ?? ''} ${error?.details ?? ''} ${error?.cause?.message ?? ''}`.toLowerCase();
    return (
      text.includes('no matching project-scoped policy found') || text.includes('paymaster policy')
    );
  }

  private createPaymasterPolicyException(chainId: number) {
    return new HttpException(
      {
        code: API_ERROR_CODES.PAYMASTER_POLICY_NOT_CONFIGURED,
        message: `No gas sponsorship policy is configured for chainId ${chainId}.`,
      },
      HttpStatus.FAILED_DEPENDENCY,
    );
  }

  /** Execute calls directly from a backend EOA through Openfort. */
  async sendBackendTransaction(params: {
    accountId: string;
    chainId: number;
    interactions: Array<{ to: string; data: string; value?: string }>;
  }): Promise<{ transactionHash: string | null }> {
    try {
      const account = await this.withTimeout(
        this.client.accounts.evm.backend.get({ id: params.accountId }),
        'getBackendWallet',
      );
      const result = (await this.withTimeout(
        (this.client.accounts.evm.backend as any).sendTransaction({
          account,
          chainId: params.chainId,
          interactions: params.interactions,
        }),
        'sendBackendTransaction',
      )) as any;

      return {
        transactionHash:
          result?.response?.transactionHash ?? result?.transactionHash ?? result?.hash ?? null,
      };
    } catch (error: any) {
      this.logOpenfortError('sendBackendTransaction', error, {
        chainId: params.chainId,
        interactionCount: params.interactions.length,
      });
      throw this.createOpenfortApiException('sendBackendTransaction', error);
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

  private createOpenfortApiException(operation: string, error: any): HttpException {
    if (this.isTimeoutError(error)) {
      return new HttpException(
        {
          code: API_ERROR_CODES.WALLET_SERVICE_UNAVAILABLE,
          message: 'Wallet service unavailable: Openfort request timed out.',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }

    if (operation === 'sendUserOperation') {
      return this.createUserOperationException(error);
    }

    if (operation === 'sendBackendTransaction') {
      return new HttpException(
        {
          code: API_ERROR_CODES.BACKEND_TRANSACTION_FAILED,
          message: this.withSafeReason(
            'Backend EOA transaction failed. Check chainId, target contract calldata, value, and wallet balance.',
            error,
          ),
        },
        HttpStatus.BAD_GATEWAY,
      );
    }

    return new HttpException(
      {
        code: API_ERROR_CODES.WALLET_SERVICE_UNAVAILABLE,
        message: 'Wallet service unavailable: Openfort request failed.',
      },
      HttpStatus.BAD_GATEWAY,
    );
  }

  private createUserOperationException(error: any): HttpException {
    if (this.isGasPriceRecommendationError(error)) {
      return new HttpException(
        {
          code: API_ERROR_CODES.USER_OPERATION_GAS_PRICE_UNAVAILABLE,
          message: 'Unable to estimate UserOperation fee parameters from chain RPC.',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }

    const message = this.getErrorText(error).toLowerCase();
    const baseMessage =
      message.includes('maxpriorityfeepergas') ||
      message.includes('max fee') ||
      message.includes('gas price')
        ? 'UserOperation rejected by bundler: gas price is below the required network minimum.'
        : message.includes('simulation') ||
            message.includes('revert') ||
            message.includes('unrecognized selector') ||
            message.includes('execution reverted')
          ? 'UserOperation rejected by bundler: simulation failed. Check target contract calldata and session key permissions.'
          : 'UserOperation rejected by bundler. Check chainId, target contract calldata, value, gas sponsorship, and session key authorization.';

    return new HttpException(
      {
        code: API_ERROR_CODES.USER_OPERATION_REJECTED,
        message: this.withSafeReason(baseMessage, error),
      },
      HttpStatus.BAD_GATEWAY,
    );
  }

  private isTimeoutError(error: any): boolean {
    return this.getErrorText(error).toLowerCase().includes('timed out');
  }

  private isGasPriceRecommendationError(error: any): boolean {
    const text = this.getErrorText(error).toLowerCase();
    return (
      text.includes('useroperation fee') ||
      text.includes('estimateuseroperationfees') ||
      text.includes('estimate fees per gas')
    );
  }

  private withSafeReason(message: string, error: any): string {
    const reason = this.sanitizeExternalErrorMessage(error);
    return reason ? `${message} Reason: ${reason}` : message;
  }

  private sanitizeExternalErrorMessage(error: any): string | null {
    const text = this.getErrorText(error)
      .replace(/0x[a-fA-F0-9]{16,}/g, '[hex]')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return null;
    return text.slice(0, 240);
  }

  private getErrorText(error: any): string {
    return [
      error?.shortMessage,
      error?.message,
      error?.details,
      error?.cause?.shortMessage,
      error?.cause?.message,
      error?.cause?.details,
    ]
      .filter(Boolean)
      .join(' ');
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

type UserOperationGasPrice = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};
