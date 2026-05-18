import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AccountTypeEnum, RecoveryMethod, use7702Authorization, useOpenfort, useUser } from '@openfort/react';
import { useEthereumEmbeddedWallet } from '@openfort/react/ethereum';
import { usePublicClient } from 'wagmi';
import { http, padHex, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { createBundlerClient, createPaymasterClient } from 'viem/account-abstraction';
import { estimateFeesPerGas } from 'viem/actions';
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
import {
  BanknoteArrowUp,
  X,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ArrowRight,
  RotateCcw,
  ExternalLink,
} from 'lucide-react';
import { CopyButton } from '@/components/CopyButton';
import { DashboardPage, DashboardCard } from './components/DashboardPage';

function parseUsdcAmount(input: string): string {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{0,6})?$/.test(trimmed)) {
    throw new Error('Enter a valid USDC amount (e.g. 1.50)');
  }
  const [intPart, fracPart = ''] = trimmed.split('.');
  const frac = fracPart.padEnd(6, '0');
  const baseUnits = BigInt(intPart) * 1_000_000n + BigInt(frac);
  return baseUnits.toString();
}

function EthIcon() {
  return (
    <svg viewBox="0 0 256 417" className="h-5 w-5" aria-hidden="true">
      <path fill="#343434" d="M127.9 0 125.1 9.5v275.2l2.8 2.8 127.8-75.5z" />
      <path fill="#8C8C8C" d="M127.9 0 0 212l127.9 75.5V154z" />
      <path fill="#3C3C3B" d="m127.9 311.7-1.6 2v98.1l1.6 4.7L255.8 236z" />
      <path fill="#8C8C8C" d="M127.9 416.5V311.7L0 236z" />
      <path fill="#141414" d="m127.9 287.5 127.8-75.5-127.8-58z" />
      <path fill="#393939" d="m0 212 127.9 75.5V154z" />
    </svg>
  );
}

function UsdcIcon() {
  return (
    <svg viewBox="0 0 32 32" className="h-5 w-5" aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="#2775CA" />
      <path
        fill="#fff"
        d="M20.02 18.53c0-2.13-1.28-2.86-3.83-3.16-1.82-.24-2.19-.73-2.19-1.58s.6-1.4 1.82-1.4c1.09 0 1.7.37 2 1.28a.46.46 0 0 0 .43.3h.97a.41.41 0 0 0 .42-.43v-.06a3.05 3.05 0 0 0-2.74-2.5V9.51a.43.43 0 0 0-.42-.43h-.91a.43.43 0 0 0-.43.43v1.4c-1.82.24-3.01 1.46-3.01 3.01 0 2 1.21 2.8 3.76 3.1 1.7.3 2.25.67 2.25 1.65s-.85 1.64-2 1.64c-1.58 0-2.13-.67-2.31-1.58a.44.44 0 0 0-.43-.37h-1.03a.42.42 0 0 0-.43.43v.06c.24 1.52 1.22 2.62 3.22 2.92v1.46a.43.43 0 0 0 .43.43h.91a.43.43 0 0 0 .42-.43v-1.46c1.83-.3 3.13-1.58 3.13-3.24z"
      />
      <path
        fill="#fff"
        d="M11.83 24.93a10 10 0 0 1 0-17.86.47.47 0 0 0 .24-.61l-.43-.85a.43.43 0 0 0-.55-.24 12 12 0 0 0 0 21.26.43.43 0 0 0 .55-.24l.43-.85a.47.47 0 0 0-.24-.61zm9.08-19.56a.43.43 0 0 0-.55.24l-.43.85a.47.47 0 0 0 .24.61 10 10 0 0 1 0 17.86.47.47 0 0 0-.24.61l.43.85a.43.43 0 0 0 .55.24 12 12 0 0 0 0-21.26z"
      />
    </svg>
  );
}

function TokenIcon({ token }: { token: string }) {
  if (token.toUpperCase() === 'USDC') return <UsdcIcon />;
  return <EthIcon />;
}

function WalletLoadingState() {
  return (
    <DashboardCard>
      <div className="space-y-6 py-2">
        <div className="flex items-start gap-4">
          <div className="rounded-full bg-brand-accent/10 p-3">
            <Loader2 className="h-5 w-5 animate-spin text-brand-accent" />
          </div>
          <div>
            <h2 className="font-serif text-xl font-bold text-brand-text">Preparing your wallet dashboard</h2>
            <p className="mt-1 text-sm text-brand-muted">
              We are checking your Openfort session, wallet provisioning status, and API access authorization.
            </p>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {['Session', 'Agent wallet', 'Balances'].map((label) => (
            <div key={label} className="rounded-xl border border-brand-border/60 bg-brand-bg/40 p-4">
              <div className="mb-3 h-3 w-20 rounded-full bg-brand-border/70" />
              <div className="h-8 rounded-lg bg-brand-border/50" />
              <p className="mt-3 text-xs font-semibold uppercase tracking-widest text-brand-muted">{label}</p>
            </div>
          ))}
        </div>
      </div>
    </DashboardCard>
  );
}

function resolveEmbeddedWallet(
  createdAccount: unknown,
  embeddedWallet: { address?: Address; activeWallet?: unknown; wallets?: unknown[] },
  refreshedAccounts?: unknown[],
): { address: Address; accountId?: string } {
  const created = createdAccount as
    | { id?: string; address?: Address; accounts?: Array<{ id?: string; address?: Address }> }
    | undefined;
  const active = embeddedWallet.activeWallet as
    | { id?: string; address?: Address; accountId?: string; accounts?: Array<{ id?: string }> }
    | undefined;
  const firstWallet = embeddedWallet.wallets?.[0] as
    | { id?: string; address?: Address; accountId?: string; accounts?: Array<{ id?: string }> }
    | undefined;
  const firstRefreshed = refreshedAccounts?.[0] as
    | { id?: string; address?: Address; accountId?: string; accounts?: Array<{ id?: string }> }
    | undefined;
  const address = created?.address ?? embeddedWallet.address ?? active?.address ?? firstWallet?.address ?? firstRefreshed?.address;

  if (!address) {
    throw new Error('EOA address was not returned by Openfort.');
  }

  return {
    address,
    accountId:
      active?.accountId ??
      active?.accounts?.[0]?.id ??
      created?.accounts?.[0]?.id ??
      created?.id ??
      firstWallet?.accountId ??
      firstWallet?.accounts?.[0]?.id ??
      firstWallet?.id ??
      firstRefreshed?.accountId ??
      firstRefreshed?.accounts?.[0]?.id ??
      firstRefreshed?.id,
  };
}

const AUTHORIZE_EMBEDDED_WALLET_RETRIES = 5;
const AUTHORIZE_EMBEDDED_WALLET_RETRY_DELAY_MS = 1_000;

function formatAgentStatus(status?: string | null) {
  if (status === 'registered') return 'success';
  if (status === 'registration_failed') return 'failed';
  if (status === 'registration_required') return 'action required';
  if (status === 'pending_registration') return 'checking';
  return status ?? 'not registered';
}

const AGENT_REGISTRATION_RECEIPT_TIMEOUT_MS = 60_000;
const AGENT_REGISTRATION_RESULT_RETRY_DELAY_MS = 3_000;
const AGENT_REGISTRATION_AUTO_CHECK_MS = 120_000;
const AGENT_REGISTRATION_MANUAL_CHECK_MS = 60_000;
const RAW_KEY_NOTICE_TTL_MS = 2 * 60 * 1000;
const BALANCE_CHAIN_STORAGE_KEY = 'sofa-one.wallet.balanceChainId';
const AGENT_CHAIN_STORAGE_KEY = 'sofa-one.wallet.agentChainId';

type WithdrawSuccess = {
  message: string;
  transactionHash: string | null;
  chainId: number;
};

function formatDateTimeLocal(date: Date) {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function getDefaultAgentExpiryLocal() {
  return formatDateTimeLocal(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
}

function assertWebCryptoAvailable() {
  if (globalThis.crypto?.subtle) return;
  throw new Error(
    'Secure browser crypto is not available. Open this app over HTTPS or localhost before creating an EOA.',
  );
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isSupportedChainId(chainId: number) {
  return SUPPORTED_CHAINS.some((chain) => chain.id === chainId);
}

function getStoredChainId(storageKey: string) {
  if (typeof window === 'undefined') return DEFAULT_CHAIN_ID;

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return DEFAULT_CHAIN_ID;

    const chainId = Number(stored);
    return Number.isInteger(chainId) && isSupportedChainId(chainId)
      ? chainId
      : DEFAULT_CHAIN_ID;
  } catch {
    return DEFAULT_CHAIN_ID;
  }
}

function persistChainId(storageKey: string, chainId: number) {
  try {
    window.localStorage.setItem(storageKey, String(chainId));
  } catch {
    // Ignore storage failures so private browsing or disabled storage does not block wallet use.
  }
}

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
  const [selectedChainId, setSelectedChainId] = useState(() => getStoredChainId(BALANCE_CHAIN_STORAGE_KEY));
  const [agentChainId, setAgentChainId] = useState(() => getStoredChainId(AGENT_CHAIN_STORAGE_KEY));
  const selectedAuthorization = wallet?.chainAuthorizations.find((authorization) => authorization.chainId === agentChainId);
  const pendingAuthorization = wallet?.chainAuthorizations.find(
    (authorization) => authorization.status === 'pending_registration' && authorization.registrationTxHash,
  );
  const hasRegisteredAuthorization = wallet?.chainAuthorizations.some(
    (authorization) => authorization.status === 'registered',
  );
  const agentRegistrationChainId = pendingAuthorization?.chainId ?? agentChainId;
  const walletExplorerUrl = getExplorerAddressUrl(agentChainId, wallet?.walletAddress);
  const pendingAuthorizationExplorerUrl = getExplorerTransactionUrl(
    agentRegistrationChainId,
    pendingAuthorization?.registrationTxHash,
  );
  const agentGasHelpUrl = getChainGasHelpUrl(agentChainId);
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
        setWalletSetupSuccess('Authorization transaction succeeded, but confirmation is taking longer than expected. Use Retry check to verify again.');
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
      setWalletSetupSuccess('Authorization is still pending verification. Retry again in a moment; do not submit another authorization.');
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
      const result = await withdrawAuth(getToken, to, baseUnits, token, chainId);
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
        throw new Error('API access authorization is already checking. Wait for confirmation before authorizing again.');
      }
      if (recoveryPassword.length < 8) {
        throw new Error('Enter your wallet recovery password to unlock registration.');
      }
      const agentExpiresAt = new Date(agentExpiryLocal);
      if (Number.isNaN(agentExpiresAt.getTime()) || agentExpiresAt <= new Date()) {
        throw new Error('Choose an API authorization expiry time in the future.');
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
          return openfort.client.embeddedWallet.signTypedData(payload.domain, payload.types, payload.message) as Promise<Hex>;
        },
      });
      const caliburAccount = await createCaliburAccount({ client: publicClient, owner });
      const openfortPublishableKey = import.meta.env.VITE_OPENFORT_PUBLISHABLE_KEY;
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
      const fees = await estimateFeesPerGas(publicClient, { chain: publicClient.chain, type: 'eip1559' });
      const userOpHash = await bundlerClient.sendUserOperation({
        account: caliburAccount,
        calls: registrationCalls,
        ...(eip7702Authorization ? { authorization: eip7702Authorization } : {}),
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        ...(feeSponsorshipId
          ? { paymasterContext: { policyId: feeSponsorshipId } }
          : {}),
      } as never);
      const userOpReceipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });
      const txHash = (userOpReceipt as { receipt?: { transactionHash?: Hex }; transactionHash?: Hex }).receipt?.transactionHash
        ?? (userOpReceipt as { transactionHash?: Hex }).transactionHash;
      if (!txHash) {
        throw new Error(`Agent registration UserOperation was submitted but no transaction hash was returned: ${userOpHash}`);
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
      const confirmedAuthorization = result.wallet.chainAuthorizations.find((item) => item.chainId === agentChainId);
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
  const selectedAuthorizationStatus = selectedAuthorization?.status ?? null;
  const isSelectedChainRegistered = selectedAuthorizationStatus === 'registered';
  const isAgentRegistrationChecking = Boolean(pendingAuthorization);
  const registrationBusy = walletSetupLoading || isAgentRegistrationChecking;
  const authorizeSubmitDisabled = registrationBusy || isSelectedChainRegistered;
  const showAgentRegistrationSpinner = walletSetupLoading || agentRegistrationCheckStatus === 'checking';
  const setupStatus = !wallet?.walletAddress
    ? { title: 'Create agent EOA', tone: 'amber', description: 'Set one recovery password. Openfort secures the EOA key and we never expose private keys.' }
    : hasRegisteredAuthorization
      ? { title: 'Ready for API transactions', tone: 'green', description: 'Your EOA has Calibur API access on at least one network. You can authorize more networks anytime.' }
      : pendingAuthorization
        ? { title: 'Authorization pending', tone: 'blue', description: 'The authorization transaction was submitted and is being checked.' }
        : { title: 'Authorize API access', tone: 'blue', description: 'Choose a network, add gas, unlock the wallet, and authorize API access.' };
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
            <div className="relative rounded-2xl border border-amber-200 bg-amber-50 p-5 pr-14 shadow-sm">
              <button
                type="button"
                onClick={() => setApiKeyDisplay(null)}
                className="absolute right-4 top-4 inline-flex items-center justify-center rounded-full border border-amber-300 p-1 text-amber-600 transition-colors hover:bg-amber-100"
                aria-label="Dismiss new API key notice"
              >
                <X className="h-3.5 w-3.5" />
              </button>
              <p className="mb-2 text-sm font-medium text-amber-800">
                API key for backend requests (save it — shown only once):
              </p>
              <p className="mb-3 text-xs text-amber-700">
                Use this as the <code>X-API-Key</code> header from your server. This notice auto-hides in 2 minutes.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded-lg bg-amber-100 px-4 py-3 font-mono text-sm text-amber-900 ring-1 ring-amber-200/50">
                  {apiKeyDisplay}
                </code>
                <CopyButton text={apiKeyDisplay} className="shrink-0 border-amber-300 text-amber-600 hover:bg-amber-100" />
              </div>
            </div>
          )}

          {wallet && (
        <DashboardCard className="!p-0">
          <div className="p-7 space-y-6">
            <div className={`rounded-2xl border p-5 shadow-sm ${setupStatusClasses}`}>
              <div className="space-y-5">
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h2 className="font-serif text-xl font-bold text-brand-text">{setupStatus.title}</h2>
                    <p className="mt-1 text-sm">{setupStatus.description}</p>
                    <p className="mt-2 text-xs font-medium opacity-80">
                      Selected network: {agentChain?.name ?? `Chain ${agentChainId}`} · Status: {formatAgentStatus(selectedAuthorizationStatus)}
                    </p>
                  </div>
                  {hasRegisteredAuthorization && (
                    <Link
                      to="/dashboard/api-keys"
                      className="inline-flex items-center justify-center gap-2 rounded-full bg-brand-text px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition-all hover:-translate-y-0.5 hover:bg-brand-text/90 hover:shadow-xl"
                    >
                      Create API key
                      <ArrowRight className="h-4 w-4" />
                    </Link>
                  )}
                </div>

                <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr] md:items-stretch">
                  {setupSteps.map((step, index) => {
                    const isDone = step.state === 'done';
                    const isActive = step.state === 'active';
                    return (
                      <div key={step.number} className="contents">
                        <div
                          className={`rounded-xl border bg-white/75 p-4 ring-1 ring-black/5 ${
                            isActive
                              ? 'border-brand-text shadow-sm'
                              : isDone
                                ? 'border-green-200'
                                : 'border-brand-border/70 opacity-60'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <div
                              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                                isDone
                                  ? 'bg-green-600 text-white'
                                  : isActive
                                    ? 'bg-brand-text text-white'
                                    : 'bg-brand-bg text-brand-muted ring-1 ring-brand-border'
                              }`}
                            >
                              {isDone ? <CheckCircle2 className="h-4 w-4" /> : step.number}
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-brand-text">Step {step.number}: {step.title}</p>
                              <p className="mt-0.5 text-xs text-brand-muted">{step.description}</p>
                            </div>
                          </div>
                        </div>
                        {index === 0 && (
                          <div className="hidden items-center px-1 text-brand-muted md:flex" aria-hidden="true">
                            <ArrowRight className="h-4 w-4" />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {hasRegisteredAuthorization && (
                  <div className="rounded-xl border border-green-200 bg-white/70 p-4 text-sm text-green-800">
                    EOA setup is complete. Create an API key when you are ready to connect your backend.
                  </div>
                )}
              </div>
            </div>

            <div>
              <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">EOA Address</label>
              <div className="mt-1 flex items-center gap-3">
                <p className="break-all font-mono text-sm text-brand-text flex-1">
                  {wallet.walletAddress ?? 'Create an agent EOA to finish setup'}
                </p>
                {wallet.walletAddress && <CopyButton text={wallet.walletAddress} className="shrink-0" />}
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
                  <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-brand-muted ring-1 ring-brand-border/60">
                    {wallet.chainAuthorizations.length} network{wallet.chainAuthorizations.length === 1 ? '' : 's'} configured
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all font-mono text-xs text-brand-text">
                    {wallet.agentWalletAddress}
                  </code>
                  <CopyButton text={wallet.agentWalletAddress} className="shrink-0" />
                </div>
              </div>
            )}

            {!wallet.walletAddress && (
              <form
                onSubmit={handleConnectWallet}
                className="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm"
              >
                <div className="mb-4">
                  <h2 className="font-serif text-xl font-bold text-brand-text">
                    Step 1: Create your agent EOA
                  </h2>
                  <p className="mt-1 text-sm text-amber-800">
                    Choose a recovery password. You will select networks in Step 2.
                  </p>
                </div>

                {walletSetupError && (
                  <div className="mb-4 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm">
                    <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
                    {walletSetupError}
                  </div>
                )}

                <div className="space-y-5">
                  <div className="max-w-xl">
                    <label className="mb-2 block text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                      Recovery Password
                    </label>
                    <input
                      type="password"
                      minLength={8}
                      value={recoveryPassword}
                      onChange={(event) => setRecoveryPassword(event.target.value)}
                      placeholder="At least 8 characters"
                      className="block w-full rounded-lg border border-amber-200 bg-white px-4 py-2.5 text-sm text-brand-text shadow-sm placeholder:text-brand-muted focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent"
                    />
                  </div>
                </div>

                <div className="mt-5 flex justify-end">
                  <button
                    type="submit"
                    disabled={walletSetupLoading}
                    className="flex items-center justify-center gap-2 rounded-full bg-brand-text px-8 py-2.5 text-sm font-semibold text-white shadow-lg transition-all hover:-translate-y-0.5 hover:bg-brand-text/90 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {walletSetupLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                    <span>Create EOA</span>
                  </button>
                </div>
              </form>
            )}

            {wallet.walletAddress && (
              <form
                onSubmit={handleRegisterAgent}
                className={`rounded-2xl border p-5 shadow-sm ${
                  isSelectedChainRegistered ? 'border-green-200 bg-green-50' : 'border-blue-200 bg-blue-50'
                }`}
              >
                <div className="mb-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <h2 className="font-serif text-xl font-bold text-brand-text">
                      Step 2: Authorize API access
                    </h2>
                    <span className={`inline-flex w-fit rounded-full bg-white px-3 py-1 text-xs font-semibold ring-1 ${
                      isSelectedChainRegistered ? 'text-green-800 ring-green-200' : 'text-blue-800 ring-blue-200'
                    }`}>
                      Status: {formatAgentStatus(selectedAuthorizationStatus)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-blue-800">
                    {isSelectedChainRegistered
                      ? `${agentChain?.name ?? `Chain ${agentChainId}`} is already authorized for API access.`
                      : isAgentRegistrationChecking
                      ? 'Authorization is checking on-chain. We will update this page automatically; do not submit another authorization.'
                      : 'This one-time on-chain approval lets your backend submit transactions through API keys.'}
                  </p>
                  {!isSelectedChainRegistered && !isAgentRegistrationChecking && (
                    <div className="mt-3 rounded-xl border border-blue-200 bg-white/70 p-4 text-sm text-blue-900 shadow-inner">
                      <strong className="block text-blue-950">Before you authorize</strong>
                      <ul className="mt-2 space-y-1.5 text-blue-800">
                        <li>• Keep your Step 1 recovery password ready to unlock the EOA in this browser.</li>
                        <li>• Deposit a small amount of {agentNativeSymbol} on the selected network for gas.</li>
                        <li>• Choose a future authorization expiry that matches this backend integration.</li>
                      </ul>
                    </div>
                  )}
                  {!isSelectedChainRegistered && <div className="mt-3 rounded-xl bg-white/70 p-4 text-sm text-blue-900 border border-blue-200 shadow-inner">
                    <strong className="block mb-1 text-blue-950">Deposit gas to continue</strong>
                    <p className="mb-3 text-blue-800">
                      Send a small amount of {publicClient?.chain?.nativeCurrency.symbol ?? 'native gas token'} on {agentChain?.name ?? 'the selected network'} to this EOA address. Then use your Step 1 password to sign the one-time Calibur authorization in your browser.
                    </p>
                    <div className="flex items-center gap-2 bg-white rounded-md p-1.5 border border-blue-200 shadow-sm">
                      <code className="min-w-0 flex-1 break-all px-2 py-1 font-mono text-xs text-brand-text">{wallet.walletAddress}</code>
                      <CopyButton text={wallet.walletAddress} className="border-blue-300 text-blue-600 hover:bg-blue-100 bg-blue-50" />
                    </div>
                    {walletExplorerUrl && (
                      <a
                        href={walletExplorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 hover:text-blue-900"
                      >
                        View EOA on {agentChain?.name ?? 'network'} explorer
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                    {agentGasHelpUrl && (
                      <a
                        href={agentGasHelpUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-0 mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 hover:text-blue-900 sm:ml-4"
                      >
                        Get testnet {agentNativeSymbol}
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>}
                </div>

                {walletSetupError && (
                  <div className="mb-4 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm">
                    <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
                    {walletSetupError}
                  </div>
                )}

                {walletSetupSuccess && (
                  <div className="mb-4 flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 p-4 text-sm font-medium text-green-800 shadow-sm">
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500" />
                    <span className="break-all">{walletSetupSuccess}</span>
                  </div>
                )}

                {pendingAuthorization && (
                  <div className="mb-4 rounded-xl border border-blue-200 bg-white/80 p-4 text-sm text-blue-900 shadow-sm">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="font-semibold">
                          {agentRegistrationCheckStatus === 'checking'
                            ? 'Checking on-chain authorization...'
                            : 'Authorization submitted; confirmation is not complete yet.'}
                        </p>
                        <div className="mt-2 flex max-w-xl items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/70 p-1.5">
                          <code className="min-w-0 flex-1 break-all px-2 py-1 font-mono text-xs text-blue-900">
                            Tx: {pendingAuthorization.registrationTxHash}
                          </code>
                          <CopyButton
                            text={pendingAuthorization.registrationTxHash ?? ''}
                            className="shrink-0 border-blue-300 bg-white text-blue-700 hover:bg-blue-100"
                          />
                        </div>
                        {pendingAuthorizationExplorerUrl && (
                          <a
                            href={pendingAuthorizationExplorerUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 hover:text-blue-900"
                          >
                            View authorization transaction on explorer
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={handleRetryAgentRegistrationCheck}
                        disabled={agentRegistrationCheckStatus === 'checking' || walletSetupLoading}
                        className="inline-flex items-center justify-center gap-2 rounded-full border border-blue-300 bg-blue-50 px-4 py-2 text-xs font-semibold text-blue-800 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {agentRegistrationCheckStatus === 'checking' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        Retry check
                      </button>
                    </div>
                  </div>
                )}

                <div className="grid gap-4 rounded-xl border border-blue-100 bg-blue-100/30 p-4 md:grid-cols-[180px_180px_1fr_auto] md:items-end">
                  <div>
                    <label className="mb-2 block text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                      Network
                    </label>
                    <select
                      value={agentChainId}
                      onChange={(event) => setAgentChainId(Number(event.target.value))}
                      disabled={registrationBusy}
                      className="block w-full rounded-lg border border-blue-200 bg-white px-3 py-2.5 pr-8 text-sm font-medium text-brand-text shadow-sm focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {SUPPORTED_CHAINS.map((chain) => (
                        <option key={chain.id} value={chain.id}>
                          {chain.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-2 block text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                      Authorization expiry
                    </label>
                    <input
                      type="datetime-local"
                      value={agentExpiryLocal}
                      min={formatDateTimeLocal(new Date(Date.now() + 60_000))}
                      onChange={(event) => setAgentExpiryLocal(event.target.value)}
                      disabled={authorizeSubmitDisabled}
                      required
                      className="block w-full rounded-lg border border-blue-200 bg-white px-4 py-2.5 text-sm text-brand-text shadow-sm placeholder:text-brand-muted focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="mb-2 block text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                      Step 1 Wallet Password
                    </label>
                    <input
                      type="password"
                      minLength={8}
                      value={recoveryPassword}
                      onChange={(event) => setRecoveryPassword(event.target.value)}
                      placeholder="Enter the password you created in Step 1"
                      disabled={authorizeSubmitDisabled}
                      className="block w-full rounded-lg border border-blue-200 bg-white px-4 py-2.5 text-sm text-brand-text shadow-sm placeholder:text-brand-muted focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={authorizeSubmitDisabled}
                      className="flex h-[42px] items-center justify-center gap-2 whitespace-nowrap rounded-full bg-brand-text px-8 text-sm font-semibold text-white shadow-lg transition-all hover:-translate-y-0.5 hover:bg-brand-text/90 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {showAgentRegistrationSpinner && (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      )}
                      <span>
                        {isSelectedChainRegistered
                          ? 'Authorized'
                          : isAgentRegistrationChecking
                            ? 'Authorization pending'
                            : 'Authorize API Access'}
                      </span>
                    </button>
                  </div>
                </div>
              </form>
            )}

            <div className="pt-6 border-t border-brand-border">
              <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Assets</label>
                <div className="flex items-center gap-2">
                  {balancesLoading && balances && (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand-muted">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Refreshing
                    </span>
                  )}
                  <button
                    onClick={retryBalances}
                    disabled={balancesLoading}
                    className="inline-flex items-center justify-center gap-1.5 rounded-full border border-brand-border bg-white px-3 py-1.5 text-xs font-semibold text-brand-text transition-all hover:border-brand-accent hover:bg-brand-bg disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Retry
                  </button>
                  <select
                    value={selectedChainId}
                    onChange={(e) => setSelectedChainId(Number(e.target.value))}
                    className="rounded-lg border border-brand-border bg-white px-3 py-1.5 text-sm font-medium text-brand-text shadow-sm focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent transition-colors cursor-pointer hover:bg-brand-bg/50"
                  >
                    {SUPPORTED_CHAINS.map((chain) => (
                      <option key={chain.id} value={chain.id}>
                        {chain.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {balancesError && (
                  <div className="sm:col-span-2 flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                    <span>{balancesError}</span>
                    <button
                      onClick={retryBalances}
                      disabled={balancesLoading}
                      className="inline-flex items-center justify-center gap-1.5 rounded-full border border-red-200 bg-white px-4 py-1.5 text-xs font-semibold text-red-700 transition-all hover:border-red-300 hover:bg-red-100 disabled:opacity-50"
                    >
                      {balancesLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      Retry balances
                    </button>
                  </div>
                )}

                {balancesLoading && !balances ? (
                  <>
                    <div className="h-16 rounded-xl border border-brand-border/40 bg-brand-bg/30 animate-pulse"></div>
                    <div className="h-16 rounded-xl border border-brand-border/40 bg-brand-bg/30 animate-pulse"></div>
                  </>
                ) : balances && balances.length > 0 ? (
                  balances.map((chain) => (
                    chain.balances.map((b) => (
                      <div
                        key={`${chain.chainId}-${b.token}`}
                        className="group relative flex items-center justify-between overflow-hidden rounded-xl border border-brand-border/60 bg-white p-3.5 transition-all hover:border-brand-accent/40 hover:shadow-[0_4px_12px_-4px_rgba(0,0,0,0.05)]"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-bg ring-1 ring-brand-border/60">
                            <TokenIcon token={b.token} />
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-brand-text">{b.token}</p>
                            <p className="text-[10px] font-medium uppercase tracking-wider text-brand-muted">{chain.chainName || `Chain ${chain.chainId}`}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="font-mono text-[13px] font-medium text-brand-text">
                            {b.error ? '—' : b.formatted}
                          </p>
                        </div>
                      </div>
                    ))
                  ))
                ) : null}
              </div>
            </div>

            {showWithdraw && (
              <div className="pt-6 border-t border-brand-border">
                <h3 className="text-base font-bold font-serif text-brand-text mb-6">Withdraw</h3>

                {withdrawError && (
                  <div className="mb-6 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm">
                    <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
                    {withdrawError}
                  </div>
                )}

                {withdrawResult && (
                  <div className="mb-6 space-y-3 rounded-xl border border-green-200 bg-green-50 p-4 text-sm font-medium text-green-800 shadow-sm">
                    <div className="flex items-center gap-3">
                      <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500" />
                      <span>{withdrawResult.message}</span>
                    </div>
                    {withdrawResult.transactionHash && (
                      <div className="flex flex-col gap-3 rounded-lg border border-green-200/80 bg-white/70 p-3 text-xs text-green-900 sm:flex-row sm:items-center sm:justify-between">
                        <span className="break-all font-mono">{withdrawResult.transactionHash}</span>
                        <div className="flex shrink-0 items-center gap-2">
                          <CopyButton text={withdrawResult.transactionHash} />
                          {withdrawExplorerUrl && (
                            <a
                              href={withdrawExplorerUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 rounded-full border border-green-200 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-green-800 transition hover:border-green-400 hover:text-green-950"
                            >
                              Explorer
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <form onSubmit={handleWithdraw} className="space-y-6">
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted mb-2 block">Recipient Address</label>
                    <input
                      type="text"
                      placeholder="0x..."
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                      required
                      pattern="^0x[a-fA-F0-9]{40}$"
                      className="block w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder:text-brand-muted bg-white shadow-sm"
                    />
                  </div>
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-4">
                    <div className="w-full sm:w-48">
                      <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted mb-2 block">Chain</label>
                      <select
                        value={selectedChainId}
                        onChange={(e) => setSelectedChainId(Number(e.target.value))}
                        className="block w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent bg-white shadow-sm"
                      >
                        {SUPPORTED_CHAINS.map((chain) => (
                          <option key={chain.id} value={chain.id}>
                            {chain.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted mb-2 block">Amount (USDC)</label>
                      <input
                        type="text"
                        placeholder="1.00"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        required
                        className="block w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent placeholder:text-brand-muted bg-white shadow-sm"
                      />
                    </div>
                    <div className="w-full sm:w-32">
                      <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted mb-2 block">Token</label>
                      <select
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        className="block w-full rounded-lg border border-brand-border px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent bg-white shadow-sm"
                      >
                        <option value="USDC">USDC</option>
                      </select>
                    </div>
                  </div>
                  <div className="pt-2">
                    <button
                      type="submit"
                      disabled={withdrawLoading}
                      className="flex items-center justify-center gap-2 rounded-full bg-brand-text px-8 py-2.5 text-sm font-semibold text-white shadow-lg hover:bg-brand-text/90 hover:shadow-xl hover:-translate-y-0.5 transition-all disabled:opacity-50"
                    >
                      {withdrawLoading && (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      )}
                      <span>{withdrawLoading ? 'Submitting...' : 'Send Withdrawal'}</span>
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>
        </DashboardCard>
          )}
        </>
      )}

    </DashboardPage>
  );
}
