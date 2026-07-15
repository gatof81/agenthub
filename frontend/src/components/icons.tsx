/**
 * Inline SVG icons (crisp, theme-aware via currentColor). Kept tiny and
 * local — no icon-library dependency (R-10). Distinct silhouettes matter:
 * the back affordance is an arrow, archive is a box (owner UX feedback —
 * a backspace glyph read as another back arrow).
 */

interface IconProps {
  size?: number;
}

export function BackIcon({ size = 18 }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M15 5l-7 7 7 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ArchiveIcon({ size = 16 }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="4" width="18" height="4" rx="1" stroke="currentColor" strokeWidth="2" />
      <path
        d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M10 12h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
