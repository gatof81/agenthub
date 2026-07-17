/**
 * Assistant responses render as Markdown (11 §10): Claude's output is Markdown,
 * so headings, lists, tables, and code get real formatting instead of one flat
 * monospace block. GFM via remark-gfm (tables, task lists, strikethrough,
 * autolinks). react-markdown does NOT render raw HTML, so model output cannot
 * inject markup — no sanitizer needed (SEC hygiene: untrusted content in, safe
 * DOM out). User messages stay plain text; they are typed, not Markdown.
 */

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

/** Flatten a React subtree to its text — the code a copy button should copy. */
export function nodeToText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join('');
  if (typeof node === 'object' && node !== null && 'props' in node) {
    return nodeToText((node as { props: { children?: React.ReactNode } }).props.children);
  }
  return '';
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="code-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

const COMPONENTS: Components = {
  // Links leave the app — new tab, and never hand the opener to the target.
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // Fenced code blocks get a copy affordance; react-markdown routes block code
  // through `pre` (inline code stays a bare `code`, styled via CSS).
  pre: ({ children }) => (
    <div className="code-block">
      <CopyButton text={nodeToText(children)} />
      <pre>{children}</pre>
    </div>
  ),
};

export function Markdown({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
