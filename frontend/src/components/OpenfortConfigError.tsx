import { AlertCircle } from 'lucide-react';

type OpenfortConfigErrorProps = {
  missingVars: string[];
};

export function OpenfortConfigError({ missingVars }: OpenfortConfigErrorProps) {
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
            <p className="text-xs text-red-700">
              See <span className="font-mono">frontend/.env.example</span> for the expected variable names.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
