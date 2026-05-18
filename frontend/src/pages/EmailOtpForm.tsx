import { useState } from 'react';
import { useEmailOtpAuth } from '@openfort/react';
import { useNavigate } from 'react-router-dom';

function getAuthErrorMessage(err: unknown, fallback: string) {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export default function EmailOtpForm() {
  const navigate = useNavigate();
  const { requestEmailOtp, signInEmailOtp, isRequesting, isLoading } = useEmailOtpAuth();
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestOtpForEmail() {
    const normalizedEmail = email.trim();

    setError(null);
    setEmail(normalizedEmail);

    if (!normalizedEmail) {
      setError('Enter your email address to receive a one-time code.');
      return;
    }

    try {
      const result = await requestEmailOtp({ email: normalizedEmail });
      if (result.error) {
        setError(result.error.message ?? 'Could not send OTP.');
        return;
      }

      setSent(true);
      setOtp('');
    } catch (err: unknown) {
      setError(getAuthErrorMessage(err, 'Could not send OTP. Check your connection and try again.'));
    }
  }

  async function handleRequestOtp(e: React.FormEvent) {
    e.preventDefault();
    await requestOtpForEmail();
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    const normalizedEmail = email.trim();
    const normalizedOtp = otp.trim();

    setError(null);

    if (!normalizedEmail || !normalizedOtp) {
      setError('Enter the email and one-time code before continuing.');
      return;
    }

    try {
      const result = await signInEmailOtp({ email: normalizedEmail, otp: normalizedOtp });
      if (result.error || !result.user) {
        setError(result.error?.message ?? 'Invalid OTP.');
        return;
      }
      navigate('/dashboard', { replace: true });
    } catch (err: unknown) {
      setError(getAuthErrorMessage(err, 'Could not verify OTP. Check your connection and try again.'));
    }
  }

  return (
    <div className="w-full rounded-2xl border border-brand-border bg-white p-8 shadow-2xl shadow-[#E8E2D9]/40">
      <h1 className="font-serif text-2xl font-semibold text-brand-text">
        Sign in or create account
      </h1>
      <p className="mt-2 text-sm text-brand-muted">
        Use Openfort email OTP to access your EOA.
      </p>
      {sent && (
        <p className="mt-4 rounded-lg border border-brand-border bg-brand-bg/60 px-3 py-2 text-xs text-brand-muted">
          We sent a one-time code to <span className="font-medium text-brand-text">{email}</span>. Check your inbox and
          spam folder.
        </p>
      )}

      <form onSubmit={sent ? handleVerifyOtp : handleRequestOtp} className="mt-6 space-y-4">
        <div>
          <label className="mb-1 block text-[11px] font-bold uppercase tracking-widest text-brand-muted">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={sent}
            required
            autoComplete="email"
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
              autoComplete="one-time-code"
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

      {sent && (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-medium">
          <button
            type="button"
            onClick={requestOtpForEmail}
            disabled={isRequesting || isLoading}
            className="text-brand-accent hover:text-brand-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRequesting ? 'Resending…' : 'Resend code'}
          </button>
          <button
            type="button"
            onClick={() => {
              setSent(false);
              setOtp('');
              setError(null);
            }}
            className="text-brand-muted hover:text-brand-text"
          >
            Use a different email
          </button>
        </div>
      )}
    </div>
  );
}
