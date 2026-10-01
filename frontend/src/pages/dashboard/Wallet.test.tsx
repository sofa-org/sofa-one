import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WalletPage from './Wallet';

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(async () => 'test-token'),
  getMe: vi.fn(), syncSession: vi.fn(), authorize: vi.fn(), create: vi.fn(),
  update: vi.fn(), setActive: vi.fn(), user: { id: 'user-1' }, hookAddress: undefined as string | undefined, providerRequest: vi.fn(async () => ['0x1111111111111111111111111111111111111111']),
}));

vi.mock('@openfort/react', () => ({
  AccountTypeEnum: { EOA: 'EOA' }, RecoveryMethod: { PASSWORD: 'PASSWORD' },
  useUser: () => ({ getAccessToken: mocks.getAccessToken, isAuthenticated: true, isLoading: false, user: mocks.user }),
  useOpenfort: () => ({ updateEmbeddedAccounts: mocks.update, client: { embeddedWallet: { getEthereumProvider: vi.fn(async () => ({ request: mocks.providerRequest })) } } }),
  use7702Authorization: () => ({ signAuthorization: vi.fn() }),
}));
vi.mock('@openfort/react/ethereum', () => ({
  useEthereumEmbeddedWallet: () => ({ address: mocks.hookAddress, create: mocks.create, setActive: mocks.setActive, provider: { request: mocks.providerRequest } }),
}));
vi.mock('wagmi', () => ({ usePublicClient: () => undefined }));
vi.mock('./wallet-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./wallet-helpers')>()),
  delay: vi.fn(async () => undefined),
}));
vi.mock('@/lib/api', () => ({
  DEFAULT_CHAIN_ID: 84532, getMe: mocks.getMe, syncSession: mocks.syncSession,
  authorizeEmbeddedWallet: mocks.authorize,
  getBalancesAuth: vi.fn(async () => ({ chains: [] })),
  getApiErrorMessage: (e: unknown) => e instanceof Error ? e.message : String(e),
  hasApiErrorCode: () => false,
}));

const address = '0x1111111111111111111111111111111111111111';
const addressA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const addressB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const created = { id: 'wallet-B', walletAddress: address, agentWalletAddress: null, agentKeyHash: null, chainAuthorizations: [], isDefault: true };

describe('WalletPage provisioning identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hookAddress = undefined;
    mocks.getAccessToken.mockResolvedValue('test-token');
    mocks.getMe.mockResolvedValue({ wallet: { id: 'empty', walletAddress: null, chainAuthorizations: [], isDefault: true } });
    mocks.create.mockResolvedValue({ id: 'account-B', address });
    mocks.update.mockResolvedValue([{ id: 'account-B', address }]);
    mocks.authorize.mockResolvedValue({ wallet: created });
  });

  it('authorizes the created provider identity even when response has no openfortAccountId', async () => {
    render(<WalletPage />);
    await screen.findByRole('button', { name: 'Create EOA' });
    fireEvent.change(screen.getByPlaceholderText('At least 8 characters'), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create EOA' }));
    await waitFor(() => expect(mocks.authorize).toHaveBeenCalledWith(expect.any(Function), {
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
    expect(mocks.authorize).toHaveBeenLastCalledWith(expect.any(Function), {
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
    await waitFor(() => expect(mocks.authorize).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
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
    const walletA = { ...created, id: 'wallet-A', walletAddress: addressA, openfortAccountId: 'account-A', agentWalletAddress: addressB, agentKeyHash: '0x' + '1'.repeat(64), chainAuthorizations: [] };
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
    expect(mocks.authorize).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ embeddedWalletAddress: addressA, embeddedOpenfortAccountId: 'account-A' }));
    expect(mocks.setActive).toHaveBeenCalledWith(expect.objectContaining({ address: addressA }));
  });

  it('rejects a live provider on B even when the SDK hook reports A active', async () => {
    const walletA = { ...created, id: 'wallet-A', walletAddress: addressA, openfortAccountId: 'account-A', agentWalletAddress: addressB, agentKeyHash: '0x' + '1'.repeat(64), chainAuthorizations: [] };
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

});
