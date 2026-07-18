/**
 * Adjustable conversation text size (11 §11): the reader picks how big the
 * messages/responses render. A CSS length applied to `--chat-font`; the
 * Markdown typography is em-relative, so everything scales proportionally.
 */

export type TextSize = 'sm' | 'md' | 'lg';

/** `sm` is the historical default (14px); `md`/`lg` are the "bigger" steps. */
export const TEXT_SIZES: Record<TextSize, string> = {
  sm: '14px',
  md: '16px',
  lg: '18px',
};

const ORDER: TextSize[] = ['sm', 'md', 'lg'];
const STORAGE_KEY = 'agenthub.textSize';

export function loadTextSize(): TextSize {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'sm' || stored === 'md' || stored === 'lg' ? stored : 'sm';
}

export function saveTextSize(size: TextSize): void {
  localStorage.setItem(STORAGE_KEY, size);
}

/** Cycle sm → md → lg → sm (the "Aa" button steps through this). */
export function nextTextSize(size: TextSize): TextSize {
  return ORDER[(ORDER.indexOf(size) + 1) % ORDER.length]!;
}
