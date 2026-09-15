import { render, screen } from '@testing-library/react';
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
});
