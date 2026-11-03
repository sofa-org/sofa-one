import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppSession } from '@/components/AppSessionProvider';
import EmailOtpForm from '@/pages/EmailOtpForm';
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
  withdrawAuth,
  addWithdrawalAddressAuth,
  getBalancesAuth,
  getApiErrorMessage,
  isApiError,
  getTransactionDetailAuth,
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
  encodeRegisterKey,
  encodeUpdateKeySettings,
  hashKey,
  type CaliburKey,
} from '../../../../src/common/calibur/calibur-primitives';
import { createCaliburAccount, encodeSelfCall } from '@/lib/calibur';
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
import {
  readOperation, saveOperation, clearOperation, isAuthorizationReady, isWithdrawalTerminal,
  type WithdrawalIntent, type RegistrationOperation,
} from './wallet-recovery';

export default function WalletPage() {
  const openfort = useOpenfort();
  const { getAccessToken, isAuthenticated: providerAuthenticated, isLoading: providerLoading } = useUser();
  const { session, loading: authLoading } = useAppSession();
  const user = session;
  const isAuthenticated = Boolean(session);
  const [walletIdentityRequired, setWalletIdentityRequired] = useState(false);
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
  const [now, setNow] = useState(Date.now);
  const [localRegistration, setLocalRegistration] = useState<RegistrationOperation | null>(null);
  const localRegistrationRef = useRef<RegistrationOperation | null>(null);
  const [recoveryStorageError, setRecoveryStorageError] = useState<string | null>(null);
  const [withdrawIntent, setWithdrawIntent] = useState<WithdrawalIntent | null>(null);
  const withdrawIntentRef = useRef<WithdrawalIntent | null>(null);
  const withdrawInFlightRef = useRef(false);
  const ownerRef = useRef('');
  const currentOwner = `${user?.sessionId}:${user?.userId}:${selectedWallet?.id}`;
  ownerRef.current = currentOwner;
  const ownedRegistration = localRegistration && localRegistration.userId === user?.userId && localRegistration.walletId === selectedWallet?.id ? localRegistration : null;
  const ownedWithdrawIntent = withdrawIntent && withdrawIntent.userId === user?.userId && withdrawIntent.walletId === selectedWallet?.id ? withdrawIntent : null;
  const withdrawalAuthorization = selectedWallet?.chainAuthorizations.find((item) => item.chainId === selectedChainId);
  const withdrawalReady = isAuthorizationReady(withdrawalAuthorization, now);
  const selectedAuthorization = selectedWallet?.chainAuthorizations.find(
    (authorization) => authorization.chainId === agentChainId,
  );
  const selectedAuthorizationExpiry = formatAuthorizationExpiry(selectedAuthorization?.expiresAt);
  const pendingAuthorization = selectedWallet?.chainAuthorizations.find(
    (authorization) =>
      authorization.status === 'pending_registration' && authorization.registrationTxHash,
  );
  const hasRegisteredAuthorization =
    selectedWallet?.chainAuthorizations.some((authorization) => isAuthorizationReady(authorization, now)) ??
    false;
  const agentRegistrationChainId = ownedRegistration?.chainId ?? pendingAuthorization?.chainId ?? agentChainId;
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
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    const refresh = () => setNow(Date.now());
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);

  useEffect(() => {
    localRegistrationRef.current = null;
    withdrawIntentRef.current = null;
    setLocalRegistration(null);
    setWithdrawIntent(null);
    setWithdrawResult(null);
    setWithdrawError(null);
    setWalletSetupSuccess(null);
    setWalletSetupError(null);
    setRecoveryPassword('');
    setTo('');
    setAmount('');
    setRecoveryStorageError(null);
    if (!user?.userId || !selectedWallet?.id || !selectedWallet.walletAddress) return;
    try {
      const registration = readOperation<RegistrationOperation>('registration', user.userId, selectedWallet.id, selectedWallet.walletAddress);
      const withdrawal = readOperation<WithdrawalIntent>('withdrawal', user.userId, selectedWallet.id, selectedWallet.walletAddress);
      localRegistrationRef.current = registration;
      setLocalRegistration(registration);
      withdrawIntentRef.current = withdrawal;
      setWithdrawIntent(withdrawal);
      if (withdrawal) setShowWithdraw(true);
    } catch {
      setRecoveryStorageError('Wallet recovery storage is unavailable or invalid. Restore browser storage before submitting; do not create a duplicate operation.');
    }
  }, [user?.sessionId, user?.userId, selectedWallet?.id, selectedWallet?.walletAddress]);

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
          return await markAgentRegistrationResult({ chainId, txHash, status, walletId: selectedWalletId });
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
    [selectedWalletId],
  );

  const checkPendingAgentRegistration = useCallback(
    async (durationMs: number, shouldContinue: () => boolean) => {
      const operation = localRegistrationRef.current;
      if (operation?.userOpHash) {
        try { saveOperation('registration', operation); } catch { /* Retain memory and same-tab backup for retry. */ }
      }
      if (!publicClient) throw new Error('The chain RPC is not ready. Retry check when the network reconnects; do not authorize again.');
      const chainId = operation?.chainId ?? pendingAuthorization?.chainId;
      let txHash = operation?.txHash ?? pendingAuthorization?.registrationTxHash;
      if (!chainId) return null;
      if (publicClient.chain?.id !== undefined && publicClient.chain.id !== chainId) {
        throw new Error('Waiting for the RPC on the pending authorization chain. Retry check; do not authorize again.');
      }
      if (!txHash && operation) {
        if (!operation.userOpHash) throw new Error('The bundler submission outcome is unknown. Do not authorize again. Contact support to recover this wallet and chain operation.');
        const usePimlico = isMonadChain(chainId);
        const publishableKey = import.meta.env.VITE_OPENFORT_PUBLISHABLE_KEY;
        const rpcUrl = usePimlico ? getMonadPimlicoRpcUrl(chainId) : `https://api.openfort.io/rpc/${chainId}`;
        const bundler = createBundlerClient({
          chain: publicClient.chain,
          transport: http(rpcUrl, usePimlico ? undefined : { fetchOptions: { headers: { Authorization: `Bearer ${publishableKey}` } } }),
        });
        const receipt = await bundler.waitForUserOperationReceipt({
          hash: operation.userOpHash as Hex, timeout: AGENT_REGISTRATION_RECEIPT_TIMEOUT_MS,
        });
        txHash = receipt.receipt.transactionHash;
        if (!txHash) throw new Error('UserOperation is still pending. Retry check; do not authorize again.');
        const saved = { ...operation, txHash };
        if (shouldContinue()) localRegistrationRef.current = saved;
        // Keep both hashes in memory even if storage fails; the server can
        // retain the transaction before confirmation is attempted.
        try { saveOperation('registration', saved); } catch { /* Original operation remains reserved. */ }
      }
      if (!txHash || !shouldContinue()) return null;
      if (operation) await markAgentRegistrationTransaction({ chainId, txHash, walletId: operation.walletId });
      const deadline = Date.now() + durationMs;
      const result = await confirmAgentRegistration(publicClient, chainId, txHash as Hex, () => shouldContinue() && Date.now() < deadline);
      if (result && operation) {
        const updated = result.wallets?.find((item) => item.id === operation.walletId) ?? (result.wallet.id === operation.walletId ? result.wallet : null);
        const authorization = updated?.chainAuthorizations.find((item) => item.chainId === chainId);
        if (authorization?.status === 'registered' || authorization?.status === 'registration_failed') {
          clearOperation('registration', operation);
          if (shouldContinue() && localRegistrationRef.current?.userId === operation.userId &&
              localRegistrationRef.current.walletId === operation.walletId) localRegistrationRef.current = null;
        }
      }
      return result;
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
        const result = await getMe(controller.signal);
        if (controller.signal.aborted) return;

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
  }, [authLoading, isAuthenticated, user?.sessionId, walletReloadNonce]);

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
    getBalancesAuth(selectedChainId, controller.signal, selectedWallet.id)
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
  }, [user?.sessionId, selectedChainId, selectedWallet?.id, selectedWallet?.walletAddress, balanceRefreshNonce]);

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
        const data = await listWithdrawalAddressesAuth(signal, selectedWallet?.id);
        if (!signal?.aborted) setWithdrawalAllowlist(data);
      } catch (err: unknown) {
        if (!signal?.aborted) setWithdrawalAllowlistError(getApiErrorMessage(err));
      } finally {
        if (!signal?.aborted) setWithdrawalAllowlistLoading(false);
      }
    },
    [user?.sessionId, selectedWallet?.walletAddress, selectedWallet?.id],
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
    if (!user?.userId || !selectedWalletId || walletSetupLoading || (!ownedRegistration && !pendingAuthorization?.registrationTxHash)) return;
    let cancelled = false;
    const owner = currentOwner;
    const isCurrent = () => !cancelled && ownerRef.current === owner;
    setAgentRegistrationCheckStatus('checking');
    async function resumeAgentRegistrationCheck() {
      try {
        const result = await checkPendingAgentRegistration(AGENT_REGISTRATION_AUTO_CHECK_MS, isCurrent);
        if (!isCurrent()) return;
        if (result) {
          const updated = result.wallets?.find((item) => item.id === selectedWalletId) ?? (result.wallet.id === selectedWalletId ? result.wallet : null);
          if (!updated) throw new Error('The selected wallet was not returned by the server. Refresh wallet state.');
          setWallets(result.wallets?.length ? result.wallets : [result.wallet]);
          setWallet(updated);
          setLocalRegistration(localRegistrationRef.current);
          setAgentRegistrationCheckStatus('idle');
          const authorization = updated.chainAuthorizations.find((item) => item.chainId === agentRegistrationChainId);
          if (isAuthorizationReady(authorization)) setWalletSetupSuccess('API access authorization confirmed.');
          else setWalletSetupError('API access is not ready. The authorization failed or expired; renew it before transacting.');
          return;
        }
        setAgentRegistrationCheckStatus('timed_out');
      } catch (err: unknown) {
        if (!isCurrent()) return;
        setAgentRegistrationCheckStatus('timed_out');
        setWalletSetupError(getApiErrorMessage(err));
      }
    }
    void resumeAgentRegistrationCheck();
    return () => { cancelled = true; };
  }, [user?.sessionId, user?.userId, selectedWalletId, walletSetupLoading,
    ownedRegistration?.userOpHash, ownedRegistration?.chainId,
    pendingAuthorization?.registrationTxHash, checkPendingAgentRegistration, currentOwner, agentRegistrationChainId]);

  async function handleRetryAgentRegistrationCheck() {
    if (agentRegistrationCheckStatus === 'checking') return;
    const owner = currentOwner;
    const isCurrent = () => ownerRef.current === owner;
    setAgentRegistrationCheckStatus('checking');
    setWalletSetupError(null);
    setWalletSetupSuccess(null);
    try {
      const result = await checkPendingAgentRegistration(AGENT_REGISTRATION_MANUAL_CHECK_MS, isCurrent);
      if (!isCurrent()) return;
      if (result) {
        const updated = result.wallets?.find((item) => item.id === selectedWalletId) ?? (result.wallet.id === selectedWalletId ? result.wallet : null);
        if (!updated) throw new Error('The selected wallet was not returned by the server. Refresh wallet state.');
        setWallets(result.wallets?.length ? result.wallets : [result.wallet]);
        setWallet(updated);
        setLocalRegistration(localRegistrationRef.current);
        setAgentRegistrationCheckStatus('idle');
        if (isAuthorizationReady(updated.chainAuthorizations.find((item) => item.chainId === agentRegistrationChainId))) {
          setWalletSetupSuccess('API access authorization confirmed.');
        } else setWalletSetupError('API access is not ready. The authorization failed or expired; renew it before transacting.');
      } else setAgentRegistrationCheckStatus('timed_out');
    } catch (err: unknown) {
      if (!isCurrent()) return;
      setAgentRegistrationCheckStatus('timed_out');
      setWalletSetupError(getApiErrorMessage(err));
    }
  }

  async function handleWithdraw(e?: React.FormEvent) {
    e?.preventDefault();
    if (withdrawInFlightRef.current) return;
    const owner = currentOwner;
    const isCurrent = () => ownerRef.current === owner;
    let submitted = false;
    let resuming = false;
    let intent: WithdrawalIntent | null = null;
    withdrawInFlightRef.current = true;
    setWithdrawLoading(true);
    setWithdrawResult(null);
    setWithdrawError(null);
    try {
      if (recoveryStorageError) throw new Error(recoveryStorageError);
      if (!user?.userId || !selectedWallet?.id || !selectedWallet.walletAddress) throw new Error('Select the wallet to withdraw from.');
      intent = readOperation<WithdrawalIntent>('withdrawal', user.userId, selectedWallet.id, selectedWallet.walletAddress) ?? withdrawIntentRef.current;
      if (intent && (intent.userId !== user.userId || intent.walletId !== selectedWallet.id)) intent = null;
      resuming = Boolean(intent);
      if (!intent) {
        if (!isAuthorizationReady(withdrawalAuthorization)) throw new Error('Authorize or renew API access on the selected withdrawal chain first.');
        const baseUnits = parseWithdrawalAmount(amount, token);
        if (BigInt(baseUnits) <= 0n) throw new Error('Enter an amount greater than zero.');
        if (!/^0x[a-fA-F0-9]{40}$/.test(to)) throw new Error('Enter a valid recipient address.');
        intent = {
          userId: user.userId, walletId: selectedWallet.id, walletAddress: selectedWallet.walletAddress,
          chainId: selectedChainId, to, token, amount: baseUnits, displayAmount: amount,
          idempotencyKey: crypto.randomUUID(), status: 'unknown',
        };
        saveOperation('withdrawal', intent);
        withdrawIntentRef.current = intent;
        setWithdrawIntent(intent);
      }
      let result;
      if (intent.transactionId) {
        const detail = await getTransactionDetailAuth(intent.transactionId);
        result = { transactionId: detail.id, transactionHash: detail.txHash, status: detail.status };
      } else {
        const stepUpToken = getDashboardStepUpToken() ?? (await requestStepUpToken());
        if (!isCurrent()) {
          // This newly-created intent never reached the API. Do not leave a
          // fake unknown withdrawal behind when step-up outlives its session.
          if (!resuming) clearOperation('withdrawal', intent);
          return;
        }
        submitted = true;
        result = await withdrawAuth(intent.to, intent.amount, intent.token, intent.chainId, stepUpToken, intent.walletId, intent.idempotencyKey);
      }
      intent = { ...intent, ...result };
      if (isCurrent()) withdrawIntentRef.current = intent;
      saveOperation('withdrawal', intent);
      if (!isCurrent()) return;
      setWithdrawIntent(intent);
      if (isWithdrawalTerminal(result.status)) {
        setWithdrawResult({
          status: result.status as 'confirmed' | 'failed',
          message: result.status === 'confirmed' ? 'Withdrawal confirmed.' : 'Withdrawal failed. No new withdrawal has been submitted.',
          transactionHash: result.transactionHash, chainId: intent.chainId,
        });
        retryBalances();
      }
    } catch (err: unknown) {
      // Only the first, definite pre-submission rejection can release this intent.
      // A later validation/auth error says nothing about an earlier lost response.
      const knownRejected = submitted && !resuming && isApiError(err) &&
        [400, 401, 403, 422, 429].includes(err.statusCode) && !hasApiErrorCode(err, 'IDEMPOTENCY_CONFLICT');
      if (intent && ((!submitted && !resuming) || knownRejected)) {
        try {
          clearOperation('withdrawal', intent);
          if (isCurrent()) {
            withdrawIntentRef.current = null;
            setWithdrawIntent(null);
          }
        } catch { /* Keep the intent locked if storage cannot be cleared. */ }
      }
      if (isCurrent()) setWithdrawError({
        message: getApiErrorMessage(err),
        billingBlocked: hasApiErrorCode(err, 'BILLING_OUTBOUND_BLOCKED'),
      });
    } finally {
      withdrawInFlightRef.current = false;
      setWithdrawLoading(false);
    }
  }

  function resetWithdrawForm() {
    if (!ownedWithdrawIntent || !isWithdrawalTerminal(ownedWithdrawIntent.status)) return;
    try {
      clearOperation('withdrawal', ownedWithdrawIntent);
      withdrawIntentRef.current = null;
      setWithdrawIntent(null);
      setWithdrawResult(null);
      setWithdrawError(null);
      setTo('');
      setAmount('');
    } catch {
      setWithdrawError({ message: 'Could not clear the saved withdrawal. Restore browser storage before starting another.' });
    }
  }

  async function handleAddWithdrawalAddress(e: React.FormEvent) {
    e.preventDefault();
    setWithdrawalAddressLoadingId('new');
    setWithdrawalAllowlistError(null);

    try {
      const stepUpToken = getDashboardStepUpToken() ?? (await requestStepUpToken());
      await addWithdrawalAddressAuth({
        address: newWithdrawalAddress,
        label: newWithdrawalAddressLabel || undefined,
      },
      stepUpToken,);
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
      const stepUpToken = getDashboardStepUpToken() ?? (await requestStepUpToken());
      await removeWithdrawalAddressAuth(id, stepUpToken);
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
      if (!providerAuthenticated) throw new Error('Verify your email below to reconnect Openfort wallet controls.');
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
        const providerBearer = await getAccessToken();
        if (!providerBearer) {
          setWalletIdentityRequired(true);
          throw new Error('Reconnect Openfort before authorizing a wallet.');
        }
        try {
          authorized = await authorizeEmbeddedWallet(providerBearer, {
            embeddedWalletAddress: address,
            embeddedOpenfortAccountId: accountId,
          });
          break;
        } catch (err: unknown) {
          if (hasApiErrorCode(err, 'AUTH_PROVIDER_INVALID')) throw err;
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
      if (hasApiErrorCode(err, 'AUTH_PROVIDER_INVALID')) setWalletIdentityRequired(true);
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
    const registrationOwner = currentOwner;
    registerAgentInFlightRef.current = true;
    setWalletSetupLoading(true);
    setWalletSetupError(null);
    setWalletSetupSuccess(null);

    try {
      if (!providerAuthenticated) throw new Error('Verify your email below to reconnect Openfort wallet controls.');
      assertWebCryptoAvailable();
      if (!selectedWallet?.walletAddress || !selectedWallet.signerAddress || !selectedWallet.agentKeyHash) {
        throw new Error('Missing wallet or agent key details. Please reload the page.');
      }
      const storedOperation = readOperation<RegistrationOperation>('registration', user!.userId, selectedWallet.id, selectedWallet.walletAddress);
      if (storedOperation) {
        localRegistrationRef.current = storedOperation;
        setLocalRegistration(storedOperation);
      }
      if (pendingAuthorization || localRegistrationRef.current || recoveryStorageError) {
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
          if (ownerRef.current !== registrationOwner) throw new Error('Wallet selection or session changed.');
          if (typeof first !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(first) || first.toLowerCase() !== address.toLowerCase()) throw new Error();
        } catch {
          throw new Error('Openfort could not confirm the selected wallet is active. No authorization was signed.');
        }
      };
      await verifyActiveAccount();
      let authorization = selectedAuthorization;
      let currentWallet: WalletInfo | null = selectedWallet;
      {
        const providerBearer = await getAccessToken();
        if (ownerRef.current !== registrationOwner) return;
        if (!providerBearer) {
          setWalletIdentityRequired(true);
          throw new Error('Reconnect Openfort before authorizing a wallet.');
        }
        const initialized = await authorizeEmbeddedWallet(providerBearer, {
          embeddedWalletAddress: address,
          embeddedOpenfortAccountId: selectedAccount.id ?? selectedAccount.accountId,
          chainId: agentChainId,
          agentExpiresAt: agentExpiresAt.toISOString(),
        });
        if (ownerRef.current !== registrationOwner) return;
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
        publicKey: padHex(currentWallet.signerAddress as Hex, { size: 32 }),
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
          if (ownerRef.current !== registrationOwner) throw new Error('Wallet selection or session changed. No operation was signed.');
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
      if (ownerRef.current !== registrationOwner) throw new Error('Wallet selection or session changed. No registration was submitted.');
      const submission: RegistrationOperation = {
        userId: user!.userId, walletId: selectedWallet.id, walletAddress: address,
        chainId: agentChainId, userOpHash: null,
      };
      // Reserve a durable slot before sending. If the response is lost, reloads
      // must remain blocked rather than sign a second operation.
      saveOperation('registration', submission);
      localRegistrationRef.current = submission;
      setLocalRegistration(submission);
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
      const operation: RegistrationOperation = { ...submission, userOpHash };
      if (ownerRef.current === registrationOwner) {
        localRegistrationRef.current = operation;
        setLocalRegistration(operation);
      }
      try {
        saveOperation('registration', operation);
      } catch {
        if (ownerRef.current === registrationOwner) setWalletSetupError(`Browser storage could not save the submitted UserOperation. Keep this page open and copy its identity: ${userOpHash}. Retry check only; do not authorize again.`);
      }
      if (ownerRef.current === registrationOwner) setAgentRegistrationCheckStatus('timed_out');
    } catch (err: unknown) {
      if (ownerRef.current === registrationOwner) {
        if (hasApiErrorCode(err, 'AUTH_PROVIDER_INVALID')) setWalletIdentityRequired(true);
        setWalletSetupError(getApiErrorMessage(err));
      }
    } finally {
      setWalletSetupLoading(false);
      registerAgentInFlightRef.current = false;
    }
  }

  const agentChain = SUPPORTED_CHAINS.find((chain) => chain.id === agentChainId);
  const agentChainName = agentChain?.name ?? `Chain ${agentChainId}`;
  const selectedAuthorizationStatus = selectedAuthorization?.status === 'registered' && !isAuthorizationReady(selectedAuthorization, now)
    ? 'expired' : selectedAuthorization?.status ?? null;
  const shouldPromptReauthorization =
    selectedAuthorizationExpiry?.tone === 'red' || selectedAuthorizationExpiry?.tone === 'amber';
  const selectedAuthorizationExpiryClasses =
    selectedAuthorizationExpiry?.tone === 'red'
      ? 'border-red-200 bg-red-50 text-red-800'
      : selectedAuthorizationExpiry?.tone === 'amber'
        ? 'border-amber-200 bg-amber-50 text-amber-800'
        : 'border-green-200 bg-green-50 text-green-800';
  const isSelectedChainRegistered = isAuthorizationReady(selectedAuthorization, now);
  const isAgentRegistrationChecking = Boolean(pendingAuthorization || ownedRegistration);
  const registrationBusy = walletSetupLoading || isAgentRegistrationChecking;
  const authorizeSubmitDisabled = registrationBusy || Boolean(recoveryStorageError) || !providerAuthenticated || providerLoading;
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
      : isAgentRegistrationChecking
        ? {
            title: 'Authorization pending',
            tone: 'blue',
            description: 'A registration operation is unresolved. Resume its check; do not submit another authorization.',
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
      {recoveryStorageError && <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{recoveryStorageError}</p>}
      {providerAuthenticated && !walletIdentityRequired && (
        <div className="mb-4 flex justify-end">
          <button type="button" disabled={registrationBusy || providerLoading}
            onClick={() => setWalletIdentityRequired(true)}
            className="text-sm font-semibold text-brand-accent disabled:opacity-50">
            Reconnect wallet identity
          </button>
        </div>
      )}
      {(!providerAuthenticated || walletIdentityRequired) && !providerLoading && (
        <DashboardCard>
          <p className="mb-4 text-sm text-brand-muted">Your SOFA session is active. Verify your email again to use Openfort wallet controls; other dashboard pages do not need this connection.</p>
          {session?.email && <p className="mb-4 text-sm text-brand-muted">Use the identity associated with your SOFA account: {session.email}.</p>}
          <EmailOtpForm walletReauthentication onWalletReauthenticated={() => setWalletIdentityRequired(false)} />
        </DashboardCard>
      )}
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
                    Wallet Address
                  </label>
                  <div className="mt-1 flex items-center gap-3">
                    <p className="break-all font-mono text-sm text-brand-text flex-1">
                      {selectedWallet.walletAddress ?? 'Create a wallet to finish setup'}
                    </p>
                    {selectedWallet.walletAddress && (
                      <CopyButton text={selectedWallet.walletAddress} className="shrink-0" />
                    )}
                  </div>
                  <p className="mt-2 text-xs leading-5 text-brand-muted">
                    Your wallet address stays the same when EIP-7702 delegates execution to Calibur.
                  </p>
                </div>

                {selectedWallet.signerAddress && (
                  <div className="rounded-xl border border-brand-border/60 bg-brand-bg/30 p-4 text-sm">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                        Signer Address
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
                        {selectedWallet.signerAddress}
                      </code>
                      <CopyButton text={selectedWallet.signerAddress} className="shrink-0" />
                    </div>
                    <p className="mt-2 text-xs leading-5 text-brand-muted">
                      TEE-managed EOA used for backend signing. This address alone does not establish authorization; see the per-network status below.
                    </p>
                    <AuthorizationBadges authorizations={selectedWallet.chainAuthorizations} now={now} />
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
                    pendingUserOpHash={ownedRegistration?.userOpHash ?? null}
                    pendingOperationUnknown={Boolean(ownedRegistration && !ownedRegistration.userOpHash && !ownedRegistration.txHash)}
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
                    withdrawalReady={withdrawalReady}
                    onResumeWithdrawal={() => { void handleWithdraw(); }}
                    withdrawalIntent={ownedWithdrawIntent}
                    recoveryStorageError={recoveryStorageError}
                    onAuthorizeChain={() => {
                      setAgentChainId(selectedChainId);
                      document.getElementById('wallet-authorize-access')?.scrollIntoView?.({ behavior: 'smooth' });
                      document.querySelector<HTMLInputElement>('#wallet-authorize-access input[type="datetime-local"]')?.focus();
                    }}
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
