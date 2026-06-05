import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  KeyRound,
  Loader2,
  Smartphone,
} from 'lucide-react';
import { useUser } from '@openfort/react';
import { CopyButton } from '@/components/CopyButton';
import {
  enableTotpAuth,
  getApiErrorMessage,
  getMfaStatusAuth,
  setupTotpAuth,
  verifyTotpAuth,
  type MfaStatusResponse,
  type TotpSetupResponse,
} from '@/lib/api';
import {
  getDashboardStepUpToken,
  storeDashboardStepUpProof,
} from '@/pages/dashboard/step-up-session';

type GateStage = 'checking' | 'setup' | 'verify' | 'recovery' | 'ready' | 'error';

function normalizeMfaCode(value: string) {
  return value.trim().toUpperCase();
}

function isSixDigitCode(value: string) {
  return /^\d{6}$/.test(value);
}

function splitRecoveryCodes(codes: string[]) {
  return codes.map((code) => code.trim()).filter(Boolean);
}

export default function DashboardStepUpGate({ children }: { children: React.ReactNode }) {
  const { getAccessToken, isAuthenticated, isLoading: authLoading } = useUser();
  const codeInputRef = useRef<HTMLInputElement>(null);
  const continueButtonRef = useRef<HTMLButtonElement>(null);

  const [stage, setStage] = useState<GateStage>('checking');
  const [mfaStatus, setMfaStatus] = useState<MfaStatusResponse | null>(null);
  const [setupData, setSetupData] = useState<TotpSetupResponse | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [statusError, setStatusError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [proofReady, setProofReady] = useState(false);

  const getToken = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      throw new Error('Openfort session is not ready. Refresh and sign in again.');
    }
    return token;
  }, [getAccessToken]);

  const bootstrap = useCallback(async () => {
    if (authLoading || !isAuthenticated) return;

    setIsBootstrapping(true);
    setStatusError(null);
    setFormError(null);
    setProofReady(false);
    setRecoveryCodes([]);
    setSetupData(null);

    try {
      const status = await getMfaStatusAuth(getToken);
      setMfaStatus(status);

      if (status.enabled) {
        setStage('verify');
        setSetupData(null);
      } else {
        const setup = await setupTotpAuth(getToken);
        setSetupData(setup);
        setRecoveryCodes([]);
        setProofReady(false);
        setStage('setup');
      }
    } catch (err: unknown) {
      setStage('error');
      setStatusError(getApiErrorMessage(err));
    } finally {
      setIsBootstrapping(false);
    }
  }, [authLoading, getToken, isAuthenticated]);

  useEffect(() => {
    if (getDashboardStepUpToken()) {
      setStage('ready');
      return;
    }

    if (authLoading) return;
    void bootstrap();
  }, [authLoading, bootstrap]);

  useEffect(() => {
    if (stage === 'setup' || stage === 'verify' || (stage === 'recovery' && !proofReady)) {
      codeInputRef.current?.focus();
    }
  }, [proofReady, setupData?.otpauthUrl, stage]);

  useEffect(() => {
    if (stage !== 'recovery' || !proofReady) return;
    continueButtonRef.current?.focus();
  }, [proofReady, stage]);

  const title = useMemo(() => {
    switch (stage) {
      case 'setup':
        return 'Set up authenticator-based MFA';
      case 'verify':
        return 'Verify your authenticator code';
      case 'recovery':
        return proofReady ? 'Recovery codes saved' : 'Finish verification';
      case 'error':
        return 'MFA unavailable right now';
      default:
        return 'Secure your dashboard';
    }
  }, [proofReady, stage]);

  const description = useMemo(() => {
    switch (stage) {
      case 'setup':
        return 'Scan the setup link with Google Authenticator, Authy, or another TOTP app, then enter the 6-digit code it shows.';
      case 'verify':
        return `MFA is already enabled. Enter a 6-digit authenticator code or a recovery code to continue.${
          mfaStatus ? ` ${mfaStatus.recoveryCodesRemaining} recovery code${mfaStatus.recoveryCodesRemaining === 1 ? '' : 's'} remain.` : ''
        }`;
      case 'recovery':
        return proofReady
          ? 'Save these recovery codes somewhere safe. You will only see them once.'
          : 'We enabled MFA, but still need one valid code before the dashboard can open.';
      case 'error':
        return 'We could not load your MFA status. Try again to continue.';
      default:
        return 'We are checking your dashboard MFA status.';
    }
  }, [mfaStatus, proofReady, stage]);

  const canContinue = stage === 'recovery' && proofReady;
  const showVerificationForm = stage === 'setup' || stage === 'verify' || (stage === 'recovery' && !proofReady);
  const isSetupStage = stage === 'setup';

  async function verifyCodeForAccess(codeValue: string) {
    const verification = await verifyTotpAuth(getToken, codeValue);
    storeDashboardStepUpProof(verification);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (isSubmitting) return;

    const nextCode = normalizeMfaCode(code);
    if (!nextCode) {
      setFormError('Enter a verification code before continuing.');
      return;
    }

    if (isSetupStage && !isSixDigitCode(nextCode)) {
      setFormError('Enter the 6-digit code from your authenticator app.');
      return;
    }

    setIsSubmitting(true);
    setFormError(null);

    try {
      if (isSetupStage) {
        const enabled = await enableTotpAuth(getToken, nextCode);
        const codes = splitRecoveryCodes(enabled.recoveryCodes);
        setRecoveryCodes(codes);
        setStage('recovery');

        try {
          await verifyCodeForAccess(nextCode);
          setProofReady(true);
        } catch (verifyErr: unknown) {
          setProofReady(false);
          setFormError(getApiErrorMessage(verifyErr));
        }
      } else {
        await verifyCodeForAccess(nextCode);
        setStage('ready');
      }

      setCode('');
    } catch (err: unknown) {
      setFormError(getApiErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (stage === 'ready') {
    return <>{children}</>;
  }

  const loading = isBootstrapping || isSubmitting;
  const stageIcon =
    stage === 'error' ? (
      <AlertCircle className="h-6 w-6" />
    ) : loading ? (
      <Loader2 className="h-6 w-6 animate-spin" />
    ) : stage === 'setup' ? (
      <Smartphone className="h-6 w-6" />
    ) : stage === 'recovery' && proofReady ? (
      <CheckCircle2 className="h-6 w-6" />
    ) : (
      <KeyRound className="h-6 w-6" />
    );

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-brand-bg px-6 py-10 text-brand-text">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(194,139,82,0.14),_transparent_40%),radial-gradient(circle_at_bottom_right,_rgba(51,41,36,0.08),_transparent_28%)]" />
      <div className="relative w-full max-w-2xl rounded-[2rem] border border-brand-border/80 bg-white/95 p-8 shadow-[0_32px_100px_-40px_rgba(51,41,36,0.45)] ring-1 ring-black/5 backdrop-blur-sm sm:p-10">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-accent/10 text-brand-accent">
          {stageIcon}
        </div>

        <div className="mt-6 text-center">
          <p className="text-xs font-bold uppercase tracking-[0.24em] text-brand-muted">
            Multi-factor authentication
          </p>
          <h1 className="mt-2 font-serif text-3xl font-bold text-brand-text">{title}</h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-brand-muted">{description}</p>
        </div>

        {statusError && stage === 'error' && (
          <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {statusError}
          </div>
        )}

        {setupData && stage === 'setup' && (
          <div className="mt-8 grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-brand-border bg-brand-bg/50 p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-brand-muted">
                    Authenticator link
                  </p>
                  <a
                    href={setupData.otpauthUrl}
                    className="mt-2 block break-all rounded-xl border border-brand-border bg-white px-3 py-3 font-mono text-xs leading-5 text-brand-text transition-colors hover:border-brand-accent hover:text-brand-accent"
                  >
                    {setupData.otpauthUrl}
                  </a>
                </div>
                <CopyButton text={setupData.otpauthUrl} />
              </div>
              <p className="mt-3 text-xs leading-5 text-brand-muted">
                Open the link on a trusted device or paste the secret manually if your authenticator app asks for it.
              </p>
            </div>

            <div className="rounded-2xl border border-brand-border bg-brand-bg/50 p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-brand-muted">
                    Manual secret
                  </p>
                  <p className="mt-2 break-all rounded-xl border border-brand-border bg-white px-3 py-3 font-mono text-sm tracking-[0.18em] text-brand-text">
                    {setupData.secret}
                  </p>
                </div>
                <CopyButton text={setupData.secret} />
              </div>
              <p className="mt-3 text-xs leading-5 text-brand-muted">
                Keep this secret private. It can be used to generate codes for your account.
              </p>
            </div>
          </div>
        )}

        {stage === 'recovery' && recoveryCodes.length > 0 && (
          <div className="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-950">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-amber-700">
                  Recovery codes
                </p>
                <p className="mt-2 text-sm leading-6 text-amber-900">
                  Save these now. They are shown once and can be used if you lose access to your authenticator app.
                </p>
              </div>
              <CopyButton text={recoveryCodes.join('\n')} className="border-amber-300 text-amber-700 hover:bg-white" />
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {recoveryCodes.map((recoveryCode) => (
                <div
                  key={recoveryCode}
                  className="rounded-xl border border-amber-200 bg-white px-3 py-2 font-mono text-sm tracking-[0.18em] text-amber-950"
                >
                  {recoveryCode}
                </div>
              ))}
            </div>
          </div>
        )}

        {showVerificationForm && (
          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
            <div>
              <label className="mb-1 block text-[11px] font-bold uppercase tracking-[0.24em] text-brand-muted">
                {isSetupStage ? '6-digit authenticator code' : 'Authenticator or recovery code'}
              </label>
              <input
                ref={codeInputRef}
                type="text"
                value={code}
                onChange={(event) => setCode(normalizeMfaCode(event.target.value))}
                inputMode={isSetupStage ? 'numeric' : 'text'}
                autoComplete="one-time-code"
                placeholder={isSetupStage ? '123456' : 'Enter your code'}
                className="w-full rounded-2xl border border-brand-border bg-brand-bg/50 px-4 py-3 text-sm text-brand-text outline-none transition focus:border-brand-accent focus:bg-white focus:ring-2 focus:ring-brand-accent/15"
              />
            </div>

            {formError && (
              <div className="flex gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting || !code.trim()}
              className="inline-flex w-full items-center justify-center rounded-full bg-brand-text px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-text/10 transition-all hover:-translate-y-0.5 hover:bg-brand-text/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting
                ? 'Working…'
                : stage === 'setup'
                  ? 'Enable MFA'
                  : stage === 'recovery'
                    ? 'Verify and finish'
                    : 'Verify and continue'}
            </button>
          </form>
        )}

        {canContinue && (
          <div className="mt-8 rounded-2xl border border-green-200 bg-green-50 p-5 text-green-900">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">MFA is ready.</p>
                <p className="mt-1 text-sm leading-6 text-green-800">
                  Your proof is stored for this session. Keep your recovery codes in a safe place, then continue to the dashboard.
                </p>
              </div>
            </div>

            <button
              ref={continueButtonRef}
              type="button"
              onClick={() => setStage('ready')}
              className="mt-4 inline-flex w-full items-center justify-center rounded-full bg-green-700 px-5 py-3 text-sm font-semibold text-white shadow-lg transition-all hover:-translate-y-0.5 hover:bg-green-800"
            >
              Continue to dashboard
            </button>
          </div>
        )}

        {stage === 'error' && (
          <button
            type="button"
            onClick={() => void bootstrap()}
            className="mt-6 inline-flex w-full items-center justify-center rounded-full border border-brand-border px-5 py-3 text-sm font-semibold text-brand-text transition-colors hover:border-brand-accent hover:text-brand-accent"
          >
            Retry loading MFA status
          </button>
        )}
      </div>
    </div>
  );
}
