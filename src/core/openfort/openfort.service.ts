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
import { getBlock, getCode, getTransactionReceipt } from 'viem/actions';
import { toAccount } from 'viem/accounts';
import { RequestContextService } from '../../common/request-context/request-context.service';
import { getSupportedChain, isMonadChain } from '../../common/chains/supported-chains';
import { API_ERROR_CODES } from '../../common/errors/api-error-codes';
import { sanitizeErrorMessage } from '../../common/utils/sanitize';
import {
  CALIBUR_ADDRESSES,
  createCaliburSessionAccount,
  getAgentKeyUsabilityFailure,
  getCaliburKeySettings,
  hasCaliburDelegation,
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
      const pageSize = 100;
      const maxAccounts = 2000;
      const deadline = Date.now() + this.timeoutMs;
      const accounts: Array<{ id?: string; address?: string }> = [];
      const seenEntries = new Set<string>();
      let total: number | undefined;
      for (let skip = 0; ; skip += pageSize) {
        if (Date.now() >= deadline || skip >= maxAccounts) {
          throw new Error('Openfort account pagination exceeded safety bounds');
        }
        const result = (await this.withTimeout(
          (this.client as any).accounts.list({ user: openfortUserId, limit: pageSize, skip }),
          'listOpenfortUserAccounts',
        )) as { data?: unknown; total?: unknown };
        if (!result || !Array.isArray(result.data) || !Number.isSafeInteger(result.total) || (result.total as number) < 0) {
          throw new Error('Malformed Openfort account page');
        }
        if (total !== undefined && total !== result.total) throw new Error('Openfort account total changed during pagination');
        total = result.total as number;
        if (total > maxAccounts || result.data.length > pageSize || (result.data.length === 0 && skip < total)) {
          throw new Error('Incomplete Openfort account pagination');
        }
        for (const entry of result.data as Array<{ id?: string; address?: string }>) {
          if (!entry || typeof entry.id !== 'string' || !entry.id || seenEntries.has(entry.id)) {
            throw new Error('Repeated or malformed Openfort account page');
          }
          seenEntries.add(entry.id);
        }
        accounts.push(...(result.data as Array<{ id?: string; address?: string }>));
        if (accounts.length >= total) break;
        if (result.data.length === 0) throw new Error('Openfort account pagination did not advance');
      }
      if (accounts.length !== total) throw new Error('Openfort account pagination was truncated');
      const account = accounts.find((candidate) => {
        if (typeof candidate?.address !== 'string') return false;
        try { return getAddress(candidate.address) === normalizedAddress; } catch { return false; }
      });

      if (!account || typeof account.id !== 'string' || account.id.trim().length === 0) {
        throw new ForbiddenException('Embedded EOA is not owned by Openfort user');
      }
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

  /**
   * Safe, sanitized transaction-receipt view for billing reconciliation.
   *
   * Returns a discriminated result so callers can distinguish a confirmed
   * success/revert from a retryable not-found or transient RPC/block failure.
   * Only the fields needed for evidence-backed metering are exposed: status,
   * transactionHash, from/to, block number/hash/timestamp, gas metadata, and
   * logs (address/topics/data/logIndex/removed). It never returns calldata,
   * private keys, API keys, or the raw provider/client object.
   *
   * A missing receipt, malformed/missing logs, or a failed receipt/block
   * lookup returns a retryable result (never a fabricated success). A legal
   * empty `logs: []` array still yields a normal success/reverted view.
   */
  async getTransactionReceipt(chainId: number, txHash: string): Promise<TransactionReceiptResult> {
    try {
      const { chain } = getSupportedChain(chainId);
      const client = createClient({ chain, transport: http() });
      const receipt = await getTransactionReceipt(client, { hash: txHash as Hex });
      if (!receipt) return { status: 'not_found' };

      if (!Array.isArray(receipt.logs)) {
        return { status: 'error', message: 'receipt logs missing or malformed' };
      }

      let blockTimestamp: bigint;
      try {
        const block = await getBlock(client, { blockNumber: receipt.blockNumber });
        blockTimestamp = block.timestamp;
      } catch (error: any) {
        this.logOpenfortError('getTransactionReceipt', error, {
          chainId,
          txHash,
          phase: 'block',
        });
        return { status: 'error', message: 'block lookup failed' };
      }

      const status: 'success' | 'reverted' = receipt.status === 'success' ? 'success' : 'reverted';

      const sanitized: SanitizedReceipt = {
        status,
        transactionHash: receipt.transactionHash,
        from: receipt.from,
        to: receipt.to ?? null,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        blockTimestamp,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice ?? null,
        logs: receipt.logs.map((log) => ({
          address: log.address,
          topics: log.topics,
          data: log.data,
          logIndex: log.logIndex,
          removed: log.removed,
        })),
      };

      return { status, receipt: sanitized };
    } catch (error: any) {
      const message = String(error?.message ?? '');
      if (message.includes('Transaction receipt not found') || message.includes('not found')) {
        return { status: 'not_found' };
      }
      this.logOpenfortError('getTransactionReceipt', error, { chainId, txHash });
      return { status: 'error', message: 'receipt lookup failed' };
    }
  }

  /** Execute calls from the user's Calibur account with the registered backend agent key. */
  async submitUserOperation(params: {
    agentAccountId: string;
    accountAddress: string;
    chainId: number;
    keyHash: string;
    interactions: Array<{ to: string; data: string; value?: string }>;
    sponsorship?: 'required' | 'none';
    /** Called exactly once when the bundler returns its operation identity. */
    onUserOperationHash?: (userOpHash: string) => void | Promise<void>;
  }): Promise<{ userOpHash: string }> {
    try {
      const { chain } = getSupportedChain(params.chainId);
      const usesPimlico = isMonadChain(params.chainId);
      const publishableKey = this.configService.get<string>('openfort.publishableKey');
      if (!usesPimlico && !publishableKey) {
        throw new ServiceUnavailableException('Openfort publishable key is required for UserOps');
      }
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
      if (usesPimlico && params.sponsorship === 'required') {
        throw new ServiceUnavailableException(
          'Openfort fee sponsorship is not available for Monad UserOperations',
        );
      }
      const sponsorshipMode = usesPimlico ? 'none' : (params.sponsorship ?? 'none');
      const rpc = this.getUserOperationRpc(params.chainId, publishableKey);
      await this.assertCaliburContractAvailable(client, params.chainId);
      const gasPrice = await this.estimateUserOperationFees(rpc);
      const bundlerTransport = http(rpc.url, {
        fetchOptions: {
          ...(rpc.authorizationHeader ? { headers: { Authorization: rpc.authorizationHeader } } : {}),
        },
      } as any);
      const submission = await this.sendUserOperationWithSponsorship({
        account: sessionAccount,
        chain,
        client,
        transport: bundlerTransport,
        interactions: params.interactions,
        sponsorshipMode,
        chainId: params.chainId,
        gasPrice,
        onUserOperationHash: params.onUserOperationHash,
      });
      const userOpHash = this.sanitizeUserOperationHash(submission.hash);
      if (!userOpHash) throw new Error('Bundler returned an invalid UserOperation hash');
      return { userOpHash };
    } catch (error: any) {
      if (error instanceof HttpException) {
        throw error;
      }
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

  async waitForUserOperationReceipt(params: {
    chainId: number;
    userOpHash: string;
  }): Promise<{ success: boolean | null; transactionHash: string | null }> {
    try {
      const { chain } = getSupportedChain(params.chainId);
      const publishableKey = this.configService.get<string>('openfort.publishableKey');
      const rpc = this.getUserOperationRpc(params.chainId, publishableKey);
      const bundlerClient = createBundlerClient({
        chain,
        transport: http(
          rpc.url,
          rpc.authorizationHeader ? { fetchOptions: { headers: { Authorization: rpc.authorizationHeader } } } : undefined,
        ),
      });
      const receipt = (await this.withTimeout(
        bundlerClient.waitForUserOperationReceipt({ hash: params.userOpHash as Hex }),
        'waitForUserOperationReceipt',
      )) as any;
      return {
        success: typeof receipt.success === 'boolean' ? receipt.success : null,
        transactionHash: receipt.receipt?.transactionHash ?? receipt.transactionHash ?? null,
      };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      this.logOpenfortError('waitForUserOperationReceipt', error, { chainId: params.chainId });
      throw this.createOpenfortApiException('waitForUserOperationReceipt', error);
    }
  }

  /** Compatibility wrapper; new callers must persist the hash before waiting. */
  async sendUserOperation(params: Parameters<OpenfortService['submitUserOperation']>[0]): Promise<{
    userOpHash: string; transactionHash: string | null; userOperationSuccess: boolean | null;
  }> {
    const submitted = await this.submitUserOperation(params);
    const receipt = await this.waitForUserOperationReceipt({ chainId: params.chainId, userOpHash: submitted.userOpHash });
    return { ...submitted, transactionHash: receipt.transactionHash, userOperationSuccess: receipt.success };
  }

  private async assertCaliburContractAvailable(client: any, chainId: number): Promise<void> {
    for (const address of CALIBUR_ADDRESSES) {
      const code = await getCode(client, { address });
      if (code && code !== '0x') {
        return;
      }
    }

    throw new ServiceUnavailableException(
      `Calibur is not deployed on chain ${chainId}; EIP-7702 authorization is unavailable for this network.`,
    );
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
    onUserOperationHash?: (userOpHash: string) => void | Promise<void>;
  }): Promise<{ hash: string; bundlerClient: any }> {
    const submit = (promise: Promise<string>) => {
      // Keep the handler attached to the original provider promise. Promise.race
      // alone would leave a late provider rejection unhandled after a timeout.
      const observed = promise.then(async (hash) => {
        const sanitizedHash = this.sanitizeUserOperationHash(hash);
        if (sanitizedHash && params.onUserOperationHash) {
          try {
            await params.onUserOperationHash(sanitizedHash);
          } catch {
            // The request may already have timed out; the transaction remains
            // uncertain and reconciliation can still process an existing hash.
            this.logger.warn(this.logContext({ message: 'Unable to persist late UserOperation identity' }));
          }
        }
        // The SDK's typed return remains the compatibility result. Only the
        // callback crosses the persistence boundary and therefore receives the
        // strict sanitized value above.
        return hash;
      });
      return this.withTimeout(observed, 'submitUserOperation');
    };
    const calls = params.interactions.map((interaction) => ({
      to: getAddress(interaction.to),
      data: interaction.data as Hex,
      value: interaction.value ? BigInt(interaction.value) : 0n,
    }));
    if (params.sponsorshipMode === 'none') {
      const bundlerClient = this.createBundlerClient({ ...params, includePaymaster: false });
      const gasLimits = await this.estimateUnsponsoredUserOperationGas(bundlerClient, {
        account: params.account,
        calls,
        maxFeePerGas: params.gasPrice.maxFeePerGas,
        maxPriorityFeePerGas: params.gasPrice.maxPriorityFeePerGas,
      });
      return {
        hash: await submit(bundlerClient.sendUserOperation({
          account: params.account,
          calls,
          ...gasLimits,
          maxFeePerGas: params.gasPrice.maxFeePerGas,
          maxPriorityFeePerGas: params.gasPrice.maxPriorityFeePerGas,
        } as any)),
        bundlerClient,
      };
    }

    const bundlerClient = this.createBundlerClient({ ...params, includePaymaster: true });
    return {
      hash: await submit(bundlerClient.sendUserOperation({
        account: params.account,
        calls,
        maxFeePerGas: params.gasPrice.maxFeePerGas,
        maxPriorityFeePerGas: params.gasPrice.maxPriorityFeePerGas,
      } as any)),
      bundlerClient,
    };
  }

  private sanitizeUserOperationHash(value: unknown): string | null {
    return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : null;
  }

  private async estimateUserOperationFees(params: {
    url: string;
    gasPriceMethod: string;
    authorizationHeader?: string;
    providerName: string;
  }): Promise<UserOperationGasPrice> {
    const response = await this.withTimeout(
      fetch(params.url, {
        method: 'POST',
        headers: {
          ...(params.authorizationHeader ? { Authorization: params.authorizationHeader } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: params.gasPriceMethod,
          params: [],
        }),
      }),
      'estimateUserOperationFees',
    );

    if (!response.ok) {
      throw new Error(
        `Unable to estimate UserOperation fee parameters from ${params.providerName} RPC`,
      );
    }

    const payload = (await response.json()) as OpenfortGasPriceRpcResponse;
    if (payload.error) {
      throw new Error(
        `Unable to estimate UserOperation fee parameters from ${params.providerName} RPC`,
      );
    }

    const recommendedFees = this.selectOpenfortUserOperationGasPrice(payload.result);

    if (!recommendedFees?.maxFeePerGas || !recommendedFees?.maxPriorityFeePerGas) {
      throw new Error(
        `Unable to estimate UserOperation fee parameters from ${params.providerName} RPC`,
      );
    }

    return {
      maxFeePerGas: recommendedFees.maxFeePerGas,
      maxPriorityFeePerGas: recommendedFees.maxPriorityFeePerGas,
    };
  }

  private getUserOperationRpc(chainId: number, publishableKey?: string) {
    if (!isMonadChain(chainId)) {
      return {
        url: `https://api.openfort.io/rpc/${chainId}`,
        authorizationHeader: `Bearer ${publishableKey}`,
        gasPriceMethod: 'openfort_getUserOperationGasPrice',
        providerName: 'Openfort',
      };
    }

    return {
      url: this.getMonadPimlicoRpcUrl(chainId),
      gasPriceMethod: 'pimlico_getUserOperationGasPrice',
      providerName: 'Pimlico',
    };
  }

  private getMonadPimlicoRpcUrl(chainId: number): string {
    const override = this.configService.get<string>(`pimlico.rpcUrls.${chainId}`);
    if (override) return override;

    const apiKey = this.configService.get<string>('pimlico.apiKey');
    if (!apiKey) {
      throw new ServiceUnavailableException('Pimlico API key is required for Monad UserOperations');
    }
    return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${encodeURIComponent(apiKey)}`;
  }

  private selectOpenfortUserOperationGasPrice(
    result: OpenfortGasPriceRpcResult | undefined,
  ): UserOperationGasPrice | null {
    const candidate = result?.fast ?? result?.standard ?? result;
    const maxFeePerGas = this.parseRpcBigInt(candidate?.maxFeePerGas);
    const maxPriorityFeePerGas = this.parseRpcBigInt(candidate?.maxPriorityFeePerGas);
    if (!maxFeePerGas || !maxPriorityFeePerGas) return null;
    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  private parseRpcBigInt(value: unknown): bigint | null {
    if (typeof value === 'bigint') return value;
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value).trim();
    if (/^0x[0-9a-fA-F]+$/.test(text)) return BigInt(text);
    if (/^\d+$/.test(text)) return BigInt(text);
    return null;
  }

  private async estimateUnsponsoredUserOperationGas(
    bundlerClient: any,
    request: {
      account: any;
      calls: Array<{ to: Address; data: Hex; value: bigint }>;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
    },
  ): Promise<UserOperationGasLimits> {
    const gas = (await this.withTimeout(
      bundlerClient.estimateUserOperationGas(request),
      'estimateUserOperationGas',
    )) as Partial<UserOperationGasLimits> & Record<string, unknown>;

    if (
      gas.callGasLimit === undefined ||
      gas.verificationGasLimit === undefined ||
      gas.preVerificationGas === undefined
    ) {
      throw new Error('Unable to estimate UserOperation gas limits from bundler');
    }

    return {
      callGasLimit: gas.callGasLimit,
      verificationGasLimit: gas.verificationGasLimit,
      preVerificationGas: gas.preVerificationGas,
    };
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
          message: 'Unable to estimate UserOperation fee parameters from Openfort RPC.',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }

    const message = this.getErrorText(error).toLowerCase();
    const baseMessage = this.isGasFeeTooLowError(message)
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

  private isGasFeeTooLowError(message: string): boolean {
    const mentionsFee =
      message.includes('maxpriorityfeepergas') ||
      message.includes('maxfeepergas') ||
      message.includes('gas price');
    const mentionsMinimum =
      message.includes('at least') ||
      message.includes('too low') ||
      message.includes('underpriced') ||
      message.includes('minimum');
    return mentionsFee && mentionsMinimum;
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
    const text = this.getErrorText(error);
    if (!text) return null;
    return sanitizeErrorMessage(text, 240);
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

type UserOperationGasLimits = {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
};

type OpenfortGasPriceRpcResponse = {
  result?: OpenfortGasPriceRpcResult;
  error?: unknown;
};

type OpenfortGasPriceRpcResult = Partial<UserOperationGasPriceLike> & {
  standard?: UserOperationGasPriceLike;
  fast?: UserOperationGasPriceLike;
};

type UserOperationGasPriceLike = {
  maxFeePerGas?: bigint | number | string;
  maxPriorityFeePerGas?: bigint | number | string;
};

/** A single sanitized receipt log (no calldata, no raw provider objects). */
export interface SanitizedReceiptLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
  removed: boolean;
}

/** Sanitized, evidence-safe view of an on-chain transaction receipt. */
export interface SanitizedReceipt {
  status: 'success' | 'reverted';
  transactionHash: string;
  from: string;
  to: string | null;
  blockNumber: bigint;
  blockHash: string;
  blockTimestamp: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint | null;
  logs: SanitizedReceiptLog[];
}

/**
 * Discriminated result of a receipt lookup. `not_found` and `error` are
 * retryable (the transaction should stay pending); `success`/`reverted` are
 * final and carry the sanitized receipt.
 */
export type TransactionReceiptResult =
  | { status: 'success'; receipt: SanitizedReceipt }
  | { status: 'reverted'; receipt: SanitizedReceipt }
  | { status: 'not_found' }
  | { status: 'error'; message: string };
