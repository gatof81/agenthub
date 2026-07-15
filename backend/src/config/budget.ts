/**
 * Budget estimator (B3-06, ADR-003, R-06). A hard pre-spend budget is
 * unenforceable at this layer — the CLI reports authoritative cost only in
 * the terminal result event. So the runner keeps a *lagging estimate* from
 * streamed per-message token usage; if the estimate crosses the run's
 * `budgetUsd` cap, the run is cancelled and marked `budget_exceeded`.
 *
 * Prices are USD per 1M tokens, configurable via env (`BUDGET_USD_PER_MTOK_*`)
 * because model pricing moves. The default is deliberately conservative
 * (a slight over-estimate trips the cap early — safer for a runaway guard
 * than a late trip). Cache-read tokens are billed at a fraction of input.
 */

export interface TokenPrices {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

// conservative defaults (order-of-magnitude for a mid-tier model, 2026);
// overridable per deployment — the point is a runaway cap, not billing.
export const DEFAULT_TOKEN_PRICES: TokenPrices = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
};

export function resolveTokenPrices(env: Record<string, string | undefined>): TokenPrices {
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return {
    inputPerMTok: num('BUDGET_USD_PER_MTOK_INPUT', DEFAULT_TOKEN_PRICES.inputPerMTok),
    outputPerMTok: num('BUDGET_USD_PER_MTOK_OUTPUT', DEFAULT_TOKEN_PRICES.outputPerMTok),
    cacheReadPerMTok: num('BUDGET_USD_PER_MTOK_CACHE_READ', DEFAULT_TOKEN_PRICES.cacheReadPerMTok),
    cacheWritePerMTok: num('BUDGET_USD_PER_MTOK_CACHE_WRITE', DEFAULT_TOKEN_PRICES.cacheWritePerMTok),
  };
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Estimated USD for a batch of tokens at the given prices. */
export function estimateCostUsd(t: TokenCounts, prices: TokenPrices): number {
  return (
    (t.inputTokens * prices.inputPerMTok +
      t.outputTokens * prices.outputPerMTok +
      t.cacheReadTokens * prices.cacheReadPerMTok +
      t.cacheCreationTokens * prices.cacheWritePerMTok) /
    1_000_000
  );
}
