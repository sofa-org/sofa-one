import { useCallback, useEffect, useState } from 'react';
import { AccountTypeEnum, RecoveryMethod, use7702Authorization, useOpenfort, useUser } from '@openfort/react';
import { useEthereumEmbeddedWallet } from '@openfort/react/ethereum';
import { usePublicClient } from 'wagmi';
import { http, padHex, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { createBundlerClient, createPaymasterClient } from 'viem/account-abstraction';
import { toAccount } from 'viem/accounts';
import {
  DEFAULT_CHAIN_ID,
  authorizeEmbeddedWallet,
  getMe,
  markAgentRegistrationResult,
  markAgentRegistrationTransaction,
  syncSession,
  withdrawAuth,
  getBalancesAuth,
  getApiErrorMessage,
  hasApiErrorCode,
  type AuthSessionResponse,
  type BalanceChain,
  type WalletInfo,
} from '@/lib/api';
import {
  SUPPORTED_CHAINS,
  getChainGasHelpUrl,
  getExplorerAddressUrl,
  getExplorerTransactionUrl,
} from '@/lib/chains';
import {
  CALIBUR_ADDRESS,
  CALIBUR_DELEGATION_CODE,
  KeyType,
  createCaliburAccount,
  encodeRegisterKey,
  encodeSelfCall,
  encodeUpdateKeySettings,
  hashKey,
  type CaliburKey,
} from '@/lib/calibur';
import { AlertCircle, BanknoteArrowUp, RotateCcw, X } from 'lucide-react';
import { CopyButton } from '@/components/CopyButton';
import { DashboardPage, DashboardCard } from './components/DashboardPage';
import { WalletLoadingState } from './WalletLoadingState';
import { ApiKeyBanner } from './ApiKeyBanner';
import { SetupStatusBanner } from './SetupStatusBanner';
import { AuthorizationBadges } from './AuthorizationBadges';
import { Step1CreateEoa } from './Step1CreateEoa';
import { Step2AuthorizeAccess } from './Step2AuthorizeAccess';
import { BalanceDisplay } from './BalanceDisplay';
import { WithdrawForm } from './WithdrawForm';
import { requestStepUpToken } from './step-up';
import {
  AGENT_CHAIN_STORAGE_KEY,
  AGENT_AUTHORIZATION_MAX_TTL_MS,
  AGENT_REGISTRATION_AUTO_CHECK_MS,
  AGENT_REGISTRATION_MANUAL_CHECK_MS,
  AGENT_REGISTRATION_RECEIPT_TIMEOUT_MS,
  AGENT_REGISTRATION_RESULT_RETRY_DELAY_MS,
  AUTHORIZE_EMBEDDED_WALLET_RETRIES,
  AUTHORIZE_EMBEDDED_WALLET_RETRY_DELAY_MS,
  BALANCE_CHAIN_STORAGE_KEY,
  RAW_KEY_NOTICE_TTL_MS,
  WithdrawSuccess,
  assertWebCryptoAvailable,
  delay,
  formatAuthorizationExpiry,
  getDefaultAgentExpiryLocal,
  getOpenfortUserOperationGasPrice,
  getStoredChainId,
  parseUsdcAmount,
  persistChainId,
  resolveEmbeddedWallet,
} from './wallet-helpers';

export default function WalletPage() {
  const openfort = useOpenfort();
  const { getAccessToken, isAuthenticated, isLoading: authLoading, user } = useUser();
  const getToken = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      throw new Error('Openfort session is not ready. Refresh and sign in again.');
    }
    return token;
  }, [getAccessToken]);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [apiKeyDisplay, setApiKeyDisplay] = useState<string | null>(null);
  const [selectedChainId, setSelectedChainId] = useState(() =>
    getStoredChainId(BALANCE_CHAIN_STORAGE_KEY, DEFAULT_CHAIN_ID),
  );
  const [agentChainId, setAgentChainId] = useState(() =>
    getStoredChainId(AGENT_CHAIN_STORAGE_KEY, DEFAULT_CHAIN_ID),
  );
  const selectedAuthorization = wallet?.chainAuthorizations.find(
    (authorization) => authorization.chainId === agentChainId,
  );
  const selectedAuthorizationExpiry = formatAuthorizationExpiry(selectedAuthorization?.expiresAt);
  const pendingAuthorization = wallet?.chainAuthorizations.find(
    (authorization) => authorization.status === 'pending_registration' && authorization.registrationTxHash,
  );
  const hasRegisteredAuthorization = wallet?.chainAuthorizations.some(
    (authorization) => authorization.status === 'registered',
  ) ?? false;
  const agentRegistrationChainId = pendingAuthorization?.chainId ?? agentChainId;
  const walletExplorerUrl = getExplorerAddressUrl(agentChainId, wallet?.walletAddress);
  const pendingAuthorizationExplorerUrl = getExplorerTransactionUrl(
    agentRegistrationChainId,
    pendingAuthorization?.registrationTxHash,
  );
  const agentGasHelpUrl = getChainGasHelpUrl(agentChainId);
  const authorizedChainIdsText =
    wallet?.chainAuthorizations.map((authorization) => authorization.chainId).join(', ') ?? '';
  const publicClient = usePublicClient({ chainId: agentRegistrationChainId });
  const { signAuthorization: signOpenfortAuthorization } = use7702Authorization();
  const embeddedWallet = useEthereumEmbeddedWallet({ chainId: agentChainId });
  const agentNativeSymbol = publicClient?.chain?.nativeCurrency.symbol ?? 'native gas token';
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [walletReloadNonce, setWalletReloadNonce] = useState(0);

  const [balances, setBalances] = useState<BalanceChain[] | null>(null);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [balancesError, setBalancesError] = useState<string | null>(null);
  const [balanceRefreshNonce, setBalanceRefreshNonce] = useState(0);

  const [showWithdraw, setShowWithdraw] = useState(false);

  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [token, setToken] = useState('USDC');
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [withdrawResult, setWithdrawResult] = useState<WithdrawSuccess | null>(null);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  const withdrawExplorerUrl = withdrawResult
    ? getExplorerTransactionUrl(withdrawResult.chainId, withdrawResult.transactionHash)
    : null;

  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [showRecoveryPassword, setShowRecoveryPassword] = useState(false);
  const [agentExpiryLocal, setAgentExpiryLocal] = useState(getDefaultAgentExpiryLocal);
  const [walletSetupLoading, setWalletSetupLoading] = useState(false);
  const [walletSetupError, setWalletSetupError] = useState<string | null>(null);
  const [walletSetupSuccess, setWalletSetupSuccess] = useState<string | null>(null);
  const [agentRegistrationCheckStatus, setAgentRegistrationCheckStatus] = useState<
    'idle' | 'checking' | 'timed_out'
  >('idle');

  useEffect(() => {
    persistChainId(BALANCE_CHAIN_STORAGE_KEY, selectedChainId);
  }, [selectedChainId]);

  useEffect(() => {
    persistChainId(AGENT_CHAIN_STORAGE_KEY, agentChainId);
  }, [agentChainId]);

  const confirmAgentRegistration = useCallback(
    async (client: PublicClient, chainId: number, txHash: Hex, shouldContinue: () => boolean) => {
      const receipt = await client.waitForTransactionReceipt({
        hash: txHash,
        timeout: AGENT_REGISTRATION_RECEIPT_TIMEOUT_MS,
      });
      const status: 'registered' | 'registration_failed' =
        receipt.status === 'success' ? 'registered' : 'registration_failed';

      while (shouldContinue()) {
        try {
          return await markAgentRegistrationResult(getToken, { chainId, txHash, status });
        } catch (err: unknown) {
          if (status === 'registration_failed' || !hasApiErrorCode(err, 'AGENT_REGISTRATION_PENDING')) {
            throw err;
          }
          await delay(AGENT_REGISTRATION_RESULT_RETRY_DELAY_MS);
        }
      }

      return null;
    },
    [getToken],
  );

  const checkPendingAgentRegistration = useCallback(
    async (durationMs: number) => {
      if (!pendingAuthorization?.registrationTxHash || !publicClient) return null;

      const deadline = Date.now() + durationMs;
      return confirmAgentRegistration(
        publicClient,
        pendingAuthorization.chainId,
        pendingAuthorization.registrationTxHash as Hex,
        () => Date.now() < deadline,
      );
    },
    [confirmAgentRegistration, pendingAuthorization?.chainId, pendingAuthorization?.registrationTxHash, publicClient],
  );

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated || !user) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    async function init() {
      try {
        let result: AuthSessionResponse;
        try {
          result = await getMe(getToken, controller.signal);
        } catch (err: unknown) {
          if (!hasApiErrorCode(err, 'NOT_FOUND', 'WALLET_NOT_FOUND')) throw err;
          result = await syncSession(getToken, controller.signal);
        }

        if (result.apiKey) {
          setApiKeyDisplay(result.apiKey);
        }
        setWallet(result.wallet);
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        setError(getApiErrorMessage(err));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    init();

    return () => {
      controller.abort();
    };
  }, [authLoading, isAuthenticated, user, getToken, walletReloadNonce]);

  useEffect(() => {
    if (!apiKeyDisplay) return;

    const timeoutId = window.setTimeout(() => {
      setApiKeyDisplay(null);
    }, RAW_KEY_NOTICE_TTL_MS);

    return () => window.clearTimeout(timeoutId);
  }, [apiKeyDisplay]);

  useEffect(() => {
    if (!user || !wallet?.walletAddress) {
      setBalances(null);
      setBalancesError(null);
      return;
    }

    const controller = new AbortController();
    setBalancesLoading(true);
    setBalancesError(null);
    getBalancesAuth(getToken, selectedChainId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setBalances(data.chains);
          setBalancesError(null);
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setBalancesError(getApiErrorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBalancesLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [user, selectedChainId, wallet, getToken, balanceRefreshNonce]);

  function retryBalances() {
    setBalanceRefreshNonce((nonce) => nonce + 1);
  }

  function retryWalletLoad() {
    setWalletReloadNonce((nonce) => nonce + 1);
  }

  useEffect(() => {
    const txHash = pendingAuthorization?.registrationTxHash;
    const chainId = pendingAuthorization?.chainId;
    if (!user || !publicClient || !chainId || !txHash) {
      return;
    }

    let cancelled = false;
    const client = publicClient;
    const savedTxHash = txHash;
    const savedChainId = chainId;
    const deadline = Date.now() + AGENT_REGISTRATION_AUTO_CHECK_MS;
    setAgentRegistrationCheckStatus('checking');
    setWalletSetupError(null);

    async function resumeAgentRegistrationCheck() {
      try {
        const result = await confirmAgentRegistration(
          client,
          savedChainId,
          savedTxHash as Hex,
          () => !cancelled && Date.now() < deadline,
        );
        if (cancelled) return;
        if (result) {
          setWallet(result.wallet);
          setAgentRegistrationCheckStatus('idle');
          return;
        }
        setAgentRegistrationCheckStatus('timed_out');
        setWalletSetupSuccess(
          'Authorization transaction succeeded, but confirmation is taking longer than expected. Use Retry check to verify again.',
        );
      } catch (err: unknown) {
        if (cancelled) return;
        setAgentRegistrationCheckStatus('timed_out');
        setWalletSetupError(getApiErrorMessage(err));
        // Leave the saved tx hash and pending status intact; the next page visit will retry.
      }
    }

    resumeAgentRegistrationCheck();

    return () => {
      cancelled = true;
    };
  }, [user, publicClient, pendingAuthorization?.chainId, pendingAuthorization?.registrationTxHash, confirmAgentRegistration]);

  async function handleRetryAgentRegistrationCheck() {
    setAgentRegistrationCheckStatus('checking');
    setWalletSetupError(null);
    setWalletSetupSuccess(null);

    try {
      const result = await checkPendingAgentRegistration(AGENT_REGISTRATION_MANUAL_CHECK_MS);
      if (result) {
        setWallet(result.wallet);
        setAgentRegistrationCheckStatus('idle');
        setWalletSetupSuccess('API access authorization confirmed.');
        return;
      }

      setAgentRegistrationCheckStatus('timed_out');
      setWalletSetupSuccess(
        'Authorization is still pending verification. Retry again in a moment; do not submit another authorization.',
      );
    } catch (err: unknown) {
      setAgentRegistrationCheckStatus('timed_out');
      setWalletSetupError(getApiErrorMessage(err));
    }
  }

  async function handleWithdraw(e: React.FormEvent) {
    e.preventDefault();
    setWithdrawLoading(true);
    setWithdrawResult(null);
    setWithdrawError(null);
    try {
      const baseUnits = parseUsdcAmount(amount);
      const chainId = selectedChainId;
      const stepUpToken = await requestStepUpToken(getToken);
      const result = await withdrawAuth(getToken, to, baseUnits, token, chainId, stepUpToken);
      setWithdrawResult({
        message: `Transaction submitted: ${result.transactionHash || result.transactionId}`,
        transactionHash: result.transactionHash,
        chainId,
      });
      setTo('');
      setAmount('');
    } catch (err: unknown) {
      setWithdrawError(getApiErrorMessage(err));
    } finally {
      setWithdrawLoading(false);
    }
  }

  function resetWithdrawForm() {
    setWithdrawResult(null);
    setWithdrawError(null);
    setTo('');
    setAmount('');
  }

  async function handleConnectWallet(e: React.FormEvent) {
    e.preventDefault();
    setWalletSetupLoading(true);
    setWalletSetupError(null);
    setWalletSetupSuccess(null);

    try {
      assertWebCryptoAvailable();
      if (recoveryPassword.length < 8) {
        throw new Error('Use a wallet recovery password with at least 8 characters.');
      }

      let createdAccount: unknown;
      let refreshedAccounts: unknown[] | undefined;
      if (!embeddedWallet.address) {
        createdAccount = await embeddedWallet.create({
          chainId: agentChainId,
          accountType: AccountTypeEnum.EOA,
          recoveryMethod: RecoveryMethod.PASSWORD,
          password: recoveryPassword,
        });
        refreshedAccounts = await openfort.updateEmbeddedAccounts({ silent: true });
      }

      const { address, accountId } = resolveEmbeddedWallet(createdAccount, embeddedWallet, refreshedAccounts);
      await embeddedWallet.setActive({
        address,
        chainId: agentChainId,
        recoveryMethod: RecoveryMethod.PASSWORD,
        password: recoveryPassword,
      });

      let authorized: AuthSessionResponse;
      for (let attempt = 0; ; attempt += 1) {
        try {
          authorized = await authorizeEmbeddedWallet(getToken, {
            embeddedWalletAddress: address,
            embeddedOpenfortAccountId: accountId,
          });
          break;
        } catch (err: unknown) {
          if (attempt >= AUTHORIZE_EMBEDDED_WALLET_RETRIES) throw err;
          await delay(AUTHORIZE_EMBEDDED_WALLET_RETRY_DELAY_MS);
          refreshedAccounts = await openfort.updateEmbeddedAccounts({ silent: true });
        }
      }

      setWallet(authorized.wallet);
      setWalletSetupSuccess('Agent wallet created. Choose a network below, add gas, then authorize API access.');
    } catch (err: unknown) {
      setWalletSetupError(getApiErrorMessage(err));
    } finally {
      setWalletSetupLoading(false);
    }
  }

  async function handleRegisterAgent(e: React.FormEvent) {
    e.preventDefault();
    setWalletSetupLoading(true);
    setWalletSetupError(null);
    setWalletSetupSuccess(null);

    try {
      assertWebCryptoAvailable();
      if (!wallet?.walletAddress || !wallet.agentWalletAddress || !wallet.agentKeyHash) {
        throw new Error('Missing wallet or agent key details. Please reload the page.');
      }
      if (pendingAuthorization) {
        throw new Error(
          'API access authorization is already checking. Wait for confirmation before authorizing again.',
        );
      }
      if (recoveryPassword.length < 8) {
        throw new Error('Enter your wallet recovery password to unlock registration.');
      }
      const agentExpiresAt = new Date(agentExpiryLocal);
      if (Number.isNaN(agentExpiresAt.getTime()) || agentExpiresAt <= new Date()) {
        throw new Error('Choose an API authorization expiry time in the future.');
      }
      if (agentExpiresAt.getTime() - Date.now() > AGENT_AUTHORIZATION_MAX_TTL_MS) {
        throw new Error('Choose an API authorization expiry within 30 days.');
      }

      let activeEmbeddedWallet: { address: Address; accountId?: string };
      try {
        activeEmbeddedWallet = resolveEmbeddedWallet(undefined, embeddedWallet);
      } catch {
        activeEmbeddedWallet = { address: wallet.walletAddress as Address };
      }

      let address = activeEmbeddedWallet.address;
      const walletAddressChanged = wallet.walletAddress.toLowerCase() !== address.toLowerCase();
      let authorization = walletAddressChanged ? undefined : selectedAuthorization;
      let currentWallet = wallet;
      if (!authorization || authorization.status === 'registered' || authorization.status === 'registration_failed') {
        const initialized = await authorizeEmbeddedWallet(getToken, {
          embeddedWalletAddress: address,
          embeddedOpenfortAccountId: activeEmbeddedWallet.accountId,
          chainId: agentChainId,
          agentExpiresAt: agentExpiresAt.toISOString(),
        });
        currentWallet = initialized.wallet;
        setWallet(currentWallet);
        address = currentWallet.walletAddress as Address;
        authorization = currentWallet.chainAuthorizations.find((item) => item.chainId === agentChainId);
      }

      if (!authorization?.expiresAt) {
        throw new Error('Missing authorization expiry. Please retry.');
      }

      await embeddedWallet.setActive({
        address,
        chainId: agentChainId,
        recoveryMethod: RecoveryMethod.PASSWORD,
        password: recoveryPassword,
      });

      if (!publicClient) {
        throw new Error('Cannot check gas balance for this chain. Please retry after the network is ready.');
      }

      const feeSponsorshipId = import.meta.env.VITE_OPENFORT_FEE_SPONSORSHIP_ID;
      const nativeBalance = await publicClient.getBalance({ address });
      if (!feeSponsorshipId && nativeBalance === 0n) {
        throw new Error(
          `Your wallet has no ${agentNativeSymbol} for gas. Deposit ${agentNativeSymbol} to ${address} and retry agent registration.`,
        );
      }

      const agentKey: CaliburKey = {
        keyType: KeyType.Secp256k1,
        publicKey: padHex(currentWallet.agentWalletAddress as Hex, { size: 32 }),
      };
      const frontendKeyHash = hashKey(agentKey);
      if (frontendKeyHash.toLowerCase() !== currentWallet.agentKeyHash!.toLowerCase()) {
        throw new Error('Agent key hash mismatch. Please contact support.');
      }

      const expiration = Math.floor(new Date(authorization.expiresAt).getTime() / 1000);
      const registrationCalls = [
        encodeSelfCall(encodeRegisterKey(agentKey)),
        encodeSelfCall(
          encodeUpdateKeySettings(frontendKeyHash, {
            isAdmin: false,
            expiration,
            hook: zeroAddress,
          }),
        ),
      ];

      const walletCode = await publicClient.getCode({ address });
      if (walletCode && walletCode !== '0x' && walletCode.toLowerCase() !== CALIBUR_DELEGATION_CODE.toLowerCase()) {
        throw new Error('This wallet is delegated to an unsupported contract. Please contact support.');
      }
      const eip7702Authorization =
        !walletCode || walletCode === '0x'
          ? await signOpenfortAuthorization({
              chainId: agentChainId,
              nonce: await publicClient.getTransactionCount({ address, blockTag: 'pending' }),
              contractAddress: CALIBUR_ADDRESS,
            })
          : undefined;

      const owner = toAccount({
        address,
        async sign({ hash }) {
          return openfort.client.embeddedWallet.signMessage(hash, {
            hashMessage: false,
            arrayifyMessage: false,
          }) as Promise<Hex>;
        },
        async signMessage({ message }) {
          if (typeof message === 'string') {
            return openfort.client.embeddedWallet.signMessage(message) as Promise<Hex>;
          }

          return openfort.client.embeddedWallet.signMessage(message.raw, {
            hashMessage: false,
            arrayifyMessage: false,
          }) as Promise<Hex>;
        },
        async signTransaction() {
          throw new Error('Openfort embedded wallet transaction signing is not used for Calibur UserOperations.');
        },
        async signTypedData(typedData) {
          const payload = typedData as {
            domain: Parameters<typeof openfort.client.embeddedWallet.signTypedData>[0];
            types: Parameters<typeof openfort.client.embeddedWallet.signTypedData>[1];
            message: Parameters<typeof openfort.client.embeddedWallet.signTypedData>[2];
          };
          return openfort.client.embeddedWallet.signTypedData(
            payload.domain,
            payload.types,
            payload.message,
          ) as Promise<Hex>;
        },
      });
      const caliburAccount = await createCaliburAccount({ client: publicClient, owner });
      const openfortPublishableKey = import.meta.env.VITE_OPENFORT_PUBLISHABLE_KEY;
      if (!openfortPublishableKey) {
        throw new Error('Openfort publishable key is not configured.');
      }
      const openfortRpcUrl = `https://api.openfort.io/rpc/${agentChainId}`;
      const openfortRpcTransport = http(openfortRpcUrl, {
        fetchOptions: {
          headers: { Authorization: `Bearer ${openfortPublishableKey}` },
        },
      });
      const paymaster = feeSponsorshipId
        ? createPaymasterClient({ transport: openfortRpcTransport })
        : undefined;
      const bundlerClient = createBundlerClient({
        account: caliburAccount,
        chain: publicClient.chain,
        client: publicClient,
        ...(paymaster ? { paymaster } : {}),
        transport: openfortRpcTransport,
      } as never);
      const fees = await getOpenfortUserOperationGasPrice(openfortRpcUrl, openfortPublishableKey);
      const userOpHash = await bundlerClient.sendUserOperation({
        account: caliburAccount,
        calls: registrationCalls,
        ...(eip7702Authorization ? { authorization: eip7702Authorization } : {}),
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        ...(feeSponsorshipId ? { paymasterContext: { policyId: feeSponsorshipId } } : {}),
      } as never);
      const userOpReceipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });
      const txHash = (
        userOpReceipt as { receipt?: { transactionHash?: Hex }; transactionHash?: Hex }
      ).receipt?.transactionHash ??
        (userOpReceipt as { transactionHash?: Hex }).transactionHash;
      if (!txHash) {
        throw new Error(
          `Agent registration UserOperation was submitted but no transaction hash was returned: ${userOpHash}`,
        );
      }
      const pending = await markAgentRegistrationTransaction(getToken, { chainId: agentChainId, txHash });
      setWallet(pending.wallet);

      let result: AuthSessionResponse | null;
      try {
        let attempts = 0;
        result = await confirmAgentRegistration(publicClient, agentChainId, txHash, () => attempts++ < 3);
      } catch {
        setWalletSetupSuccess(`Authorization pending. We will check again next time: ${txHash}`);
        return;
      }

      if (!result) {
        setWalletSetupSuccess(`Authorization pending. We are still checking on-chain: ${txHash}`);
        return;
      }

      setWallet(result.wallet);
      const confirmedAuthorization = result.wallet.chainAuthorizations.find(
        (item) => item.chainId === agentChainId,
      );
      if (confirmedAuthorization?.status === 'registered') {
        setWalletSetupSuccess(`API access authorized: ${txHash}`);
      } else {
        setWalletSetupError(`API access authorization failed: ${txHash}`);
      }
    } catch (err: unknown) {
      setWalletSetupError(getApiErrorMessage(err));
    } finally {
      setWalletSetupLoading(false);
    }
  }

  const agentChain = SUPPORTED_CHAINS.find((chain) => chain.id === agentChainId);
  const agentChainName = agentChain?.name ?? `Chain ${agentChainId}`;
  const selectedAuthorizationStatus = selectedAuthorization?.status ?? null;
  const shouldPromptReauthorization =
    selectedAuthorizationExpiry?.tone === 'red' || selectedAuthorizationExpiry?.tone === 'amber';
  const selectedAuthorizationExpiryClasses =
    selectedAuthorizationExpiry?.tone === 'red'
      ? 'border-red-200 bg-red-50 text-red-800'
      : selectedAuthorizationExpiry?.tone === 'amber'
        ? 'border-amber-200 bg-amber-50 text-amber-800'
        : 'border-green-200 bg-green-50 text-green-800';
  const isSelectedChainRegistered = selectedAuthorizationStatus === 'registered';
  const isAgentRegistrationChecking = Boolean(pendingAuthorization);
  const registrationBusy = walletSetupLoading || isAgentRegistrationChecking;
  const authorizeSubmitDisabled = registrationBusy || (isSelectedChainRegistered && !shouldPromptReauthorization);
  const showAgentRegistrationSpinner = walletSetupLoading || agentRegistrationCheckStatus === 'checking';
  const setupStatus = !wallet?.walletAddress
    ? {
        title: 'Create agent EOA',
        tone: 'amber',
        description:
          'Set one recovery password. Openfort secures the EOA key and we never expose private keys.',
      }
    : hasRegisteredAuthorization
      ? {
          title: 'Ready for API transactions',
          tone: 'green',
          description:
            'Your EOA has Calibur API access on at least one network. You can authorize more networks anytime.',
        }
      : pendingAuthorization
        ? {
            title: 'Authorization pending',
            tone: 'blue',
            description:
              'The authorization transaction was submitted and is being checked.',
          }
        : {
            title: 'Authorize API access',
            tone: 'blue',
            description:
              'Choose a network, add gas, unlock the wallet, and authorize API access.',
          };
  const setupStatusClasses =
    setupStatus.tone === 'green'
      ? 'border-green-200 bg-green-50 text-green-800'
      : setupStatus.tone === 'blue'
        ? 'border-blue-200 bg-blue-50 text-blue-800'
        : 'border-amber-200 bg-amber-50 text-amber-800';
  const setupPhase = !wallet?.walletAddress ? 1 : hasRegisteredAuthorization ? 3 : 2;
  const setupSteps = [
    {
      number: 1,
      title: 'Create wallet',
      description: 'Set recovery password',
      state: setupPhase > 1 ? 'done' : setupPhase === 1 ? 'active' : 'locked',
    },
    {
      number: 2,
      title: 'Authorize networks',
      description: 'Choose network and approve',
      state: setupPhase > 2 ? 'done' : setupPhase === 2 ? 'active' : 'locked',
    },
  ];

  return (
    <DashboardPage
      title="Agent Wallet"
      description="Create one secure wallet, authorize API access, then use API keys from your backend."
    >
      {loading ? (
        <WalletLoadingState />
      ) : error ? (
        <div className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={retryWalletLoad}
            className="inline-flex items-center justify-center gap-1.5 rounded-full border border-red-200 bg-white px-4 py-1.5 text-xs font-semibold text-red-700 transition-all hover:border-red-300 hover:bg-red-100"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Retry wallet
          </button>
        </div>
      ) : (
        <>
          {apiKeyDisplay && (
            <ApiKeyBanner apiKeyDisplay={apiKeyDisplay} onDismiss={() => setApiKeyDisplay(null)} />
          )}

          {wallet && (
            <DashboardCard className="!p-0">
              <div className="p-7 space-y-6">
                <SetupStatusBanner
                  setupStatus={setupStatus}
                  setupStatusClasses={setupStatusClasses}
                  setupSteps={setupSteps}
                  hasRegisteredAuthorization={hasRegisteredAuthorization}
                  agentChainId={agentChainId}
                  selectedAuthorizationStatus={selectedAuthorizationStatus}
                />

                <div>
                  <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                    EOA Address
                  </label>
                  <div className="mt-1 flex items-center gap-3">
                    <p className="break-all font-mono text-sm text-brand-text flex-1">
                      {wallet.walletAddress ?? 'Create an agent EOA to finish setup'}
                    </p>
                    {wallet.walletAddress && (
                      <CopyButton text={wallet.walletAddress} className="shrink-0" />
                    )}
                    <button
                      type="button"
                      disabled={!wallet.walletAddress}
                      onClick={() => setShowWithdraw((v) => !v)}
                      className="shrink-0 rounded-full border border-brand-border p-1.5 text-brand-text hover:bg-brand-bg transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {showWithdraw ? <X className="h-4 w-4" /> : <BanknoteArrowUp className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                {wallet.agentWalletAddress && (
                  <div className="rounded-xl border border-brand-border/60 bg-brand-bg/30 p-4 text-sm">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                        Authorized Signer
                      </span>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-brand-muted ring-1 ring-brand-border/60">
                          {wallet.chainAuthorizations.length} network
                          {wallet.chainAuthorizations.length === 1 ? '' : 's'} configured
                        </span>
                        {authorizedChainIdsText && (
                          <CopyButton
                            text={authorizedChainIdsText}
                            className="h-7 w-7 border-brand-border/80 bg-white text-brand-muted hover:text-brand-accent"
                          />
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 break-all font-mono text-xs text-brand-text">
                        {wallet.agentWalletAddress}
                      </code>
                      <CopyButton text={wallet.agentWalletAddress} className="shrink-0" />
                    </div>
                    <AuthorizationBadges authorizations={wallet.chainAuthorizations} />
                  </div>
                )}

                {!wallet.walletAddress && (
                  <Step1CreateEoa
                    recoveryPassword={recoveryPassword}
                    showRecoveryPassword={showRecoveryPassword}
                    setRecoveryPassword={setRecoveryPassword}
                    setShowRecoveryPassword={setShowRecoveryPassword}
                    walletSetupLoading={walletSetupLoading}
                    walletSetupError={walletSetupError}
                    onSubmit={handleConnectWallet}
                  />
                )}

                {wallet.walletAddress && (
                  <Step2AuthorizeAccess
                    walletAddress={wallet.walletAddress}
                    agentChainId={agentChainId}
                    setAgentChainId={setAgentChainId}
                    agentChainName={agentChainName}
                    agentNativeSymbol={agentNativeSymbol}
                    isSelectedChainRegistered={isSelectedChainRegistered}
                    selectedAuthorizationStatus={selectedAuthorizationStatus}
                    shouldPromptReauthorization={shouldPromptReauthorization}
                    selectedAuthorizationExpiry={selectedAuthorizationExpiry}
                    selectedAuthorizationExpiryClasses={selectedAuthorizationExpiryClasses}
                    walletSetupError={walletSetupError}
                    walletSetupSuccess={walletSetupSuccess}
                    walletExplorerUrl={walletExplorerUrl}
                    agentGasHelpUrl={agentGasHelpUrl}
                    pendingAuthorizationTxHash={pendingAuthorization?.registrationTxHash ?? null}
                    pendingAuthorizationExplorerUrl={pendingAuthorizationExplorerUrl}
                    agentRegistrationCheckStatus={agentRegistrationCheckStatus}
                    isAgentRegistrationChecking={isAgentRegistrationChecking}
                    registrationBusy={registrationBusy}
                    showAgentRegistrationSpinner={showAgentRegistrationSpinner}
                    authorizeSubmitDisabled={authorizeSubmitDisabled}
                    recoveryPassword={recoveryPassword}
                    showRecoveryPassword={showRecoveryPassword}
                    setRecoveryPassword={setRecoveryPassword}
                    setShowRecoveryPassword={setShowRecoveryPassword}
                    agentExpiryLocal={agentExpiryLocal}
                    setAgentExpiryLocal={setAgentExpiryLocal}
                    onSubmit={handleRegisterAgent}
                    onRetryCheck={handleRetryAgentRegistrationCheck}
                  />
                )}

                <BalanceDisplay
                  balances={balances}
                  balancesLoading={balancesLoading}
                  balancesError={balancesError}
                  selectedChainId={selectedChainId}
                  setSelectedChainId={setSelectedChainId}
                  onRetryBalances={retryBalances}
                />

                {showWithdraw && (
                  <WithdrawForm
                    to={to}
                    amount={amount}
                    token={token}
                    selectedChainId={selectedChainId}
                    withdrawLoading={withdrawLoading}
                    withdrawResult={withdrawResult}
                    withdrawError={withdrawError}
                    withdrawExplorerUrl={withdrawExplorerUrl}
                    setTo={setTo}
                    setAmount={setAmount}
                    setToken={setToken}
                    setSelectedChainId={setSelectedChainId}
                    onSubmit={handleWithdraw}
                    onReset={resetWithdrawForm}
                  />
                )}
              </div>
            </DashboardCard>
          )}
        </>
      )}
    </DashboardPage>
  );
}
