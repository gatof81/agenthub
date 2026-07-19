/**
 * Copy-to-clipboard button with a brief "Copied" confirmation. Shared by the
 * fenced-code blocks (Markdown) and whole-message copy (Thread) so the affordance
 * behaves identically everywhere.
 */

import { useState } from 'react';

export function CopyButton({
  text,
  className,
  label = 'Copy',
  ariaLabel,
}: {
  text: string;
  className?: string;
  label?: string;
  ariaLabel?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      aria-label={ariaLabel ?? label}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}
