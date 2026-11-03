import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { WithdrawForm } from './WithdrawForm';
import type { WithdrawFormProps } from './WithdrawForm';

function renderForm(over: Partial<WithdrawFormProps> = {}) {
  const props: WithdrawFormProps = {
    to: '',
    amount: '',
    token: 'USDC',
    selectedChainId: 84532,
    withdrawalReady: true,
    withdrawalIntent: null,
    recoveryStorageError: null,
    onAuthorizeChain: vi.fn(),
    onResumeWithdrawal: vi.fn(),
    withdrawLoading: false,
    withdrawResult: null,
    withdrawError: null,
    withdrawalAllowlist: null,
    withdrawalAllowlistLoading: false,
    withdrawalAllowlistError: null,
    newWithdrawalAddress: '',
    newWithdrawalAddressLabel: '',
    withdrawalAddressLoadingId: null,
    withdrawExplorerUrl: null,
    nativeCurrencySymbol: 'ETH',
    setTo: vi.fn(),
    setAmount: vi.fn(),
    setToken: vi.fn(),
    setSelectedChainId: vi.fn(),
    setNewWithdrawalAddress: vi.fn(),
    setNewWithdrawalAddressLabel: vi.fn(),
    onSubmit: vi.fn(),
    onAddWithdrawalAddress: vi.fn(),
    onRemoveWithdrawalAddress: vi.fn(),
    onReset: vi.fn(),
    ...over,
  };

  return render(
    <MemoryRouter>
      <WithdrawForm {...props} />
    </MemoryRouter>,
  );
}

describe('WithdrawForm — billing outbound blocked', () => {
  it('shows settle-invoice guidance and a Billing CTA when billingBlocked is set', () => {
    renderForm({
      withdrawError: {
        message:
          'Withdrawals are blocked until you settle your unpaid invoice. Open Billing to pay the finalized invoice, then try again.',
        billingBlocked: true,
      },
    });

    expect(
      screen.getByText(/Withdrawals are blocked until you settle your unpaid invoice/),
    ).toBeInTheDocument();

    const cta = screen.getByRole('link', { name: /Go to Billing/i });
    expect(cta).toHaveAttribute('href', '/dashboard/billing');
  });

  it('keeps generic withdraw errors without a Billing CTA', () => {
    renderForm({
      withdrawError: {
        message: 'Network request failed',
      },
    });

    expect(screen.getByText('Network request failed')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Go to Billing/i })).not.toBeInTheDocument();
  });

  it('blocks a chain without current authorization and offers renewal without hiding the allowlist', () => {
    const authorize = vi.fn();
    renderForm({ withdrawalReady: false, onAuthorizeChain: authorize });
    expect(screen.getByRole('button', { name: 'Send Withdrawal' })).toBeDisabled();
    expect(screen.getByText('Withdrawal address allowlist')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Authorize / renew this chain' }));
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it('locks new intent inputs and exposes only resume while the previous outcome is unknown', () => {
    const resume = vi.fn();
    renderForm({
      onResumeWithdrawal: resume,
      withdrawalIntent: {
        userId: 'user-1', walletId: 'wallet-1', walletAddress: `0x${'1'.repeat(40)}`,
        chainId: 84532, to: `0x${'2'.repeat(40)}`, token: 'USDC', amount: '1000000',
        displayAmount: '1', idempotencyKey: 'stable-intent', status: 'unknown',
      },
    });
    expect(screen.getByText(/Withdrawal outcome is not confirmed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send Withdrawal' })).toBeDisabled();
    expect(screen.getByPlaceholderText('0x...')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Withdraw another' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume withdrawal' }));
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
