import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccountTypeEnum,
  RecoveryMethod,
  use7702Authorization,
  useOpenfort,
  useUser,
} from '@openfort/react';
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
  addWithdrawalAddressAuth,
  getBalancesAuth,
  getApiErrorMessage,
  hasApiErrorCode,
  listWithdrawalAddressesAuth,
  removeWithdrawalAddressAuth,
  type AuthSessionResponse,
  type BalanceChain,
  type ListWithdrawalAddressesResponse,
  type WalletInfo,
  type WithdrawalToken,
} from '@/lib/api';
import {
  SUPPORTED_CHAINS,
  getChainGasHelpUrl,
  getExplorerAddressUrl,
  getExplorerTransactionUrl,
  getNativeCurrencySymbol,
} from '@/lib/chains';
import {
  CALIBUR_ADDRESSES,
  CALIBUR_DELEGATION_CODES,
  KeyType,
  createCaliburAccount,
  encodeRegisterKey,
  encodeSelfCall,
  encodeUpdateKeySettings,
  hashKey,
  type CaliburKey,
} from '@/lib/calibur';
import { AlertCircle, RotateCcw } from 'lucide-react';
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
import { getDashboardStepUpToken } from './step-up-session';
import { isMonadChain } from '@/lib/chains';
import { resolveCaliburDeployment } from '@/lib/calibur-deployment';
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
  assertWebCryptoAvailable,
  delay,
  formatAuthorizationExpiry,
  getDefaultAgentExpiryLocal,
  getMonadPimlicoRpcUrl,
  getOpenfortSignerChainId,
  getUserOperationGasPrice,
  getStoredChainId,
  parseWithdrawalAmount,
  persistChainId,
  type WithdrawError,
  type WithdrawSuccess,
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
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [selectedWalletId, setSelectedWalletId] = useState('');
  const walletList = wallets.length ? wallets : (wallet ? [wallet] : []);
  const selectedWallet = walletList.find((item) => item.id === selectedWalletId) ?? (selectedWalletId ? null : walletList[0] ?? null);
  const [apiKeyDisplay, setApiKeyDisplay] = useState<string | null>(null);
  const [selectedChainId, setSelectedChainId] = useState(() =>
    getStoredChainId(BALANCE_CHAIN_STORAGE_KEY, DEFAULT_CHAIN_ID),
  );
  const [agentChainId, setAgentChainId] = useState(() =>
    getStoredChainId(AGENT_CHAIN_STORAGE_KEY, DEFAULT_CHAIN_ID),
  );
  const selectedAuthorization = selectedWallet?.chainAuthorizations.find(
    (authorization) => authorization.chainId === agentChainId,
  );
  const selectedAuthorizationExpiry = formatAuthorizationExpiry(selectedAuthorization?.expiresAt);
  const pendingAuthorization = selectedWallet?.chainAuthorizations.find(
    (authorization) =>
      authorization.status === 'pending_registration' && authorization.registrationTxHash,
  );
  const hasRegisteredAuthorization =
    selectedWallet?.chainAuthorizations.some((authorization) => authorization.status === 'registered') ??
    false;
  const agentRegistrationChainId = pendingAuthorization?.chainId ?? agentChainId;
  const walletExplorerUrl = getExplorerAddressUrl(agentChainId, selectedWallet?.walletAddress);
  const pendingAuthorizationExplorerUrl = getExplorerTransactionUrl(
    agentRegistrationChainId,
    pendingAuthorization?.registrationTxHash,
  );
  const agentGasHelpUrl = getChainGasHelpUrl(agentChainId);
  const authorizedChainIdsText =
    selectedWallet?.chainAuthorizations.map((authorization) => authorization.chainId).join(', ') ?? '';
  const publicClient = usePublicClient({ chainId: agentRegistrationChainId });
  const { signAuthorization: signOpenfortAuthorization } = use7702Authorization();
  const signerChainId = getOpenfortSignerChainId(agentChainId);
  const embeddedWallet = useEthereumEmbeddedWallet({ chainId: signerChainId });
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
  const [token, setToken] = useState<WithdrawalToken>('USDC');
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [withdrawResult, setWithdrawResult] = useState<WithdrawSuccess | null>(null);
  const [withdrawError, setWithdrawError] = useState<WithdrawError | null>(null);
  const [withdrawalAllowlist, setWithdrawalAllowlist] =
    useState<ListWithdrawalAddressesResponse | null>(null);
  const [withdrawalAllowlistLoading, setWithdrawalAllowlistLoading] = useState(false);
  const [withdrawalAllowlistError, setWithdrawalAllowlistError] = useState<string | null>(null);
  const [newWithdrawalAddress, setNewWithdrawalAddress] = useState('');
  const [newWithdrawalAddressLabel, setNewWithdrawalAddressLabel] = useState('');
  const [withdrawalAddressLoadingId, setWithdrawalAddressLoadingId] = useState<string | null>(null);
  const withdrawExplorerUrl = withdrawResult
    ? getExplorerTransactionUrl(withdrawResult.chainId, withdrawResult.transactionHash)
    : null;

  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [addWalletPassword, setAddWalletPassword] = useState('');
  const [addWalletPasswordConfirm, setAddWalletPasswordConfirm] = useState('');
  const [showAddWalletForm, setShowAddWalletForm] = useState(false);
  const [pendingCreatedAccount, setPendingCreatedAccount] = useState<{ address: Address; accountId: string } | null>(null);
  const pendingCreatedAccountRef = useRef<{ address: Address; accountId: string } | null>(null);
  const createInFlightRef = useRef(false);
  const registerAgentInFlightRef = useRef(false);
  const createOutcomeUnknownRef = useRef(false);
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
          return await markAgentRegistrationResult(getToken, { chainId, txHash, status, walletId: selectedWalletId });
        } catch (err: unknown) {
          if (
            status === 'registration_failed' ||
            !hasApiErrorCode(err, 'AGENT_REGISTRATION_PENDING')
          ) {
            throw err;
          }
          await delay(AGENT_REGISTRATION_RESULT_RETRY_DELAY_MS);
        }
      }

      return null;
    },
    [getToken, selectedWalletId],
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
    [
      confirmAgentRegistration,
      pendingAuthorization?.chainId,
      pendingAuthorization?.registrationTxHash,
      publicClient,
    ],
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
        const list = result.wallets?.length ? result.wallets : [result.wallet];
        setWallets(list);
        const current = list.find((item) => item.isDefault) ?? result.wallet;
        setWallet(current);
        setSelectedWalletId(current.id);
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
    if (!user || !selectedWallet?.walletAddress) {
      setBalances(null);
      setBalancesError(null);
      return;
    }

    const controller = new AbortController();
    setBalancesLoading(true);
    setBalancesError(null);
    getBalancesAuth(getToken, selectedChainId, controller.signal, selectedWallet.id)
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
  }, [user, selectedChainId, selectedWallet?.id, selectedWallet?.walletAddress, getToken, balanceRefreshNonce]);

  const loadWithdrawalAllowlist = useCallback(
    async (signal?: AbortSignal) => {
      if (!user || !selectedWallet?.walletAddress) {
        setWithdrawalAllowlist(null);
        setWithdrawalAllowlistError(null);
        return;
      }

      setWithdrawalAllowlistLoading(true);
      setWithdrawalAllowlistError(null);
      try {
        const data = await listWithdrawalAddressesAuth(getToken, signal, selectedWallet?.id);
        if (!signal?.aborted) setWithdrawalAllowlist(data);
      } catch (err: unknown) {
        if (!signal?.aborted) setWithdrawalAllowlistError(getApiErrorMessage(err));
      } finally {
        if (!signal?.aborted) setWithdrawalAllowlistLoading(false);
      }
    },
    [getToken, user, selectedWallet?.walletAddress, selectedWallet?.id],
  );

  useEffect(() => {
    if (!showWithdraw) return;
    const controller = new AbortController();
    loadWithdrawalAllowlist(controller.signal);
    return () => controller.abort();
  }, [loadWithdrawalAllowlist, showWithdraw]);

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
          const updated = result.wallets?.find((item) => item.id === selectedWalletId) ?? (result.wallet.id === selectedWalletId ? result.wallet : null);
          if (!updated) throw new Error('The selected wallet was not returned by the server. Refresh wallet state.');
          setWallets(result.wallets?.length ? result.wallets : [result.wallet]); setWallet(updated);
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
  }, [
    user,
    selectedWalletId,
    publicClient,
    pendingAuthorization?.chainId,
    pendingAuthorization?.registrationTxHash,
    confirmAgentRegistration,
  ]);

  async function handleRetryAgentRegistrationCheck() {
    setAgentRegistrationCheckStatus('checking');
    setWalletSetupError(null);
    setWalletSetupSuccess(null);

    try {
      const result = await checkPendingAgentRegistration(AGENT_REGISTRATION_MANUAL_CHECK_MS);
      if (result) {
        const updated = result.wallets?.find((item) => item.id === selectedWalletId) ?? (result.wallet.id === selectedWalletId ? result.wallet : null);
        if (!updated) throw new Error('The selected wallet was not returned by the server. Refresh wallet state.');
        setWallets(result.wallets?.length ? result.wallets : [result.wallet]); setWallet(updated);
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
      const baseUnits = parseWithdrawalAmount(amount, token);
      const chainId = selectedChainId;
      const stepUpToken = getDashboardStepUpToken() ?? (await requestStepUpToken(getToken));
      if (!selectedWallet?.id) throw new Error('Select the wallet to withdraw from.');
      const result = await withdrawAuth(getToken, to, baseUnits, token, chainId, stepUpToken, selectedWallet.id);
      setWithdrawResult({
        message: `Transaction submitted: ${result.transactionHash || result.transactionId}`,
        transactionHash: result.transactionHash,
        chainId,
      });
      setTo('');
      setAmount('');
    } catch (err: unknown) {
      // Only treat the explicit billing block code as unpaid-invoice guidance.
      // Network/unknown failures keep the generic message with no Billing CTA.
      setWithdrawError({
        message: getApiErrorMessage(err),
        billingBlocked: hasApiErrorCode(err, 'BILLING_OUTBOUND_BLOCKED'),
      });
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

  async function handleAddWithdrawalAddress(e: React.FormEvent) {
    e.preventDefault();
    setWithdrawalAddressLoadingId('new');
    setWithdrawalAllowlistError(null);

    try {
      const stepUpToken = getDashboardStepUpToken() ?? (await requestStepUpToken(getToken));
      await addWithdrawalAddressAuth(
        getToken,
        {
          address: newWithdrawalAddress,
          label: newWithdrawalAddressLabel || undefined,
        },
        stepUpToken,
      );
      setNewWithdrawalAddress('');
      setNewWithdrawalAddressLabel('');
      await loadWithdrawalAllowlist();
    } catch (err: unknown) {
      setWithdrawalAllowlistError(getApiErrorMessage(err));
    } finally {
      setWithdrawalAddressLoadingId(null);
    }
  }

  async function handleRemoveWithdrawalAddress(id: string) {
    setWithdrawalAddressLoadingId(id);
    setWithdrawalAllowlistError(null);

    try {
      const stepUpToken = getDashboardStepUpToken() ?? (await requestStepUpToken(getToken));
      await removeWithdrawalAddressAuth(getToken, id, stepUpToken);
      await loadWithdrawalAllowlist();
    } catch (err: unknown) {
      setWithdrawalAllowlistError(getApiErrorMessage(err));
    } finally {
      setWithdrawalAddressLoadingId(null);
    }
  }

  async function handleConnectWallet(password: string, createNew: boolean): Promise<boolean> {
    if (createInFlightRef.current) return false;
    const knownCreatedAccount = pendingCreatedAccountRef.current ?? pendingCreatedAccount;
    const creatingNew = createNew || Boolean(knownCreatedAccount);
    if (createOutcomeUnknownRef.current) {
      setWalletSetupError('Openfort account creation could not be confirmed. Do not retry account creation; contact support.');
      return false;
    }
    createInFlightRef.current = true;
    setWalletSetupLoading(true);
    setWalletSetupError(null);
    setWalletSetupSuccess(null);

    try {
      assertWebCryptoAvailable();
      if (password.length < 8) {
        throw new Error('Use a wallet recovery password with at least 8 characters.');
      }

      if (!createNew && selectedWallet?.provisioningStatus && selectedWallet.provisioningStatus !== 'completed') throw new Error('This wallet has a provisioning attempt in progress or under review. Do not retry this wallet; wait for review.');
      let createdAccount: unknown;
      let refreshedAccounts: unknown[] | undefined;
      if (creatingNew && !knownCreatedAccount) {
        try {
          createdAccount = await embeddedWallet.create({
          chainId: signerChainId,
          accountType: AccountTypeEnum.EOA,
          recoveryMethod: RecoveryMethod.PASSWORD,
          password,
          });
        } catch (error) {
          createOutcomeUnknownRef.current = true;
          throw new Error(`Openfort could not confirm account creation: ${getApiErrorMessage(error)}. Do not retry account creation; contact support.`);
        }
        const providerCreated = createdAccount as { id?: string; accountId?: string; address?: string; accounts?: Array<{ id?: string; address?: string }> } | undefined;
        const createdAddress = providerCreated?.address ?? providerCreated?.accounts?.[0]?.address;
        const createdId = providerCreated?.id ?? providerCreated?.accountId ?? providerCreated?.accounts?.[0]?.id;
        if (!createdAddress || !createdId || !/^0x[0-9a-fA-F]{40}$/.test(createdAddress)) {
          createOutcomeUnknownRef.current = true;
          throw new Error('Openfort did not return a complete new account identity. Do not retry account creation; contact support.');
        }
        const identity = { address: createdAddress as Address, accountId: createdId };
        pendingCreatedAccountRef.current = identity;
        setPendingCreatedAccount(identity);
      }
      try {
        refreshedAccounts = await openfort.updateEmbeddedAccounts({ silent: true });
      } catch (error) {
        throw new Error(`Openfort could not refresh embedded accounts: ${getApiErrorMessage(error)}. The created account identity is retained; retry to continue without creating another account.`);
      }

      const refreshedMatch = (refreshedAccounts ?? []).map((value) => value as { id?: string; accountId?: string; address?: string }).filter((item) => item.address);
      let address: Address;
      let accountId: string | undefined;
      if (creatingNew && knownCreatedAccount) {
        address = knownCreatedAccount.address; accountId = knownCreatedAccount.accountId;
        const found = refreshedMatch.find((item) => item.address?.toLowerCase() === address.toLowerCase() && (item.id ?? item.accountId) === accountId);
        if (!found) throw new Error('The newly created account is not yet visible in Openfort. Do not create another wallet; refresh and try connecting again.');
      } else if (creatingNew) {
        const created = createdAccount as { id?: string; accountId?: string; address?: string; accounts?: Array<{ id?: string; address?: string }> } | undefined;
        const createdAddress = created?.address ?? created?.accounts?.[0]?.address;
        const createdId = created?.id ?? created?.accountId ?? created?.accounts?.[0]?.id;
        if (!createdAddress || !createdId) throw new Error('Openfort did not return a complete new account identity. Do not create another account; refresh and contact support if it remains unavailable.');
        const exact = refreshedMatch.find((item) => item.address?.toLowerCase() === createdAddress.toLowerCase() && (item.id ?? item.accountId) === createdId);
        if (!exact) throw new Error('Openfort could not verify the newly created account. Do not create another account; refresh and contact support if it remains unavailable.');
        address = exact.address as Address; accountId = exact.id ?? exact.accountId;
        const identity = { address, accountId: accountId! };
        pendingCreatedAccountRef.current = identity;
        setPendingCreatedAccount(identity);
      } else {
        const selectedAddress = selectedWallet?.walletAddress ?? embeddedWallet.address;
        const requested = refreshedMatch.filter((item) => item.address?.toLowerCase() === selectedAddress?.toLowerCase() && (!selectedWallet?.openfortAccountId || (item.id ?? item.accountId) === selectedWallet.openfortAccountId));
        if (requested.length !== 1) throw new Error('Could not identify the selected existing account in Openfort. No wallet was authorized.');
        address = requested[0].address as Address; accountId = requested[0].id ?? requested[0].accountId;
      }
      if (creatingNew && walletList.some((item) => item.walletAddress?.toLowerCase() === address.toLowerCase())) throw new Error('Openfort returned an account already linked to a SOFA wallet. No duplicate wallet was added.');
      await embeddedWallet.setActive({ address, chainId: signerChainId, recoveryMethod: RecoveryMethod.PASSWORD, password });

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

      const list = authorized.wallets?.length ? authorized.wallets : [authorized.wallet];
      setWallets(list);
      const created = list.find((item) => item.walletAddress?.toLowerCase() === address.toLowerCase());
      if (!created) throw new Error('The server did not return the wallet matching this verified Openfort account. Refresh before continuing.');
      setWallet(created); setSelectedWalletId(created.id);
      const retainedIdentity = pendingCreatedAccountRef.current;
      if (creatingNew && retainedIdentity && created.walletAddress?.toLowerCase() === retainedIdentity.address.toLowerCase() && (!accountId || accountId === retainedIdentity.accountId)) { pendingCreatedAccountRef.current = null; setPendingCreatedAccount(null); createOutcomeUnknownRef.current = false; }
      setWalletSetupSuccess(
        'Agent wallet created. Choose a network below, add gas, then authorize API access.',
      );
      return true;
    } catch (err: unknown) {
      setWalletSetupError(getApiErrorMessage(err));
      if (creatingNew && /provision|review|uncertain/i.test(getApiErrorMessage(err))) setWalletSetupError(`${getApiErrorMessage(err)} Do not repeat this creation; wait for review.`);
      return false;
    } finally {
      createInFlightRef.current = false;
      setWalletSetupLoading(false);
    }
  }

  async function handleRegisterAgent(e: React.FormEvent) {
    e.preventDefault();
    if (registerAgentInFlightRef.current) return;
    registerAgentInFlightRef.current = true;
    setWalletSetupLoading(true);
    setWalletSetupError(null);
    setWalletSetupSuccess(null);

    try {
      assertWebCryptoAvailable();
      if (!selectedWallet?.walletAddress || !selectedWallet.agentWalletAddress || !selectedWallet.agentKeyHash) {
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

      let address = selectedWallet.walletAddress as Address;
      const accounts = await openfort.updateEmbeddedAccounts({ silent: true });
      const matching = (accounts ?? []).filter((candidate) => String((candidate as { address?: string }).address ?? '').toLowerCase() === address.toLowerCase()) as Array<{ id?: string; accountId?: string; address: string }>;
      const selectedAccount = matching.find((candidate) => !selectedWallet.openfortAccountId || (candidate.id ?? candidate.accountId) === selectedWallet.openfortAccountId);
      if (!selectedAccount || matching.length !== 1) throw new Error('The selected wallet could not be matched to exactly one Openfort account. No authorization was signed.');
      await embeddedWallet.setActive({ address, chainId: signerChainId, recoveryMethod: RecoveryMethod.PASSWORD, password: recoveryPassword });
      const verifyActiveAccount = async () => {
        try {
          const provider = await openfort.client.embeddedWallet.getEthereumProvider();
          const accounts = await provider.request({ method: 'eth_accounts' });
          const first = Array.isArray(accounts) ? accounts[0] : undefined;
          if (typeof first !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(first) || first.toLowerCase() !== address.toLowerCase()) throw new Error();
        } catch {
          throw new Error('Openfort could not confirm the selected wallet is active. No authorization was signed.');
        }
      };
      await verifyActiveAccount();
      const walletAddressChanged = false;
      let authorization = walletAddressChanged ? undefined : selectedAuthorization;
      let currentWallet: WalletInfo | null = selectedWallet;
      if (
        !authorization ||
        authorization.status === 'registered' ||
        authorization.status === 'registration_failed'
      ) {
        const initialized = await authorizeEmbeddedWallet(getToken, {
          embeddedWalletAddress: address,
          embeddedOpenfortAccountId: selectedAccount.id ?? selectedAccount.accountId,
          chainId: agentChainId,
          agentExpiresAt: agentExpiresAt.toISOString(),
        });
        currentWallet = initialized.wallets?.find((item) => item.id === selectedWallet.id) ?? (initialized.wallet.id === selectedWallet.id ? initialized.wallet : null);
        if (!currentWallet) throw new Error('The server did not return the selected wallet after authorization. Refresh and retry.');
        if (currentWallet.walletAddress?.toLowerCase() !== address.toLowerCase()) {
          throw new Error('The server returned a different wallet identity after authorization. No registration was signed.');
        }
        setWallets(initialized.wallets?.length ? initialized.wallets : [initialized.wallet]);
        setWallet(currentWallet);
        address = currentWallet.walletAddress as Address;
        authorization = currentWallet.chainAuthorizations.find(
          (item) => item.chainId === agentChainId,
        );
      }

      if (!authorization?.expiresAt) {
        throw new Error('Missing authorization expiry. Please retry.');
      }

      if (!publicClient) {
        throw new Error(
          'Cannot check gas balance for this chain. Please retry after the network is ready.',
        );
      }

      if (publicClient.chain?.id !== undefined && publicClient.chain.id !== agentChainId) {
        throw new Error(`Calibur RPC client chain ${publicClient.chain.id} does not match requested chain ${agentChainId}.`);
      }

      const walletCode = await publicClient.getCode({ address });
      const hasWalletCode = Boolean(walletCode && walletCode !== '0x');
      const delegatedIndex = hasWalletCode
        ? CALIBUR_DELEGATION_CODES.findIndex(
            (delegationCode) => walletCode!.toLowerCase() === delegationCode.toLowerCase(),
          )
        : -1;
      if (hasWalletCode && delegatedIndex < 0) {
        throw new Error(
          'This wallet is delegated to an unsupported contract. Please contact support.',
        );
      }
      const activeCaliburAddress = hasWalletCode
        ? CALIBUR_ADDRESSES[delegatedIndex]
        : await resolveCaliburDeployment(agentChainId, publicClient);
      if (!activeCaliburAddress) {
        throw new Error(
          `${agentChainName} is not available for API access yet because Calibur is not deployed on this network.`,
        );
      }

      const feeSponsorshipId = import.meta.env.VITE_OPENFORT_FEE_SPONSORSHIP_ID;
      const hasFeeSponsorship = Boolean(feeSponsorshipId && !isMonadChain(agentChainId));
      if (!hasFeeSponsorship) {
        const nativeBalance = await publicClient.getBalance({ address });
        if (nativeBalance === 0n) {
          throw new Error(
            `Your wallet has no ${agentNativeSymbol} for gas. Deposit ${agentNativeSymbol} to ${address} and retry agent registration.`,
          );
        }
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

      const eip7702Authorization =
        !hasWalletCode
          ? await (async () => {
              await verifyActiveAccount();
              return signOpenfortAuthorization({
              chainId: agentChainId,
              nonce: await publicClient.getTransactionCount({ address, blockTag: 'pending' }),
              contractAddress: activeCaliburAddress,
              });
            })()
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
          throw new Error(
            'Openfort embedded wallet transaction signing is not used for Calibur UserOperations.',
          );
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
      const caliburAccount = await createCaliburAccount({
        client: publicClient,
        owner,
        authorizationAddress: activeCaliburAddress,
      });
      const usePimlico = isMonadChain(agentChainId);
      const openfortPublishableKey = import.meta.env.VITE_OPENFORT_PUBLISHABLE_KEY;
      if (!usePimlico && !openfortPublishableKey) {
        throw new Error('Openfort publishable key is not configured.');
      }
      const bundlerRpcUrl = usePimlico
        ? getMonadPimlicoRpcUrl(agentChainId)
        : `https://api.openfort.io/rpc/${agentChainId}`;
      const bundlerRpcTransport = http(
        bundlerRpcUrl,
        usePimlico
          ? undefined
          : { fetchOptions: { headers: { Authorization: `Bearer ${openfortPublishableKey}` } } },
      );
      const paymaster =
        hasFeeSponsorship
          ? createPaymasterClient({ transport: bundlerRpcTransport })
          : undefined;
      const bundlerClient = createBundlerClient({
        account: caliburAccount,
        chain: publicClient.chain,
        client: publicClient,
        ...(paymaster ? { paymaster } : {}),
        transport: bundlerRpcTransport,
      } as never);
      const fees = await getUserOperationGasPrice(
        agentChainId,
        bundlerRpcUrl,
        openfortPublishableKey,
      );
      const userOpHash = await bundlerClient.sendUserOperation({
        account: caliburAccount,
        calls: registrationCalls,
        ...(eip7702Authorization ? { authorization: eip7702Authorization } : {}),
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        ...(hasFeeSponsorship
          ? { paymasterContext: { policyId: feeSponsorshipId } }
          : {}),
      } as never);
      const userOpReceipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });
      const txHash =
        (userOpReceipt as { receipt?: { transactionHash?: Hex }; transactionHash?: Hex }).receipt
          ?.transactionHash ?? (userOpReceipt as { transactionHash?: Hex }).transactionHash;
      if (!txHash) {
        throw new Error(
          `Agent registration UserOperation was submitted but no transaction hash was returned: ${userOpHash}`,
        );
      }
      const pending = await markAgentRegistrationTransaction(getToken, {
        chainId: agentChainId,
        txHash,
        walletId: selectedWallet?.id,
      });
      const pendingWallet = pending.wallets?.find((item) => item.id === selectedWallet.id) ?? (pending.wallet.id === selectedWallet.id ? pending.wallet : null);
      if (!pendingWallet) throw new Error('The selected wallet was not returned by the server. Refresh wallet state.');
      setWallets(pending.wallets?.length ? pending.wallets : [pending.wallet]); setWallet(pendingWallet);

      let result: AuthSessionResponse | null;
      try {
        let attempts = 0;
        result = await confirmAgentRegistration(
          publicClient,
          agentChainId,
          txHash,
          () => attempts++ < 3,
        );
      } catch {
        setWalletSetupSuccess(`Authorization pending. We will check again next time: ${txHash}`);
        return;
      }

      if (!result) {
        setAgentRegistrationCheckStatus('timed_out');
        setWalletSetupSuccess(`Authorization pending. We are still checking on-chain: ${txHash}`);
        return;
      }

      const updated = result.wallets?.find((item) => item.id === selectedWallet.id) ?? (result.wallet.id === selectedWallet.id ? result.wallet : null);
      if (!updated) throw new Error('The selected wallet was not returned by the server. Refresh wallet state.');
      setWallets(result.wallets?.length ? result.wallets : [result.wallet]); setWallet(updated);
      setAgentRegistrationCheckStatus('idle');
      const confirmedAuthorization = updated.chainAuthorizations.find(
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
      registerAgentInFlightRef.current = false;
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
  const authorizeSubmitDisabled = registrationBusy;
  const showAgentRegistrationSpinner =
    walletSetupLoading || agentRegistrationCheckStatus === 'checking';
  const setupStatus = !selectedWallet?.walletAddress
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
            description: 'The authorization transaction was submitted and is being checked.',
          }
        : {
            title: 'Authorize API access',
            tone: 'blue',
            description: 'Choose a network, add gas, unlock the wallet, and authorize API access.',
          };
  const setupStatusClasses =
    setupStatus.tone === 'green'
      ? 'border-green-200 bg-green-50 text-green-800'
      : setupStatus.tone === 'blue'
        ? 'border-blue-200 bg-blue-50 text-blue-800'
        : 'border-amber-200 bg-amber-50 text-amber-800';
  const setupPhase = !selectedWallet?.walletAddress ? 1 : hasRegisteredAuthorization ? 3 : 2;
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
      description="Manage your secure wallets, authorize API access, then use API keys from your backend."
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
          {walletList.length > 1 && (
            <section className="mb-5 rounded-2xl border border-brand-border bg-white p-5 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div><p className="text-xs font-bold uppercase tracking-[.18em] text-brand-muted">Your wallets</p><h2 className="mt-1 text-lg font-semibold text-brand-text">Choose a wallet to manage</h2></div>
                <select aria-label="Selected wallet" value={selectedWallet?.id ?? ''} onChange={(event) => { const chosen = walletList.find((item) => item.id === event.target.value); if (chosen) { setSelectedWalletId(chosen.id); setWallet(chosen); setBalances(null); setBalancesError(null); setWithdrawalAllowlist(null); setWithdrawalAllowlistError(null); setShowWithdraw(false); setWithdrawResult(null); setWithdrawError(null); } }} className="min-w-0 rounded-xl border border-brand-border bg-brand-bg px-3 py-2.5 font-mono text-sm sm:w-[27rem]">
                  {walletList.map((item, index) => <option key={item.id} value={item.id}>{item.walletAddress ?? `Wallet ${index + 1} · setup needed`}{item.isDefault ? ' · default' : ''}</option>)}
                </select>
              </div>
              <p className="mt-3 text-sm text-brand-muted">Balances and withdrawals below are scoped to this wallet. API access authorization is also set up per wallet.</p>
            </section>
          )}
          {selectedWallet?.provisioningStatus === 'uncertain' && <div role="status" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"><strong>This wallet setup needs review.</strong> Openfort may have created this account, but we could not confirm the result. Do not retry this wallet; support must review it first. You may still add a different wallet.</div>}
          {walletList.length > 1 && <p className="mb-3 text-xs text-brand-muted">{walletList.length} wallets linked to your account.</p>}
          {apiKeyDisplay && (
            <ApiKeyBanner apiKeyDisplay={apiKeyDisplay} onDismiss={() => setApiKeyDisplay(null)} />
          )}

          {wallet && selectedWallet && (
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
                      {selectedWallet.walletAddress ?? 'Create an agent EOA to finish setup'}
                    </p>
                    {selectedWallet.walletAddress && (
                      <CopyButton text={selectedWallet.walletAddress} className="shrink-0" />
                    )}
                  </div>
                </div>

                {selectedWallet.agentWalletAddress && (
                  <div className="rounded-xl border border-brand-border/60 bg-brand-bg/30 p-4 text-sm">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                        Authorized Signer
                      </span>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-brand-muted ring-1 ring-brand-border/60">
                          {selectedWallet.chainAuthorizations.length} network
                          {selectedWallet.chainAuthorizations.length === 1 ? '' : 's'} configured
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
                        {selectedWallet.agentWalletAddress}
                      </code>
                      <CopyButton text={selectedWallet.agentWalletAddress} className="shrink-0" />
                    </div>
                    <AuthorizationBadges authorizations={selectedWallet.chainAuthorizations} />
                  </div>
                )}

                {!selectedWallet.walletAddress && (
                  <Step1CreateEoa
                    recoveryPassword={recoveryPassword}
                    showRecoveryPassword={showRecoveryPassword}
                    setRecoveryPassword={setRecoveryPassword}
                    setShowRecoveryPassword={setShowRecoveryPassword}
                    walletSetupLoading={walletSetupLoading}
                    walletSetupError={walletSetupError}
                    onSubmit={(event) => { event.preventDefault(); void handleConnectWallet(recoveryPassword, !embeddedWallet.address); }}
                  />
                )}

                {selectedWallet.walletAddress && <div className="rounded-xl border border-brand-border bg-brand-bg/40 p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="text-sm font-semibold text-brand-text">Need a separate wallet?</h3><p className="mt-1 text-sm text-brand-muted">Create a new Openfort account with its own recovery password.</p></div><button type="button" disabled={walletSetupLoading || showAddWalletForm || (selectedWallet.provisioningStatus != null && selectedWallet.provisioningStatus !== 'completed')} onClick={() => { setWalletSetupError(null); setShowAddWalletForm(true); }} className="rounded-full bg-brand-accent px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">Add wallet</button></div>{showAddWalletForm && <form onSubmit={(event) => { event.preventDefault(); if (addWalletPassword !== addWalletPasswordConfirm) { setWalletSetupError('Passwords do not match.'); return; } void handleConnectWallet(addWalletPassword, true).then((created) => { if (!created) return; setShowAddWalletForm(false); setAddWalletPassword(''); setAddWalletPasswordConfirm(''); }); }} className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold text-brand-muted">New wallet recovery password<input type="password" autoComplete="new-password" value={addWalletPassword} onChange={(event) => setAddWalletPassword(event.target.value)} className="mt-1 block w-full rounded-lg border border-brand-border bg-white px-3 py-2 text-sm" minLength={8} required /></label><label className="text-xs font-semibold text-brand-muted">Confirm password<input type="password" autoComplete="new-password" value={addWalletPasswordConfirm} onChange={(event) => setAddWalletPasswordConfirm(event.target.value)} className="mt-1 block w-full rounded-lg border border-brand-border bg-white px-3 py-2 text-sm" minLength={8} required /></label><p className="sm:col-span-2 text-xs text-brand-muted">This password unlocks this wallet in Openfort. It is used only in your browser and is never sent to SOFA.</p>{walletSetupError && <p role="alert" className="sm:col-span-2 text-sm text-red-700">{walletSetupError}</p>}<div className="sm:col-span-2 flex gap-2"><button type="submit" disabled={walletSetupLoading} className="rounded-full bg-brand-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{walletSetupLoading ? 'Creating securely…' : 'Create new wallet'}</button><button type="button" onClick={() => { setShowAddWalletForm(false); setWalletSetupError(null); }} className="rounded-full border border-brand-border px-4 py-2 text-sm font-semibold text-brand-text">Cancel</button></div></form>}{walletSetupError && !showAddWalletForm && <p role="alert" className="mt-3 text-sm text-red-700">{walletSetupError}</p>}</div>}

                {selectedWallet.walletAddress && (
                  <Step2AuthorizeAccess
                    walletAddress={selectedWallet.walletAddress}
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
                  canWithdraw={Boolean(selectedWallet.walletAddress)}
                  showWithdraw={showWithdraw}
                  onToggleWithdraw={() => setShowWithdraw((v) => !v)}
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
                    withdrawalAllowlist={withdrawalAllowlist}
                    withdrawalAllowlistLoading={withdrawalAllowlistLoading}
                    withdrawalAllowlistError={withdrawalAllowlistError}
                    newWithdrawalAddress={newWithdrawalAddress}
                    newWithdrawalAddressLabel={newWithdrawalAddressLabel}
                    withdrawalAddressLoadingId={withdrawalAddressLoadingId}
                    withdrawExplorerUrl={withdrawExplorerUrl}
                    nativeCurrencySymbol={getNativeCurrencySymbol(selectedChainId)}
                    setTo={setTo}
                    setAmount={setAmount}
                    setToken={setToken}
                    setSelectedChainId={setSelectedChainId}
                    setNewWithdrawalAddress={setNewWithdrawalAddress}
                    setNewWithdrawalAddressLabel={setNewWithdrawalAddressLabel}
                    onSubmit={handleWithdraw}
                    onAddWithdrawalAddress={handleAddWithdrawalAddress}
                    onRemoveWithdrawalAddress={handleRemoveWithdrawalAddress}
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
