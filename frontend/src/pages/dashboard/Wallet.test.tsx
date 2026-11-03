import { act, fireEvent, render as renderWithoutRouter, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { baseSepolia } from 'viem/chains';
import { padHex, zeroAddress, type Hex } from 'viem';
import { CALIBUR_ADDRESSES, CALIBUR_DELEGATION_CODES, encodeUpdateKeySettings, hashKey, KeyType } from '../../../../src/common/calibur/calibur-primitives';
import WalletPage from './Wallet';
import { readOperation, saveOperation, type WithdrawalIntent } from './wallet-recovery';

const render = (ui: ReactElement) => renderWithoutRouter(ui, { wrapper: MemoryRouter });

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(async () => 'test-token'),
  getMe: vi.fn(), authorize: vi.fn(), create: vi.fn(),
  providerAuthenticated: true,
  update: vi.fn(), setActive: vi.fn(), user: { id: 'user-1' }, hookAddress: undefined as string | undefined, providerRequest: vi.fn(async () => ['0x1111111111111111111111111111111111111111']),
  publicClient: undefined as any,
  signAuthorization: vi.fn(), createCaliburAccount: vi.fn(),
  createBundlerClient: vi.fn(), createPaymasterClient: vi.fn(), sendUserOperation: vi.fn(),
  waitForUserOperationReceipt: vi.fn(), markTransaction: vi.fn(), markResult: vi.fn(),
  withdraw: vi.fn(), transactionDetail: vi.fn(),
  stepUpToken: vi.fn(), requestStepUpToken: vi.fn(),
  session: { sessionId: 'session-1', userId: 'user-1', mfaVerified: true },
}));

vi.mock('@/components/AppSessionProvider', () => ({
  useAppSession: () => ({ session: mocks.session, loading: false }),
}));
vi.mock('@/pages/EmailOtpForm', () => ({ default: () => <p>Wallet identity reconnection form</p> }));
vi.mock('@openfort/react', () => ({
  AccountTypeEnum: { EOA: 'EOA' }, RecoveryMethod: { PASSWORD: 'PASSWORD' },
  useUser: () => ({ getAccessToken: mocks.getAccessToken, isAuthenticated: mocks.providerAuthenticated, isLoading: false, user: mocks.user }),
  useOpenfort: () => ({ updateEmbeddedAccounts: mocks.update, client: { embeddedWallet: { getEthereumProvider: vi.fn(async () => ({ request: mocks.providerRequest })) } } }),
  use7702Authorization: () => ({ signAuthorization: mocks.signAuthorization }),
}));
vi.mock('@openfort/react/ethereum', () => ({
  useEthereumEmbeddedWallet: () => ({ address: mocks.hookAddress, create: mocks.create, setActive: mocks.setActive, provider: { request: mocks.providerRequest } }),
}));
vi.mock('wagmi', () => ({ usePublicClient: () => mocks.publicClient }));
vi.mock('./wallet-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./wallet-helpers')>()),
  delay: vi.fn(async () => undefined),
  getUserOperationGasPrice: vi.fn(async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })),
}));
vi.mock('viem/account-abstraction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem/account-abstraction')>()),
  createBundlerClient: mocks.createBundlerClient,
  createPaymasterClient: mocks.createPaymasterClient,
}));
vi.mock('./step-up', () => ({ requestStepUpToken: mocks.requestStepUpToken }));
vi.mock('./step-up-session', () => ({ getDashboardStepUpToken: mocks.stepUpToken }));
vi.mock('@/lib/api', () => ({
  DEFAULT_CHAIN_ID: 84532, getMe: mocks.getMe,
  authorizeEmbeddedWallet: mocks.authorize,
  getBalancesAuth: vi.fn(async () => ({ chains: [] })),
  withdrawAuth: mocks.withdraw,
  getTransactionDetailAuth: mocks.transactionDetail,
  listWithdrawalAddressesAuth: vi.fn(async () => ({ addresses: [], policy: { newAddressCooldownHours: 24 } })),
  markAgentRegistrationTransaction: mocks.markTransaction,
  markAgentRegistrationResult: mocks.markResult,
  isApiError: (error: unknown) => typeof error === 'object' && error !== null && 'statusCode' in error,
  getApiErrorMessage: (e: unknown) => e instanceof Error ? e.message : String(e),
  hasApiErrorCode: (error: unknown, ...codes: string[]) => typeof error === 'object' && error !== null &&
    'code' in error && typeof error.code === 'string' && codes.includes(error.code),
}));
vi.mock('@/lib/calibur', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/calibur')>()),
  createCaliburAccount: mocks.createCaliburAccount,
}));

const address = '0x1111111111111111111111111111111111111111';
const addressA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const addressB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const created = { id: 'wallet-B', walletAddress: address, signerAddress: null, agentKeyHash: null, chainAuthorizations: [], isDefault: true };

async function setupRegistrationRpc(chainId: number, feeSponsorshipId?: string, walletCode: Hex = '0x', clientChainId = chainId) {
  vi.stubEnv('VITE_OPENFORT_FEE_SPONSORSHIP_ID', feeSponsorshipId ?? '');
  window.localStorage.setItem('sofa-one.wallet.agentChainId', String(chainId));
  const agentKeyHash = hashKey({ keyType: KeyType.Secp256k1, publicKey: padHex(addressB as Hex, { size: 32 }) });
  const authorizedWallet = {
    ...created,
    signerAddress: addressB,
    agentKeyHash,
    chainAuthorizations: [{ chainId, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), status: 'authorized' }],
  };
  mocks.getMe.mockResolvedValue({ wallet: { ...authorizedWallet, chainAuthorizations: [] }, wallets: [{ ...authorizedWallet, chainAuthorizations: [] }] });
  mocks.update.mockResolvedValue([{ id: 'account-A', address }]);
  mocks.providerRequest.mockResolvedValue([address]);
  mocks.setActive.mockResolvedValue(undefined);
  mocks.authorize.mockResolvedValue({ wallet: authorizedWallet, wallets: [authorizedWallet] });
  const getCode = vi.fn(async ({ address: queried }: { address: string }) => {
    if (queried.toLowerCase() === address.toLowerCase()) return walletCode;
    if ((CALIBUR_ADDRESSES as readonly string[]).includes(queried)) return '0x1234' as Hex;
    throw new Error('Unexpected Calibur deployment probe');
  });
  const getBalance = vi.fn(async () => 0n);
  const getTransactionCount = vi.fn(async () => 7);
  mocks.publicClient = {
    chain: { ...baseSepolia, id: clientChainId, nativeCurrency: { ...baseSepolia.nativeCurrency, symbol: chainId === 143 ? 'MON' : 'ETH' } },
    getCode,
    getBalance,
    getTransactionCount,
  };

  const view = render(<WalletPage />);
  await screen.findByRole('button', { name: 'Authorize API Access' });
  fireEvent.change(screen.getByPlaceholderText('Enter the password you created in Step 1'), { target: { value: 'password-123' } });
  fireEvent.change(document.querySelector('input[type="datetime-local"]')!, { target: { value: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 16) } });
  fireEvent.click(screen.getByRole('button', { name: 'Authorize API Access' }));
  return { getCode, getBalance, getTransactionCount, view };
}

function readyWallet(expiresAt = new Date(Date.now() + 86_400_000).toISOString()) {
  return {
    ...created, signerAddress: addressB,
    agentKeyHash: hashKey({ keyType: KeyType.Secp256k1, publicKey: padHex(addressB as Hex, { size: 32 }) }),
    chainAuthorizations: [{ chainId: 84532, status: 'registered', registrationTxHash: null, expiresAt }],
  };
}

async function openWithdrawal() {
  const wallet = readyWallet();
  mocks.getMe.mockResolvedValue({ wallet, wallets: [wallet] });
  const view = render(<WalletPage />);
  const openButton = await screen.findByRole('button', { name: 'Withdraw' });
  await act(async () => { fireEvent.click(openButton); });
  fireEvent.change(screen.getByPlaceholderText('0x...'), { target: { value: addressA } });
  fireEvent.change(screen.getByPlaceholderText('1.00'), { target: { value: '1.50' } });
  return { view, wallet, form: screen.getByRole('button', { name: 'Send Withdrawal' }).closest('form')! };
}

describe('WalletPage provisioning identity', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.stubEnv('VITE_OPENFORT_PUBLISHABLE_KEY', 'pk-test');
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.session = { sessionId: 'session-1', userId: 'user-1', mfaVerified: true };
    window.sessionStorage.clear();
    mocks.stepUpToken.mockReset().mockReturnValue('proof');
    mocks.requestStepUpToken.mockReset().mockResolvedValue('proof');
    mocks.withdraw.mockReset();
    mocks.transactionDetail.mockReset();
    mocks.markTransaction.mockReset();
    mocks.markResult.mockReset();
    mocks.waitForUserOperationReceipt.mockReset().mockResolvedValue({ receipt: { transactionHash: '0xtx' } });
    mocks.providerAuthenticated = true;
    mocks.hookAddress = undefined;
    mocks.publicClient = undefined;
    mocks.getAccessToken.mockResolvedValue('test-token');
    mocks.getMe.mockResolvedValue({ wallet: { id: 'empty', walletAddress: null, chainAuthorizations: [], isDefault: true } });
    mocks.create.mockResolvedValue({ id: 'account-B', address });
    mocks.update.mockResolvedValue([{ id: 'account-B', address }]);
    mocks.authorize.mockResolvedValue({ wallet: created });
    mocks.signAuthorization.mockResolvedValue('0xsigned');
    mocks.createCaliburAccount.mockRejectedValue(new Error('account construction sentinel'));
    mocks.createPaymasterClient.mockReturnValue({ paymaster: true });
    mocks.createBundlerClient.mockReturnValue({
      sendUserOperation: mocks.sendUserOperation,
      waitForUserOperationReceipt: mocks.waitForUserOperationReceipt,
    });
    mocks.sendUserOperation.mockResolvedValue('0xuserop');
  });

  it('loads app-cookie wallet data while requesting separate Openfort reconnection', async () => {
    mocks.providerAuthenticated = false;
    mocks.getMe.mockResolvedValue({ wallet: created, wallets: [created] });
    render(<WalletPage />);
    expect(await screen.findByText('Wallet identity reconnection form')).toBeInTheDocument();
    expect((await screen.findAllByText(address)).length).toBeGreaterThan(0);
    expect(mocks.getAccessToken).not.toHaveBeenCalled();
  });

  it('keeps wallet identity correction available even while the provider is authenticated', async () => {
    render(<WalletPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect wallet identity' }));
    expect(await screen.findByText('Wallet identity reconnection form')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Agent Wallet' })).toBeInTheDocument();
  });

  it('requests wallet reauthentication without retrying an invalid identity bearer', async () => {
    mocks.authorize.mockRejectedValueOnce(Object.assign(new Error('Reconnect wallet identity'), { code: 'AUTH_PROVIDER_INVALID' }));
    render(<WalletPage />);
    await screen.findByRole('button', { name: 'Create EOA' });
    fireEvent.change(screen.getByPlaceholderText('At least 8 characters'), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create EOA' }));
    expect(await screen.findByText('Wallet identity reconnection form')).toBeInTheDocument();
    expect(mocks.authorize).toHaveBeenCalledTimes(1);
  });

  it('separates user wallet and TEE signer identity without implying authorization', async () => {
    const wallet = { ...created, signerAddress: addressB, chainAuthorizations: [] };
    mocks.getMe.mockResolvedValue({ wallet, wallets: [wallet] });
    render(<WalletPage />);
    const walletLabel = await screen.findByText('Wallet Address');
    const signerLabel = screen.getByText('Signer Address');
    expect(walletLabel.parentElement?.textContent).toContain(address);
    expect(walletLabel.parentElement?.textContent).toContain('EIP-7702');
    expect(signerLabel.closest('.rounded-xl')?.textContent).toContain(addressB);
    expect(screen.getByText(/This address alone does not establish authorization/)).toBeTruthy();
    expect(screen.queryByText('Authorized Signer')).toBeNull();
    expect(screen.getByText('0 networks configured')).toBeTruthy();
    expect(mocks.signAuthorization).not.toHaveBeenCalled();
  });

  it('authorizes the created provider identity even when response has no openfortAccountId', async () => {
    render(<WalletPage />);
    await screen.findByRole('button', { name: 'Create EOA' });
    fireEvent.change(screen.getByPlaceholderText('At least 8 characters'), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create EOA' }));
    await waitFor(() => expect(mocks.authorize).toHaveBeenCalledWith('test-token', {
      embeddedWalletAddress: address, embeddedOpenfortAccountId: 'account-B',
    }));
    expect((await screen.findAllByText(address)).length).toBeGreaterThan(0);
    mocks.hookAddress = address;
    fireEvent.click(screen.getByRole('button', { name: 'Add wallet' }));
    fireEvent.change(screen.getByLabelText(/New wallet recovery password/i), { target: { value: 'another wallet password' } });
    fireEvent.change(screen.getByLabelText(/Confirm password/i), { target: { value: 'another wallet password' } });
    mocks.create.mockResolvedValueOnce({ id: 'account-C', address: addressA });
    const walletC = { ...created, id: 'wallet-C', walletAddress: addressA };
    mocks.update.mockResolvedValueOnce([{ id: 'account-B', address }, { id: 'account-C', address: addressA }]);
    mocks.authorize.mockResolvedValueOnce({ wallet: walletC, wallets: [created, walletC] });
    fireEvent.click(screen.getByRole('button', { name: 'Create new wallet' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
    expect(mocks.authorize).toHaveBeenLastCalledWith('test-token', {
      embeddedWalletAddress: addressA, embeddedOpenfortAccountId: 'account-C',
    });
  });

  it('retains the created B identity when account refresh fails and retries without creating again', async () => {
    const walletA = { ...created, id: 'wallet-A', walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', openfortAccountId: 'account-A' };
    const walletB = { ...created, id: 'wallet-B', walletAddress: address, openfortAccountId: 'account-B' };
    mocks.getMe.mockResolvedValue({ wallet: walletA, wallets: [walletA] });
    mocks.update.mockRejectedValueOnce(new Error('refresh offline')).mockResolvedValue([
      { id: 'account-A', address: walletA.walletAddress }, { id: 'account-B', address },
    ]);
    mocks.authorize.mockResolvedValue({ wallet: walletB, wallets: [walletA, walletB] });
    render(<WalletPage />);
    await screen.findAllByText(walletA.walletAddress);
    fireEvent.click(screen.getByRole('button', { name: 'Add wallet' }));
    fireEvent.change(screen.getByLabelText(/New wallet recovery password/i), { target: { value: 'new wallet password' } });
    fireEvent.change(screen.getByLabelText(/Confirm password/i), { target: { value: 'new wallet password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create new wallet' }));
    await screen.findAllByText(/refresh offline/);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    mocks.hookAddress = address;
    fireEvent.click(screen.getByRole('button', { name: 'Create new wallet' }));
    await waitFor(() => expect(mocks.authorize).toHaveBeenCalledWith('test-token', expect.objectContaining({
      embeddedWalletAddress: address, embeddedOpenfortAccountId: 'account-B',
    })));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect((await screen.findAllByText(walletB.walletAddress)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Add wallet' }));
    fireEvent.change(screen.getByLabelText(/New wallet recovery password/i), { target: { value: 'another wallet password' } });
    fireEvent.change(screen.getByLabelText(/Confirm password/i), { target: { value: 'another wallet password' } });
    mocks.create.mockResolvedValueOnce({ id: 'account-C', address: addressA });
    mocks.update.mockResolvedValueOnce([{ id: 'account-A', address: addressA }, { id: 'account-B', address }, { id: 'account-C', address: addressA }]);
    mocks.authorize.mockResolvedValueOnce({ wallet: { ...walletB, id: 'wallet-C', walletAddress: addressA }, wallets: [walletA, walletB, { ...walletB, id: 'wallet-C', walletAddress: addressA }] });
    fireEvent.click(screen.getByRole('button', { name: 'Create new wallet' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
  });

  it('keeps an ambiguous create failure blocked after the SDK hook reports an address', async () => {
    mocks.create.mockRejectedValueOnce(new Error('timeout'));
    render(<WalletPage />);
    await screen.findByRole('button', { name: 'Create EOA' });
    fireEvent.change(screen.getByPlaceholderText('At least 8 characters'), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create EOA' }));
    await screen.findAllByText(/could not confirm account creation/i);
    mocks.hookAddress = addressB;
    fireEvent.click(screen.getByRole('button', { name: 'Create EOA' }));
    await screen.findAllByText(/Do not retry account creation/i);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it('does not authorize when refreshed accounts are ordered B then A, and uses the live selected provider for A', async () => {
    const walletA = { ...created, id: 'wallet-A', walletAddress: addressA, openfortAccountId: 'account-A', signerAddress: addressB, agentKeyHash: '0x' + '1'.repeat(64), chainAuthorizations: [] };
    const walletB = { ...walletA, id: 'wallet-B', walletAddress: addressB, openfortAccountId: 'account-B' };
    mocks.getMe.mockResolvedValue({ wallet: walletA, wallets: [walletA, walletB] });
    mocks.update.mockResolvedValue([{ id: 'account-B', address: addressB }, { id: 'account-A', address: addressA }]);
    mocks.providerRequest.mockResolvedValue([addressA]);
    mocks.setActive.mockResolvedValue(undefined);
    mocks.authorize.mockRejectedValue(new Error('authorize sentinel'));
    render(<WalletPage />);
    await screen.findByLabelText('Selected wallet');
    fireEvent.change(screen.getByLabelText('Selected wallet'), { target: { value: 'wallet-A' } });
    fireEvent.change(screen.getByPlaceholderText('Enter the password you created in Step 1'), { target: { value: 'password-123' } });
    fireEvent.change(document.querySelector('input[type="datetime-local"]')!, { target: { value: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 16) } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize API Access' }));
    await screen.findAllByText('authorize sentinel');
    expect(mocks.authorize).toHaveBeenCalledWith('test-token', expect.objectContaining({ embeddedWalletAddress: addressA, embeddedOpenfortAccountId: 'account-A' }));
    expect(mocks.setActive).toHaveBeenCalledWith(expect.objectContaining({ address: addressA }));
  });

  it('rejects a live provider on B even when the SDK hook reports A active', async () => {
    const walletA = { ...created, id: 'wallet-A', walletAddress: addressA, openfortAccountId: 'account-A', signerAddress: addressB, agentKeyHash: '0x' + '1'.repeat(64), chainAuthorizations: [] };
    const walletB = { ...walletA, id: 'wallet-B', walletAddress: addressB, openfortAccountId: 'account-B' };
    mocks.getMe.mockResolvedValue({ wallet: walletA, wallets: [walletA, walletB] });
    mocks.update.mockResolvedValue([{ id: 'account-A', address: addressA }, { id: 'account-B', address: addressB }]);
    mocks.providerRequest.mockResolvedValue([addressB]);
    mocks.setActive.mockResolvedValue(undefined);
    render(<WalletPage />);
    await screen.findByLabelText('Selected wallet');
    fireEvent.change(screen.getByLabelText('Selected wallet'), { target: { value: 'wallet-A' } });
    fireEvent.change(screen.getByPlaceholderText('Enter the password you created in Step 1'), { target: { value: 'password-123' } });
    fireEvent.change(document.querySelector('input[type="datetime-local"]')!, { target: { value: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 16) } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize API Access' }));
    await screen.findAllByText('Openfort could not confirm the selected wallet is active. No authorization was signed.');
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it('synchronously ignores a duplicate agent registration submit while the first is pending', async () => {
    const wallet = {
      ...created,
      walletAddress: address,
      openfortAccountId: 'account-A',
      signerAddress: addressB,
      agentKeyHash: `0x${'1'.repeat(64)}`,
      chainAuthorizations: [],
    };
    mocks.getMe.mockResolvedValue({ wallet, wallets: [wallet] });
    mocks.update.mockResolvedValue([{ id: 'account-A', address }]);
    mocks.providerRequest.mockResolvedValue([address]);
    mocks.setActive.mockResolvedValue(undefined);
    let finish!: (error: Error) => void;
    mocks.authorize.mockReturnValue(new Promise((_resolve, reject) => { finish = reject; }));
    render(<WalletPage />);
    await screen.findByRole('button', { name: 'Authorize API Access' });
    fireEvent.change(screen.getByPlaceholderText('Enter the password you created in Step 1'), { target: { value: 'password-123' } });
    fireEvent.change(document.querySelector('input[type="datetime-local"]')!, { target: { value: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 16) } });
    const form = screen.getByRole('button', { name: 'Authorize API Access' }).closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => expect(mocks.authorize).toHaveBeenCalledTimes(1));
    // Dispatch the form event directly: disabled-button prevention cannot mask a missing ref guard.
    fireEvent.submit(form);
    expect(mocks.authorize).toHaveBeenCalledTimes(1);
    finish(new Error('test settled'));
    await screen.findAllByText('test settled');
  });

  it('skips native balance lookup for sponsored non-Monad registration but still checks EOA code', async () => {
    const { getCode, getBalance } = await setupRegistrationRpc(84532, 'policy-1');
    await waitFor(() => expect(getCode).toHaveBeenCalledWith({ address }));
    await screen.findAllByText('account construction sentinel');
    expect(getBalance).not.toHaveBeenCalled();
    expect(getCode).toHaveBeenCalledWith({ address });
  });

  it('rejects a mismatched RPC chain before inspecting an existing delegation', async () => {
    const delegatedCode = CALIBUR_DELEGATION_CODES[0];
    const { getCode } = await setupRegistrationRpc(137, 'policy-1', delegatedCode, 1);
    await screen.findAllByText(/does not match requested chain/i);
    expect(getCode).not.toHaveBeenCalled();
    expect(mocks.createCaliburAccount).not.toHaveBeenCalled();
    expect(mocks.signAuthorization).not.toHaveBeenCalled();
  });

  it('submits sponsored non-Monad registration with policy context and authorization', async () => {
    vi.stubEnv('VITE_OPENFORT_PUBLISHABLE_KEY', 'publishable-test');
    mocks.createCaliburAccount.mockResolvedValue({ address });
    const { getCode, getTransactionCount } = await setupRegistrationRpc(137, 'policy-1');
    await waitFor(() => expect(mocks.sendUserOperation).toHaveBeenCalledTimes(1));
    expect(getCode).toHaveBeenCalledWith({ address });
    expect(getTransactionCount).toHaveBeenCalledWith({ address, blockTag: 'pending' });
    expect(mocks.signAuthorization).toHaveBeenCalled();
    expect(mocks.createPaymasterClient).toHaveBeenCalledTimes(1);
    expect(mocks.createBundlerClient).toHaveBeenCalledWith(expect.objectContaining({ paymaster: { paymaster: true } }));
    expect(mocks.sendUserOperation).toHaveBeenCalledWith(expect.objectContaining({
      authorization: '0xsigned',
      paymasterContext: { policyId: 'policy-1' },
    }));
  });

  it('reads zero native balance and rejects an unsponsored registration', async () => {
    const { getCode, getBalance } = await setupRegistrationRpc(137);
    await waitFor(() => expect(getBalance).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelector('#wallet-authorize-access button[type="submit"]')).toBeEnabled());
    expect(mocks.sendUserOperation).not.toHaveBeenCalled();
    expect(mocks.signAuthorization).not.toHaveBeenCalled();
    expect(getCode).toHaveBeenCalledWith({ address });
  });

  it('reads native balance on Monad even when a sponsorship id is configured', async () => {
    const { getCode, getBalance } = await setupRegistrationRpc(143, 'policy-1');
    await screen.findAllByText(/has no MON for gas/i);
    expect(getBalance).toHaveBeenCalledTimes(1);
    expect(getCode).toHaveBeenCalled();
    expect(getCode).toHaveBeenCalledWith({ address });
  });

  it.each([0, 1])('uses the existing delegated %s Calibur address without deployment scans', async (index) => {
    const delegatedCode = CALIBUR_DELEGATION_CODES[index].toUpperCase().replace('0X', '0x') as Hex;
    const { getCode } = await setupRegistrationRpc(137, 'policy-1', delegatedCode);
    await screen.findAllByText('account construction sentinel');
    expect(getCode.mock.calls.map(([args]) => args.address)).toEqual([address]);
    expect(mocks.createCaliburAccount).toHaveBeenCalledWith(expect.objectContaining({
      authorizationAddress: CALIBUR_ADDRESSES[index],
    }));
    expect(mocks.signAuthorization).not.toHaveBeenCalled();
  });

  it('uses the canonical Polygon address for a new authorization without candidate RPC calls', async () => {
    const { getCode, getTransactionCount } = await setupRegistrationRpc(137, 'policy-1');
    await screen.findAllByText('account construction sentinel');
    expect(getCode.mock.calls.map(([args]) => args.address)).toEqual([address]);
    expect(getTransactionCount).toHaveBeenCalledWith({ address, blockTag: 'pending' });
    expect(mocks.signAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      chainId: 137,
      nonce: 7,
      contractAddress: CALIBUR_ADDRESSES[0],
    }));
    expect(mocks.createCaliburAccount).toHaveBeenCalledWith(expect.objectContaining({
      authorizationAddress: CALIBUR_ADDRESSES[0],
    }));
  });

  it('rejects unsupported delegation without signing or constructing/sending an account', async () => {
    const { getCode, getTransactionCount } = await setupRegistrationRpc(137, 'policy-1', '0xef0100' + '12'.repeat(20) as Hex);
    await screen.findAllByText(/delegated to an unsupported contract/i);
    expect(getCode.mock.calls.map(([args]) => args.address)).toEqual([address]);
    expect(getTransactionCount).not.toHaveBeenCalled();
    expect(mocks.signAuthorization).not.toHaveBeenCalled();
    expect(mocks.createCaliburAccount).not.toHaveBeenCalled();
  });

  it('persists before submission and reuses the exact intent after a lost response, rapid submit and reload', async () => {
    let reject!: (error: Error) => void;
    mocks.withdraw.mockImplementationOnce(() => {
      const saved = readOperation<WithdrawalIntent>('withdrawal', 'user-1', created.id, address);
      expect(saved).toMatchObject({ to: addressA, amount: '1500000', chainId: 84532, token: 'USDC' });
      return new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });
    });
    const { view, form } = await openWithdrawal();
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(mocks.withdraw).toHaveBeenCalledTimes(1));
    const firstArgs = mocks.withdraw.mock.calls[0];
    reject(new Error('Response lost'));
    await screen.findByText('Response lost');
    expect(screen.queryByText(/Withdrawal confirmed/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw another' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('0x...'), { target: { value: addressB } });
    fireEvent.change(screen.getByPlaceholderText('1.00'), { target: { value: '99' } });
    mocks.withdraw.mockResolvedValueOnce({ transactionId: 'tx-1', transactionHash: null, status: 'unknown' });
    fireEvent.click(screen.getByRole('button', { name: 'Resume withdrawal' }));
    await waitFor(() => expect(mocks.withdraw).toHaveBeenCalledTimes(2));
    expect(mocks.withdraw.mock.calls[1]).toEqual(firstArgs);
    await screen.findByText('Transaction: tx-1');
    view.unmount();
    mocks.transactionDetail.mockResolvedValue({ id: 'tx-1', txHash: '0xconfirmed', status: 'confirmed' });
    render(<WalletPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume withdrawal' }));
    expect(await screen.findByText('Withdrawal confirmed.')).toBeInTheDocument();
    expect(mocks.withdraw).toHaveBeenCalledTimes(2);
    expect(mocks.transactionDetail).toHaveBeenCalledWith('tx-1');
  });

  it('replays a lost withdrawal response after reload with the original idempotency key', async () => {
    mocks.withdraw.mockRejectedValueOnce(new Error('offline'));
    const { view, form } = await openWithdrawal();
    fireEvent.submit(form);
    await screen.findByText('offline');
    const firstArgs = mocks.withdraw.mock.calls[0];
    view.unmount();
    mocks.withdraw.mockResolvedValue({ transactionId: 'tx-2', transactionHash: '0xpending', status: 'pending' });
    render(<WalletPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume withdrawal' }));
    await screen.findByText('Transaction: tx-2');
    expect(mocks.withdraw.mock.calls[1]).toEqual(firstArgs);
    expect(screen.queryByText(/Withdrawal confirmed/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send Withdrawal' })).toBeDisabled();
  });

  it('keeps definite first-request validation failures editable without reusing the rejected intent', async () => {
    mocks.withdraw.mockRejectedValueOnce(Object.assign(new Error('Insufficient balance'), { statusCode: 400 }));
    const { form } = await openWithdrawal();
    fireEvent.submit(form);
    await screen.findByText('Insufficient balance');
    expect(screen.getByRole('button', { name: 'Send Withdrawal' })).not.toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('1.00'), { target: { value: '0.50' } });
    mocks.withdraw.mockResolvedValueOnce({ transactionId: 'tx-3', transactionHash: null, status: 'pending' });
    fireEvent.submit(form);
    await screen.findByText('Transaction: tx-3');
    expect(mocks.withdraw.mock.calls[1][6]).not.toBe(mocks.withdraw.mock.calls[0][6]);
    expect(mocks.withdraw.mock.calls[1][1]).toBe('500000');
  });

  it('does not release an unknown withdrawal when a later retry receives a validation error', async () => {
    mocks.withdraw.mockRejectedValueOnce(new Error('lost'));
    const { form } = await openWithdrawal();
    fireEvent.submit(form);
    await screen.findByText('lost');
    mocks.withdraw.mockRejectedValueOnce(Object.assign(new Error('Authorization expired'), { statusCode: 400 }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume withdrawal' }));
    await screen.findByText('Authorization expired');
    expect(screen.getByRole('button', { name: 'Send Withdrawal' })).toBeDisabled();
    expect(readOperation<WithdrawalIntent>('withdrawal', 'user-1', created.id, address)?.idempotencyKey).toBe(mocks.withdraw.mock.calls[0][6]);
  });

  it('isolates saved withdrawals by user and wallet and ignores a replaced session response', async () => {
    let finish!: (result: unknown) => void;
    mocks.withdraw.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const { view, wallet, form } = await openWithdrawal();
    fireEvent.submit(form);
    await waitFor(() => expect(mocks.withdraw).toHaveBeenCalledTimes(1));
    const otherWallet = { ...wallet, id: 'wallet-other', walletAddress: addressB };
    mocks.getMe.mockResolvedValue({ wallet: otherWallet, wallets: [otherWallet] });
    mocks.session = { ...mocks.session, sessionId: 'session-2', userId: 'user-2' };
    view.rerender(<WalletPage />);
    await screen.findAllByText(addressB);
    finish({ transactionId: 'old-tx', transactionHash: '0xold', status: 'confirmed' });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText('Withdrawal confirmed.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume withdrawal' })).not.toBeInTheDocument();
    expect(readOperation<WithdrawalIntent>('withdrawal', 'user-2', wallet.id, address)).toBeNull();
    expect(readOperation<WithdrawalIntent>('withdrawal', 'user-1', 'wallet-other', addressB)).toBeNull();
    expect(readOperation<WithdrawalIntent>('withdrawal', 'user-1', wallet.id, address)?.idempotencyKey).toBe(mocks.withdraw.mock.calls[0][6]);
  });

  it('blocks wrong-chain withdrawals and offers the exact selected-chain authorization CTA', async () => {
    const { form } = await openWithdrawal();
    const chain = screen.getByRole('button', { name: 'Send Withdrawal' }).closest('form')!.querySelector('select')!;
    fireEvent.change(chain, { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Send Withdrawal' })).toBeDisabled();
    fireEvent.submit(form);
    expect(await screen.findByText('Authorize or renew API access on the selected withdrawal chain first.')).toBeInTheDocument();
    expect(mocks.withdraw).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Authorize / renew this chain' }));
    expect(document.querySelector<HTMLSelectElement>('#wallet-authorize-access select')?.value).toBe('1');
  });

  it('expires Ready and success while the wallet page stays open', async () => {
    const wallet = readyWallet(new Date(Date.now() + 1_500).toISOString());
    mocks.getMe.mockResolvedValue({ wallet, wallets: [wallet] });
    render(<WalletPage />);
    expect(await screen.findByText('Ready for API transactions')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Withdraw' })); });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2_000);
    try { fireEvent.focus(window); }
    finally { clock.mockRestore(); }
    expect(screen.queryByText('Ready for API transactions')).not.toBeInTheDocument();
    expect(screen.queryByText('Status: success')).not.toBeInTheDocument();
    expect(screen.getAllByText(/expired/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Send Withdrawal' })).toBeDisabled();
  });

  it('recovers a submitted userOp after receipt failure and reload without a signer connection or another send', async () => {
    mocks.createCaliburAccount.mockResolvedValue({});
    mocks.waitForUserOperationReceipt.mockImplementationOnce(async () => {
      const saved = readOperation('registration', 'user-1', created.id, address);
      expect(saved).toMatchObject({ chainId: 84532, walletId: created.id, userOpHash: '0xuserop' });
      throw new Error('bundler receipt offline');
    });
    const { view } = await setupRegistrationRpc(84532, 'policy-1');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry check' })).toBeEnabled());
    expect(document.querySelector('#wallet-authorize-access button[type="submit"]')).toBeDisabled();
    view.unmount();
    const wallet = readyWallet();
    mocks.publicClient.waitForTransactionReceipt = vi.fn(async () => ({ status: 'success' }));
    mocks.markTransaction.mockResolvedValue({ wallet: { ...wallet, chainAuthorizations: [{ ...wallet.chainAuthorizations[0], status: 'pending_registration', registrationTxHash: '0xtx' }] } });
    mocks.markResult.mockResolvedValue({ wallet, wallets: [wallet] });
    mocks.providerAuthenticated = false;
    render(<WalletPage />);
    await waitFor(() => expect(readOperation('registration', 'user-1', created.id, address)).toBeNull());
    expect(mocks.markTransaction).toHaveBeenCalledWith({ chainId: 84532, txHash: '0xtx', walletId: created.id });
    expect(mocks.sendUserOperation).toHaveBeenCalledTimes(1);
    expect(mocks.setActive).toHaveBeenCalledTimes(1);
    expect(readOperation('registration', 'user-1', created.id, address)).toBeNull();
  });

  it('retains local registration recovery when RPC is unavailable and resumes when it reconnects', async () => {
    const wallet = readyWallet();
    mocks.getMe.mockResolvedValue({ wallet, wallets: [wallet] });
    saveOperation('registration', { userId: 'user-1', walletId: wallet.id, walletAddress: address, chainId: 84532, userOpHash: '0xexisting' });
    mocks.providerAuthenticated = false;
    const view = render(<WalletPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry check' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Retry check' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry check' })).toBeEnabled());
    mocks.publicClient = { chain: baseSepolia, waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })) };
    mocks.markTransaction.mockResolvedValue({ wallet });
    mocks.markResult.mockResolvedValue({ wallet, wallets: [wallet] });
    view.rerender(<WalletPage />);
    await waitFor(() => expect(readOperation('registration', 'user-1', wallet.id, address)).toBeNull());
    expect(mocks.sendUserOperation).not.toHaveBeenCalled();
    expect(mocks.signAuthorization).not.toHaveBeenCalled();
  });

  it('synchronizes registration_required retries with the latest choice and encodes the authoritative returned expiry', async () => {
    const wallet = readyWallet();
    const requiredWallet = { ...wallet, chainAuthorizations: [{ ...wallet.chainAuthorizations[0], status: 'registration_required' }] };
    mocks.getMe.mockResolvedValue({ wallet: requiredWallet, wallets: [requiredWallet] });
    mocks.update.mockResolvedValue([{ id: 'account-A', address }]);
    mocks.setActive.mockResolvedValue(undefined);
    mocks.authorize.mockRejectedValueOnce(new Error('authorization response unavailable'));
    render(<WalletPage />);
    fireEvent.change(await screen.findByPlaceholderText('Enter the password you created in Step 1'), { target: { value: 'password-123' } });
    const expiryInput = document.querySelector('input[type="datetime-local"]')!;
    fireEvent.change(expiryInput, { target: { value: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16) } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize API Access' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Authorize API Access' })).toBeEnabled());
    const chosenExpiry = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 16);
    const authoritativeExpiry = new Date(Date.now() + 4 * 86_400_000).toISOString();
    mocks.authorize.mockResolvedValue({ wallet: { ...requiredWallet, chainAuthorizations: [{ ...requiredWallet.chainAuthorizations[0], expiresAt: authoritativeExpiry }] } });
    mocks.publicClient = {
      chain: baseSepolia, getCode: vi.fn(async () => CALIBUR_DELEGATION_CODES[0]), getBalance: vi.fn(async () => 1n),
    };
    mocks.createCaliburAccount.mockResolvedValue({});
    mocks.waitForUserOperationReceipt.mockRejectedValue(new Error('pending receipt'));
    fireEvent.change(expiryInput, { target: { value: chosenExpiry } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize API Access' }));
    await waitFor(() => expect(mocks.sendUserOperation).toHaveBeenCalledTimes(1));
    expect(mocks.authorize).toHaveBeenLastCalledWith('test-token', expect.objectContaining({ agentExpiresAt: new Date(chosenExpiry).toISOString() }));
    expect(mocks.sendUserOperation.mock.calls[0][0].calls[1].data).toBe(encodeUpdateKeySettings(wallet.agentKeyHash as Hex, {
      isAdmin: false, expiration: Math.floor(new Date(authoritativeExpiry).getTime() / 1000), hook: zeroAddress,
    }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry check' })).toBeEnabled());
  });

  it('refuses a new withdrawal when the durable journal cannot be written', async () => {
    const { form } = await openWithdrawal();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    try {
      fireEvent.submit(form);
      await screen.findByText('storage unavailable');
      expect(mocks.withdraw).not.toHaveBeenCalled();
    } finally { setItem.mockRestore(); }
  });

  it('does not sign again after a bundler response is lost before the userOp hash is known', async () => {
    mocks.createCaliburAccount.mockResolvedValue({});
    mocks.sendUserOperation.mockRejectedValueOnce(new Error('bundler response lost'));
    const { view } = await setupRegistrationRpc(84532, 'policy-1');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry check' })).toBeEnabled());
    expect(document.querySelector('#wallet-authorize-access button[type="submit"]')).toBeDisabled();
    view.unmount();
    render(<WalletPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry check' })).toBeEnabled());
    expect(mocks.sendUserOperation).toHaveBeenCalledTimes(1);
  });

  it('continues server-pending transaction recovery when no local journal is present', async () => {
    const wallet = readyWallet();
    const pending = { ...wallet, chainAuthorizations: [{ ...wallet.chainAuthorizations[0], status: 'pending_registration', registrationTxHash: '0xserverpending' }] };
    mocks.getMe.mockResolvedValue({ wallet: pending, wallets: [pending] });
    mocks.publicClient = { chain: baseSepolia, waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })) };
    mocks.markResult.mockResolvedValue({ wallet, wallets: [wallet] });
    mocks.providerAuthenticated = false;
    render(<WalletPage />);
    await screen.findByText('Ready for API transactions');
    expect(mocks.markResult).toHaveBeenCalledWith({ chainId: 84532, txHash: '0xserverpending', status: 'registered', walletId: wallet.id });
    expect(mocks.sendUserOperation).not.toHaveBeenCalled();
    expect(mocks.markTransaction).not.toHaveBeenCalled();
  });

  it('releases a fresh intent when step-up is cancelled before any withdrawal request', async () => {
    mocks.stepUpToken.mockReturnValue(undefined);
    mocks.requestStepUpToken.mockRejectedValueOnce(new Error('Step-up verification cancelled.'));
    const { form, wallet } = await openWithdrawal();
    fireEvent.submit(form);
    await screen.findByText('Step-up verification cancelled.');
    expect(mocks.withdraw).not.toHaveBeenCalled();
    expect(readOperation('withdrawal', 'user-1', wallet.id, address)).toBeNull();
    expect(screen.getByRole('button', { name: 'Send Withdrawal' })).toBeEnabled();
  });

  it('clears only the original no-send intent when its step-up resolves after session replacement', async () => {
    let finish!: (proof: string) => void;
    mocks.stepUpToken.mockReturnValue(undefined);
    mocks.requestStepUpToken.mockReturnValueOnce(new Promise<string>((resolve) => { finish = resolve; }));
    const { view, wallet, form } = await openWithdrawal();
    fireEvent.submit(form);
    await waitFor(() => expect(mocks.requestStepUpToken).toHaveBeenCalledTimes(1));
    const otherWallet = { ...wallet, id: 'wallet-other', walletAddress: addressB };
    const otherIntent: WithdrawalIntent = {
      userId: 'user-2', walletId: otherWallet.id, walletAddress: addressB, chainId: 84532,
      to: addressA, amount: '2000000', displayAmount: '2', token: 'USDC', idempotencyKey: 'other-intent', status: 'unknown',
    };
    saveOperation('withdrawal', otherIntent);
    mocks.getMe.mockResolvedValue({ wallet: otherWallet, wallets: [otherWallet] });
    mocks.session = { ...mocks.session, sessionId: 'session-2', userId: 'user-2' };
    view.rerender(<WalletPage />);
    await screen.findByText('Intent: other-intent');
    await act(async () => { finish('old-proof'); });
    expect(mocks.withdraw).not.toHaveBeenCalled();
    expect(readOperation('withdrawal', 'user-1', wallet.id, address)).toBeNull();
    expect(readOperation('withdrawal', 'user-2', otherWallet.id, addressB)).toEqual(otherIntent);
    expect(screen.getByRole('button', { name: 'Resume withdrawal' })).toBeEnabled();
  });

  it('journals a late bundler send response for its original user without replacing the new user operation', async () => {
    let finish!: (hash: string) => void;
    mocks.createCaliburAccount.mockResolvedValue({});
    mocks.sendUserOperation.mockReturnValueOnce(new Promise<string>((resolve) => { finish = resolve; }));
    const { view } = await setupRegistrationRpc(84532, 'policy-1');
    await waitFor(() => expect(mocks.sendUserOperation).toHaveBeenCalledTimes(1));
    const otherWallet = { ...readyWallet(), id: 'wallet-other', walletAddress: addressB };
    saveOperation('registration', { userId: 'user-2', walletId: otherWallet.id, walletAddress: addressB, chainId: 84532, userOpHash: '0xnewoperation' });
    mocks.getMe.mockResolvedValue({ wallet: otherWallet, wallets: [otherWallet] });
    mocks.session = { ...mocks.session, sessionId: 'session-2', userId: 'user-2' };
    mocks.providerAuthenticated = false;
    mocks.waitForUserOperationReceipt.mockRejectedValue(new Error('new operation pending'));
    view.rerender(<WalletPage />);
    await screen.findAllByText(addressB);
    await act(async () => { finish('0xoldoperation'); });
    await waitFor(() => expect(mocks.waitForUserOperationReceipt).toHaveBeenCalledWith(expect.objectContaining({ hash: '0xnewoperation' })));
    expect(mocks.waitForUserOperationReceipt).not.toHaveBeenCalledWith(expect.objectContaining({ hash: '0xoldoperation' }));
    expect(readOperation('registration', 'user-1', created.id, address)).toMatchObject({ userOpHash: '0xoldoperation' });
    expect(readOperation('registration', 'user-2', otherWallet.id, addressB)).toMatchObject({ userOpHash: '0xnewoperation' });
    expect(mocks.markTransaction).not.toHaveBeenCalled();
  });

  it('persists a late receipt only to its original journal and never resumes it under a replacement session', async () => {
    let finish!: (receipt: { receipt: { transactionHash: string } }) => void;
    const wallet = readyWallet();
    mocks.getMe.mockResolvedValue({ wallet, wallets: [wallet] });
    mocks.publicClient = { chain: baseSepolia };
    mocks.providerAuthenticated = false;
    saveOperation('registration', { userId: 'user-1', walletId: wallet.id, walletAddress: address, chainId: 84532, userOpHash: '0xoldoperation' });
    mocks.waitForUserOperationReceipt.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const view = render(<WalletPage />);
    await waitFor(() => expect(mocks.waitForUserOperationReceipt).toHaveBeenCalledTimes(1));
    const otherWallet = { ...wallet, id: 'wallet-other', walletAddress: addressB };
    saveOperation('registration', { userId: 'user-2', walletId: otherWallet.id, walletAddress: addressB, chainId: 84532, userOpHash: '0xnewoperation' });
    mocks.getMe.mockResolvedValue({ wallet: otherWallet, wallets: [otherWallet] });
    mocks.session = { ...mocks.session, sessionId: 'session-2', userId: 'user-2' };
    mocks.waitForUserOperationReceipt.mockRejectedValue(new Error('new operation pending'));
    view.rerender(<WalletPage />);
    await waitFor(() => expect(mocks.waitForUserOperationReceipt).toHaveBeenCalledWith(expect.objectContaining({ hash: '0xnewoperation' })));
    await act(async () => { finish({ receipt: { transactionHash: '0xoldtx' } }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry check' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Retry check' }));
    await waitFor(() => expect(mocks.waitForUserOperationReceipt).toHaveBeenCalledTimes(3));
    expect(mocks.waitForUserOperationReceipt.mock.calls[2][0]).toMatchObject({ hash: '0xnewoperation' });
    expect(readOperation('registration', 'user-1', wallet.id, address)).toMatchObject({ userOpHash: '0xoldoperation', txHash: '0xoldtx' });
    expect(mocks.markTransaction).not.toHaveBeenCalled();
  });

});
