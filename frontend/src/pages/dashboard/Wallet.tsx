import { useEffect, useState } from 'react';
import { AccountTypeEnum, RecoveryMethod, useOpenfort, useUser } from '@openfort/react';
import { useEthereumEmbeddedWallet } from '@openfort/react/ethereum';
import { usePublicClient, useSendTransaction } from 'wagmi';
import { formatEther, padHex, zeroAddress, type Address, type Hex } from 'viem';
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
  KeyType,
  encodeExecute,
  encodeRegisterKey,
  encodeUpdateKeySettings,
  hashKey,
  type CaliburKey,
} from '@/lib/calibur';
import { BanknoteArrowUp, X, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { CopyButton } from '@/components/CopyButton';

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

function resolveEmbeddedWallet(
  createdAccount: unknown,
  embeddedWallet: { address?: Address; activeWallet?: unknown; wallets?: unknown[] },
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
  const address = embeddedWallet.address ?? active?.address ?? created?.address ?? firstWallet?.address;

  if (!address) {
    throw new Error('Embedded wallet address was not returned by Openfort.');
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
      firstWallet?.id,
  };
}

function formatAgentStatus(status?: string | null) {
  if (status === 'registered') return 'success';
  if (status === 'registration_failed') return 'failed';
  if (status === 'pending_registration') return 'checking';
  return status ?? 'not registered';
}

const AGENT_REGISTRATION_RECEIPT_TIMEOUT_MS = 60_000;

function formatDateTimeLocal(date: Date) {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function getDefaultAgentExpiryLocal() {
  return formatDateTimeLocal(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
}

function formatNativeAmount(raw: bigint) {
  const value = formatEther(raw);
  const [whole, fraction = ''] = value.split('.');
  const trimmedFraction = fraction.slice(0, 6).replace(/0+$/, '');
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole;
}

export default function WalletPage() {
  const openfort = useOpenfort();
  const { getAccessToken, user } = useUser();
  const getToken = getAccessToken;
  const { sendTransactionAsync, isPending: registerTxPending } = useSendTransaction();
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [apiKeyDisplay, setApiKeyDisplay] = useState<string | null>(null);
  const [selectedChainId, setSelectedChainId] = useState(DEFAULT_CHAIN_ID);
  const publicClient = usePublicClient({ chainId: wallet?.chainId ?? selectedChainId });
  const embeddedWallet = useEthereumEmbeddedWallet({ chainId: selectedChainId });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [balances, setBalances] = useState<BalanceChain[] | null>(null);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [balancesError, setBalancesError] = useState<string | null>(null);

  const [showWithdraw, setShowWithdraw] = useState(false);
  
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [token, setToken] = useState('USDC');
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [withdrawResult, setWithdrawResult] = useState<string | null>(null);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [agentExpiryLocal, setAgentExpiryLocal] = useState(getDefaultAgentExpiryLocal);
  const [walletSetupLoading, setWalletSetupLoading] = useState(false);
  const [walletSetupError, setWalletSetupError] = useState<string | null>(null);
  const [walletSetupSuccess, setWalletSetupSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;

    const controller = new AbortController();

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
  }, [user, getToken]);

  useEffect(() => {
    if (!user || !wallet?.walletAddress) {
      setBalances(null);
      return;
    }

    const controller = new AbortController();
    setBalancesLoading(true);
    setBalancesError(null);
    getBalancesAuth(getToken, selectedChainId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setBalances(data.chains);
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
  }, [user, selectedChainId, wallet, getToken]);

  useEffect(() => {
    const txHash = wallet?.agentRegistrationTxHash;
    if (!user || !publicClient || wallet?.agentStatus !== 'pending_registration' || !txHash) {
      return;
    }

    let cancelled = false;
    const client = publicClient;
    const savedTxHash = txHash;

    async function resumeAgentRegistrationCheck() {
      try {
        const receipt = await client.waitForTransactionReceipt({
          hash: savedTxHash as Hex,
          timeout: AGENT_REGISTRATION_RECEIPT_TIMEOUT_MS,
        });
        const status: 'registered' | 'registration_failed' =
          receipt.status === 'success' ? 'registered' : 'registration_failed';
        const result = await markAgentRegistrationResult(getToken, { txHash: savedTxHash, status });
        if (!cancelled) setWallet(result.wallet);
      } catch {
        // Leave the saved tx hash and pending status intact; the next page visit will retry.
      }
    }

    resumeAgentRegistrationCheck();

    return () => {
      cancelled = true;
    };
  }, [user, publicClient, wallet?.agentStatus, wallet?.agentRegistrationTxHash, getToken]);

  async function handleWithdraw(e: React.FormEvent) {
    e.preventDefault();
    setWithdrawLoading(true);
    setWithdrawResult(null);
    setWithdrawError(null);
    try {
      const baseUnits = parseUsdcAmount(amount);
      const result = await withdrawAuth(getToken, to, baseUnits, token, selectedChainId);
      setWithdrawResult(`Transaction submitted: ${result.transactionHash || result.transactionId}`);
      setTo('');
      setAmount('');
    } catch (err: unknown) {
      setWithdrawError(getApiErrorMessage(err));
    } finally {
      setWithdrawLoading(false);
    }
  }

  async function handleSetupEmbeddedWallet(e: React.FormEvent) {
    e.preventDefault();
    setWalletSetupLoading(true);
    setWalletSetupError(null);
    setWalletSetupSuccess(null);

    try {
      if (recoveryPassword.length < 8) {
        throw new Error('Use a wallet recovery password with at least 8 characters.');
      }
      const agentExpiresAt = new Date(agentExpiryLocal);
      if (Number.isNaN(agentExpiresAt.getTime()) || agentExpiresAt <= new Date()) {
        throw new Error('Choose an agent key expiry time in the future.');
      }

      const openfortAccessToken = await getAccessToken();
      if (!openfortAccessToken) {
        throw new Error('Openfort session is not ready. Refresh and sign in again.');
      }

      let createdAccount: unknown;
      if (!embeddedWallet.address) {
        createdAccount = await embeddedWallet.create({
          chainId: selectedChainId,
          accountType: AccountTypeEnum.SMART_ACCOUNT,
          recoveryMethod: RecoveryMethod.PASSWORD,
          password: recoveryPassword,
        });
        await openfort.updateEmbeddedAccounts({ silent: true });
      }

      const { address, accountId } = resolveEmbeddedWallet(createdAccount, embeddedWallet);
      await embeddedWallet.setActive({
        address,
        chainId: selectedChainId,
        recoveryMethod: RecoveryMethod.PASSWORD,
        password: recoveryPassword,
      });

      if (!publicClient) {
        throw new Error('Cannot check gas balance for this chain. Please retry after the network is ready.');
      }

      const nativeSymbol = publicClient.chain?.nativeCurrency.symbol ?? 'native gas token';
      const nativeBalance = await publicClient.getBalance({ address });
      if (nativeBalance === 0n) {
        throw new Error(
          `Your wallet has no ${nativeSymbol} for gas. Deposit ${nativeSymbol} to ${address} and retry agent registration.`,
        );
      }

      const authorized = await authorizeEmbeddedWallet(getToken, {
        openfortAccessToken,
        embeddedWalletAddress: address,
        embeddedOpenfortAccountId: accountId,
        chainId: selectedChainId,
        agentExpiresAt: agentExpiresAt.toISOString(),
      });

      const agentKey: CaliburKey = {
        keyType: KeyType.Secp256k1,
        publicKey: padHex(authorized.agentRegistration.agentAddress as Hex, { size: 32 }),
      };
      const frontendKeyHash = hashKey(agentKey);
      if (frontendKeyHash.toLowerCase() !== authorized.agentRegistration.keyHash.toLowerCase()) {
        throw new Error('Agent key hash mismatch. Please retry wallet setup.');
      }

      const expiration = Math.floor(new Date(authorized.agentRegistration.expiresAt).getTime() / 1000);
      const txData = encodeExecute([
        encodeRegisterKey(agentKey),
        encodeUpdateKeySettings(frontendKeyHash, {
          isAdmin: false,
          expiration,
          hook: zeroAddress,
        }),
      ]);

      const estimatedGas = await publicClient.estimateGas({
        account: address,
        to: address,
        data: txData,
      });
      const fees = await publicClient.estimateFeesPerGas().catch(() => null);
      const gasPrice = fees?.maxFeePerGas ?? (await publicClient.getGasPrice());
      const requiredGasBalance = estimatedGas * gasPrice;
      const requiredGasBalanceWithBuffer = requiredGasBalance + requiredGasBalance / 5n;

      if (nativeBalance < requiredGasBalanceWithBuffer) {
        throw new Error(
          `Your ${nativeSymbol} balance is too low to register the agent key. Current: ${formatNativeAmount(nativeBalance)} ${nativeSymbol}; estimated needed: ${formatNativeAmount(requiredGasBalanceWithBuffer)} ${nativeSymbol}. Deposit gas to ${address} and retry.`,
        );
      }

      const txHash = await sendTransactionAsync({ to: address, data: txData });
      const pending = await markAgentRegistrationTransaction(getToken, { txHash });
      setWallet(pending.wallet);

      if (!publicClient) {
        setWalletSetupSuccess(`Agent key registration pending. We will check again next time: ${txHash}`);
        return;
      }

      let receipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>;
      try {
        receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
          timeout: AGENT_REGISTRATION_RECEIPT_TIMEOUT_MS,
        });
      } catch {
        setWalletSetupSuccess(`Agent key registration pending. We will check again next time: ${txHash}`);
        return;
      }

      const registrationStatus = receipt.status === 'success' ? 'registered' : 'registration_failed';
      const result = await markAgentRegistrationResult(getToken, {
        txHash,
        status: registrationStatus,
      });

      setWallet(result.wallet);
      if (registrationStatus === 'registered') {
        setWalletSetupSuccess(`Agent key registration succeeded: ${txHash}`);
      } else {
        setWalletSetupError(`Agent key registration failed: ${txHash}`);
      }
    } catch (err: unknown) {
      setWalletSetupError(getApiErrorMessage(err));
    } finally {
      setWalletSetupLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-border border-t-brand-accent" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-6xl flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm">
        <AlertCircle className="h-5 w-5 shrink-0 text-red-500" />
        {error}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-10 pb-16">
      <div className="border-b border-brand-border pb-6">
        <h1 className="text-3xl font-bold font-serif text-brand-text">Wallet Overview</h1>
        <p className="mt-2 text-sm text-brand-muted">Manage your TEE-secured wallet and balances</p>
      </div>

      {apiKeyDisplay && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
          <p className="text-sm font-medium text-amber-800 mb-2">
            Your API key (save it — shown only once):
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
        <div className="rounded-2xl border border-brand-border bg-white p-7 shadow-xl relative overflow-hidden ring-1 ring-black/5">
          <div className="absolute top-0 left-0 w-full h-1.5 bg-brand-text" />

          <div className="mt-0 space-y-6">
            <div>
              <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Address</label>
              <div className="mt-1 flex items-center gap-3">
                <p className="break-all font-mono text-sm text-brand-text flex-1">
                  {wallet.walletAddress ?? 'Connect an embedded wallet to finish setup'}
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
                    Backend Agent Wallet
                  </span>
                  <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-brand-muted ring-1 ring-brand-border/60">
                    {formatAgentStatus(wallet.agentStatus)}
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
                onSubmit={handleSetupEmbeddedWallet}
                className="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm"
              >
                <div className="mb-4">
                  <h2 className="font-serif text-xl font-bold text-brand-text">
                    Connect your Openfort embedded wallet
                  </h2>
                  <p className="mt-1 text-sm text-amber-800">
                    This creates or activates your user smart wallet, asks it to register the backend
                    agent key on Calibur, then uses that key for API-key transaction execution.
                  </p>
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

                <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
                  <div className="flex-1">
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
                  <div className="flex-1">
                    <label className="mb-2 block text-[11px] font-bold uppercase tracking-widest text-brand-muted">
                      Agent Key Expiry
                    </label>
                    <input
                      type="datetime-local"
                      value={agentExpiryLocal}
                      min={formatDateTimeLocal(new Date(Date.now() + 60_000))}
                      onChange={(event) => setAgentExpiryLocal(event.target.value)}
                      required
                      className="block w-full rounded-lg border border-amber-200 bg-white px-4 py-2.5 text-sm text-brand-text shadow-sm placeholder:text-brand-muted focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent"
                    />
                    <p className="mt-1 text-xs text-amber-800">
                      API-key transactions stop when this Calibur agent key expires.
                    </p>
                  </div>
                  <button
                    type="submit"
                    disabled={walletSetupLoading || registerTxPending}
                    className="flex items-center justify-center gap-2 rounded-full bg-brand-text px-8 py-2.5 text-sm font-semibold text-white shadow-lg transition-all hover:-translate-y-0.5 hover:bg-brand-text/90 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {(walletSetupLoading || registerTxPending) && (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    )}
                    <span>{registerTxPending ? 'Confirming...' : 'Create & Register Agent'}</span>
                  </button>
                </div>
              </form>
            )}

            <div className="pt-6 border-t border-brand-border">
              <div className="mb-5 flex items-center justify-between">
                <label className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Assets</label>
                <select
                  value={selectedChainId}
                  onChange={(e) => setSelectedChainId(Number(e.target.value))}
                  className="rounded-lg border border-brand-border bg-white px-3 py-1.5 text-sm font-medium text-brand-text shadow-sm focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent transition-colors cursor-pointer hover:bg-brand-bg/50"
                >
                  <option value={84532}>Base Sepolia</option>
                  <option value={8453}>Base</option>
                  <option value={1}>Ethereum</option>
                  <option value={11155111}>Ethereum Sepolia</option>
                  <option value={137}>Polygon</option>
                  <option value={80002}>Polygon Amoy</option>
                </select>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {balancesLoading ? (
                  <>
                    <div className="h-16 rounded-xl border border-brand-border/40 bg-brand-bg/30 animate-pulse"></div>
                    <div className="h-16 rounded-xl border border-brand-border/40 bg-brand-bg/30 animate-pulse"></div>
                  </>
                ) : balancesError ? (
                  <div className="sm:col-span-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm">
                    {balancesError}
                  </div>
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
                  <div className="mb-6 flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 p-4 text-sm font-medium text-green-800 shadow-sm">
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500" />
                    <span>{withdrawResult}</span>
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
                        <option value={84532}>Base Sepolia</option>
                        <option value={8453}>Base</option>
                        <option value={1}>Ethereum</option>
                        <option value={11155111}>Ethereum Sepolia</option>
                        <option value={137}>Polygon</option>
                        <option value={80002}>Polygon Amoy</option>
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
        </div>
      )}

    </div>
  );
}
