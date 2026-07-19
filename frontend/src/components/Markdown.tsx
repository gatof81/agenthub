/**
 * Assistant responses render as Markdown (11 §10, §11): Claude's output is
 * Markdown, so headings, lists, tables, and code get real formatting instead of
 * one flat monospace block. GFM via remark-gfm (tables, task lists,
 * strikethrough, autolinks); fenced code is syntax-highlighted via
 * rehype-highlight (11 §11). react-markdown does NOT render raw HTML, so model
 * output cannot inject markup — no sanitizer needed (SEC hygiene: untrusted
 * content in, safe DOM out). User messages stay plain text; they are typed,
 * not Markdown.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Components } from 'react-markdown';
import { CopyButton } from './CopyButton.js';

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

/** The fenced language of the `<code>` react-markdown hands to `<pre>`, if any
 * (`language-ts` → `ts`). Drives the small language label on a code block. */
export function codeLanguage(node: React.ReactNode): string | null {
  const el = Array.isArray(node) ? node[0] : node;
  if (typeof el === 'object' && el !== null && 'props' in el) {
    const className = (el as { props: { className?: string } }).props.className ?? '';
    const match = /language-([\w-]+)/.exec(className);
    return match?.[1] ?? null;
  }
  return null;
}

const COMPONENTS: Components = {
  // Links leave the app — new tab, and never hand the opener to the target.
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  // Fenced code blocks get a language label + copy affordance; react-markdown
  // routes block code through `pre` (inline code stays a bare `code`).
  pre: ({ children }) => (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{codeLanguage(children) ?? 'code'}</span>
        <CopyButton text={nodeToText(children)} className="code-copy" ariaLabel="Copy code" />
      </div>
      <pre>{children}</pre>
    </div>
  ),
};

export function Markdown({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Highlight only fences with an explicit, recognized language.
        // `ignoreMissing` renders an unknown language as plain text instead of
        // throwing; an untagged fence stays plain too (no auto-detect) — matches
        // the 11 §11 contract.
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
        components={COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
