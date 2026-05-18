import { AlertCircle } from 'lucide-react';
import { CopyButton } from './CopyButton';

type OpenfortConfigErrorProps = {
  missingVars: string[];
};

export function OpenfortConfigError({ missingVars }: OpenfortConfigErrorProps) {
  const envTemplate = missingVars.map((name) => `${name}=`).join('\n');

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-bg p-6 text-brand-text">
      <div className="max-w-lg rounded-2xl border border-red-200 bg-red-50 p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-500" />
          <div className="space-y-3">
            <div>
              <h1 className="text-base font-semibold text-red-900">Openfort is not configured</h1>
              <p className="mt-1 text-sm text-red-700">
                Add the missing frontend environment variables and restart the Vite dev server or deployment.
              </p>
            </div>
            <ul className="space-y-1 rounded-lg bg-white/70 p-3 font-mono text-xs text-red-800">
              {missingVars.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
            <div className="rounded-lg border border-red-200 bg-white/70 p-3 text-xs text-red-800">
              <p className="font-semibold text-red-900">Local setup</p>
              <ol className="mt-2 list-decimal space-y-1 pl-4">
                <li>
                  Copy <span className="font-mono">frontend/.env.example</span> to{' '}
                  <span className="font-mono">frontend/.env</span>.
                </li>
                <li>Fill the missing Openfort values below from the Openfort dashboard.</li>
                <li>Restart the Vite dev server so the new VITE_* values are loaded.</li>
              </ol>
            </div>
            <div className="rounded-lg border border-red-200 bg-white/80 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-[11px] font-bold uppercase tracking-widest text-red-700">
                  Copy .env entries
                </span>
                <CopyButton
                  text={envTemplate}
                  className="shrink-0 border-red-200 text-red-700 hover:bg-red-50"
                />
              </div>
              <pre className="overflow-x-auto rounded-md bg-red-950 p-3 font-mono text-xs text-red-50">
                <code>{envTemplate}</code>
              </pre>
            </div>
            <p className="text-xs text-red-700">
              Paste these into <span className="font-mono">frontend/.env</span>, fill the Openfort values from your
              dashboard, then restart Vite or redeploy. See{' '}
              <span className="font-mono">frontend/.env.example</span> for the full local template.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
