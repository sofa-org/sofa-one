import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface CopyButtonProps {
  text: string;
  className?: string;
}

export function CopyButton({ text, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable; silently ignore
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex items-center justify-center rounded-full border p-1.5 transition-colors ${
        copied
          ? 'border-green-300 bg-green-50 text-green-600'
          : 'border-brand-border text-brand-muted hover:bg-brand-bg hover:text-brand-text'
      } ${className ?? ''}`}
      aria-label={copied ? 'Copied' : 'Copy to clipboard'}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
