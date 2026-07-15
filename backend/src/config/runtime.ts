/**
 * Runtime-stack selection (B2-05): pure env → config resolution, kept out
 * of the composition root so the matrix is unit-testable. `fake` (default)
 * is the Increment-1 offline stack — CI runs with no credentials present
 * (13 §6); `real` is the Increment-2 stack and requires the seam account
 * and the Claude OAuth token up front (fail fast, before anything binds).
 *
 * Error messages name missing VARIABLES, never echo values (SEC-04).
 */

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

export interface FakeRuntimeConfig {
  kind: 'fake';
  fixturesDir: string;
}

export interface RealRuntimeConfig {
  kind: 'real';
  /** deployment config only — never a committed value (R-09) */
  seamBaseUrl: string;
  seamUsername: string;
  seamPassword: string;
  /** injected into each run's exec env; never persisted or logged (SEC-07, 13 §5) */
  oauthToken: string;
}

export type RuntimeConfig = FakeRuntimeConfig | RealRuntimeConfig;

const REAL_REQUIRED = [
  'SEAM_BASE_URL',
  'SEAM_USERNAME',
  'SEAM_PASSWORD',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

export function resolveRuntimeConfig(
  env: Record<string, string | undefined>,
): RuntimeConfig {
  const kind = env.HUB_RUNTIME ?? 'fake';
  if (kind === 'fake') {
    return {
      kind: 'fake',
      fixturesDir:
        env.HUB_FAKE_FIXTURES_DIR ?? '../docs/spikes/S-01/fixtures/run-20260714T142930Z',
    };
  }
  if (kind === 'real') {
    const missing = REAL_REQUIRED.filter((k) => !env[k]);
    if (missing.length > 0) {
      throw new RuntimeConfigError(`HUB_RUNTIME=real requires: ${missing.join(', ')}`);
    }
    return {
      kind: 'real',
      seamBaseUrl: env.SEAM_BASE_URL!.replace(/\/+$/, ''),
      seamUsername: env.SEAM_USERNAME!,
      seamPassword: env.SEAM_PASSWORD!,
      oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN!,
    };
  }
  throw new RuntimeConfigError(
    `HUB_RUNTIME must be "fake" or "real", got ${JSON.stringify(kind)}`,
  );
}
