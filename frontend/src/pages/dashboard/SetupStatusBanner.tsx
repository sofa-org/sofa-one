import { Link } from 'react-router-dom';
import { CheckCircle2, ArrowRight } from 'lucide-react';
import { getChainDisplayName, formatAgentStatus } from './wallet-helpers';

interface SetupStep {
  number: number;
  title: string;
  description: string;
  state: string;
}

interface SetupStatusBannerProps {
  setupStatus: { title: string; tone: string; description: string };
  setupStatusClasses: string;
  setupSteps: SetupStep[];
  hasRegisteredAuthorization: boolean;
  agentChainId: number;
  selectedAuthorizationStatus: string | null;
}

export function SetupStatusBanner({
  setupStatus,
  setupStatusClasses,
  setupSteps,
  hasRegisteredAuthorization,
  agentChainId,
  selectedAuthorizationStatus,
}: SetupStatusBannerProps) {
  return (
    <div className={`rounded-2xl border p-5 shadow-sm ${setupStatusClasses}`}>
      <div className="space-y-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="font-serif text-xl font-bold text-brand-text">{setupStatus.title}</h2>
            <p className="mt-1 text-sm">{setupStatus.description}</p>
            <p className="mt-2 text-xs font-medium opacity-80">
              Selected network: {getChainDisplayName(agentChainId)} · Status:{' '}
              {formatAgentStatus(selectedAuthorizationStatus)}
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
                      <p className="text-sm font-semibold text-brand-text">
                        Step {step.number}: {step.title}
                      </p>
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
  );
}
