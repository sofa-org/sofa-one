import { useState } from 'react';
import { Copy, Check, X } from 'lucide-react';

interface CopyButtonProps {
  text: string;
  className?: string;
}

type CopyState = 'idle' | 'copied' | 'error';

export function CopyButton({ text, className }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>('idle');

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('error');
    } finally {
      setTimeout(() => setState('idle'), 2000);
    }
  }

  const styleMap: Record<CopyState, string> = {
    idle: 'border-brand-border text-brand-muted hover:bg-brand-bg hover:text-brand-text',
    copied: 'border-green-300 bg-green-50 text-green-600',
    error: 'border-red-300 bg-red-50 text-red-600',
  };

  const labelMap: Record<CopyState, string> = {
    idle: 'Copy to clipboard',
    copied: 'Copied',
    error: 'Copy failed',
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex items-center justify-center rounded-full border p-1.5 transition-colors ${styleMap[state]} ${className ?? ''}`}
      aria-label={labelMap[state]}
    >
      {state === 'copied' && <Check className="h-3.5 w-3.5" />}
      {state === 'error' && <X className="h-3.5 w-3.5" />}
      {state === 'idle' && <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
