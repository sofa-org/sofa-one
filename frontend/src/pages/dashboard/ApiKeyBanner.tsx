import { X } from 'lucide-react';
import { CopyButton } from '@/components/CopyButton';

interface ApiKeyBannerProps {
  apiKeyDisplay: string;
  onDismiss: () => void;
}

export function ApiKeyBanner({ apiKeyDisplay, onDismiss }: ApiKeyBannerProps) {
  return (
    <div className="relative rounded-2xl border border-amber-200 bg-amber-50 p-5 pr-14 shadow-sm">
      <button
        type="button"
        onClick={onDismiss}
        className="absolute right-4 top-4 inline-flex items-center justify-center rounded-full border border-amber-300 p-1 text-amber-600 transition-colors hover:bg-amber-100"
        aria-label="Dismiss new API key notice"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <p className="mb-2 text-sm font-medium text-amber-800">
        API key for backend requests (save it — shown only once):
      </p>
      <p className="mb-3 text-xs text-amber-700">
        Use this as the <code>X-API-Key</code> header from your server. This notice auto-hides in 2 minutes.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 break-all rounded-lg bg-amber-100 px-4 py-3 font-mono text-sm text-amber-900 ring-1 ring-amber-200/50">
          {apiKeyDisplay}
        </code>
        <CopyButton text={apiKeyDisplay} className="shrink-0 border-amber-300 text-amber-600 hover:bg-amber-100" />
      </div>
    </div>
  );
}
