import { describe, expect, it } from 'vitest';
import { deriveConversationTitle } from '../src/domain/projections.js';

describe('deriveConversationTitle (auto-title from the first message)', () => {
  it('returns a short message verbatim', () => {
    expect(deriveConversationTitle('Fix the login bug')).toBe('Fix the login bug');
  });

  it('collapses runs of whitespace and newlines to single spaces', () => {
    expect(deriveConversationTitle('  hello\n\n  there   world ')).toBe('hello there world');
  });

  it('returns an empty string for whitespace-only content, so the caller keeps the default', () => {
    expect(deriveConversationTitle('   \n\t ')).toBe('');
  });

  it('truncates long content on a word boundary with an ellipsis', () => {
    const title = deriveConversationTitle(
      'Refactor the billing module and add tests for the edge cases',
    );
    expect(title).toBe('Refactor the billing module and add tests for…');
    expect(title.length).toBeLessThanOrEqual(49); // 48 chars + the ellipsis
  });

  it('hard-cuts a single very long word with no early space', () => {
    expect(deriveConversationTitle('x'.repeat(100))).toBe(`${'x'.repeat(48)}…`);
  });
});
