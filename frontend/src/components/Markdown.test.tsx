import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, nodeToText } from './Markdown.js';

const html = (md: string): string => renderToStaticMarkup(createElement(Markdown, null, md));

describe('nodeToText (copy-button source extraction)', () => {
  it('returns a plain string as-is', () => {
    expect(nodeToText('npm ci')).toBe('npm ci');
  });

  it('joins arrays of nodes', () => {
    expect(nodeToText(['a', 'b', 'c'])).toBe('abc');
  });

  it('walks into element children (the <code> react-markdown passes to <pre>)', () => {
    const code = createElement('code', { className: 'language-ts' }, 'const x = 1;');
    expect(nodeToText(code)).toBe('const x = 1;');
  });

  it('flattens nested elements and numbers', () => {
    const tree = createElement('code', null, ['line1\n', createElement('span', null, 'line2'), 2]);
    expect(nodeToText(tree)).toBe('line1\nline22');
  });

  it('ignores null/undefined/boolean nodes', () => {
    expect(nodeToText(null)).toBe('');
    expect(nodeToText(undefined)).toBe('');
    expect(nodeToText(true)).toBe('');
  });
});

describe('Markdown rendering', () => {
  it('renders headings, lists, and emphasis', () => {
    const out = html('## Title\n\n- **bold** item\n- second');
    expect(out).toContain('<h2>Title</h2>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<li>');
  });

  it('wraps fenced code in a code-block with a copy button', () => {
    const out = html('```ts\nconst x = 1;\n```');
    expect(out).toContain('class="code-block"');
    expect(out).toContain('class="code-copy"');
    expect(out).toContain('const x = 1;');
    expect(out).toContain('<pre>');
  });

  it('opens links in a new tab without handing over the opener', () => {
    const out = html('[docs](https://example.com)');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('renders GFM tables (remark-gfm)', () => {
    const out = html('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(out).toContain('<table>');
    expect(out).toContain('<td>1</td>');
  });

  it('does not render raw HTML in model output (no injection)', () => {
    const out = html('hello <script>alert(1)</script> world');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });
});
