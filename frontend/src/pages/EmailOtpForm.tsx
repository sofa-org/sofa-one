import { useState } from 'react';
import { useEmailOtpAuth } from '@openfort/react';
import { useNavigate } from 'react-router-dom';

export default function EmailOtpForm({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const navigate = useNavigate();
  const { requestEmailOtp, signInEmailOtp, isRequesting, isLoading } = useEmailOtpAuth();
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRequestOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const result = await requestEmailOtp({ email });
    if (result.error) {
      setError(result.error.message ?? 'Could not send OTP.');
      return;
    }
    setSent(true);
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const result = await signInEmailOtp({ email, otp });
    if (result.error || !result.user) {
      setError(result.error?.message ?? 'Invalid OTP.');
      return;
    }
    navigate('/dashboard', { replace: true });
  }

  return (
    <div className="w-full rounded-2xl border border-brand-border bg-white p-8 shadow-2xl shadow-[#E8E2D9]/40">
      <h1 className="font-serif text-2xl font-semibold text-brand-text">
        {mode === 'sign-in' ? 'Sign in' : 'Create account'}
      </h1>
      <p className="mt-2 text-sm text-brand-muted">
        Use Openfort email OTP to access your embedded wallet.
      </p>

      <form onSubmit={sent ? handleVerifyOtp : handleRequestOtp} className="mt-6 space-y-4">
        <div>
          <label className="mb-1 block text-[11px] font-bold uppercase tracking-widest text-brand-muted">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={sent}
            required
            className="w-full rounded-lg border border-brand-border bg-brand-bg/50 px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent disabled:opacity-60"
          />
        </div>

        {sent && (
          <div>
            <label className="mb-1 block text-[11px] font-bold uppercase tracking-widest text-brand-muted">One-time code</label>
            <input
              type="text"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              required
              inputMode="numeric"
              className="w-full rounded-lg border border-brand-border bg-brand-bg/50 px-4 py-2.5 text-sm text-brand-text focus:border-brand-accent focus:outline-none focus:ring-1 focus:ring-brand-accent"
            />
          </div>
        )}

        {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button
          type="submit"
          disabled={isRequesting || isLoading || !email.trim() || (sent && !otp.trim())}
          className="w-full rounded-full bg-brand-text px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition-all hover:bg-brand-text/90 disabled:opacity-50"
        >
          {sent ? (isLoading ? 'Verifying…' : 'Verify code') : isRequesting ? 'Sending…' : 'Send OTP'}
        </button>
      </form>

      <button
        type="button"
        onClick={() => {
          setSent(false);
          setOtp('');
          setError(null);
        }}
        className="mt-4 text-xs font-medium text-brand-accent hover:text-brand-accent/80"
      >
        Use a different email
      </button>
    </div>
  );
}
