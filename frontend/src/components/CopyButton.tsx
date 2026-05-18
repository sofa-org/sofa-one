import { useEffect, useRef, useState } from 'react';
import { Copy, Check, X } from 'lucide-react';

interface CopyButtonProps {
  text: string;
  className?: string;
}

type CopyState = 'idle' | 'copied' | 'error';

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to the legacy selection API below. Some browsers expose
      // navigator.clipboard but reject it outside secure contexts or if the
      // permission prompt fails.
    }
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  textArea.style.top = '0';
  document.body.appendChild(textArea);
  textArea.select();
  textArea.setSelectionRange(0, textArea.value.length);

  try {
    if (!document.execCommand('copy')) {
      throw new Error('Copy command was rejected.');
    }
  } finally {
    textArea.remove();
  }
}

export function CopyButton({ text, className }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>('idle');
  const resetTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current !== null) {
        window.clearTimeout(resetTimeoutRef.current);
      }
    };
  }, []);

  async function handleCopy() {
    if (resetTimeoutRef.current !== null) {
      window.clearTimeout(resetTimeoutRef.current);
    }

    try {
      await copyTextToClipboard(text);
      setState('copied');
    } catch {
      setState('error');
    } finally {
      resetTimeoutRef.current = window.setTimeout(() => setState('idle'), 2000);
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
      title={labelMap[state]}
    >
      {state === 'copied' && <Check className="h-3.5 w-3.5" />}
      {state === 'error' && <X className="h-3.5 w-3.5" />}
      {state === 'idle' && <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
