/** B2-05: runtime-stack selection matrix (config/runtime.ts). */

import { describe, expect, it } from 'vitest';
import { resolveRuntimeConfig, RuntimeConfigError } from '../src/config/runtime.js';

const REAL_ENV = {
  HUB_RUNTIME: 'real',
  SEAM_BASE_URL: 'http://127.0.0.1:3001/',
  SEAM_USERNAME: 'agenthub',
  SEAM_PASSWORD: 'p4ss-value-x',
  CLAUDE_CODE_OAUTH_TOKEN: 'tok-value-y',
};

describe('resolveRuntimeConfig', () => {
  it('defaults to the fake stack with the S-01 fixtures dir', () => {
    const cfg = resolveRuntimeConfig({});
    expect(cfg.kind).toBe('fake');
    expect((cfg as { fixturesDir: string }).fixturesDir).toContain('S-01/fixtures');
  });

  it('resolves the real stack and trims trailing slashes off the base url', () => {
    const cfg = resolveRuntimeConfig(REAL_ENV);
    expect(cfg).toEqual({
      kind: 'real',
      seamBaseUrl: 'http://127.0.0.1:3001',
      seamUsername: 'agenthub',
      seamPassword: 'p4ss-value-x',
      oauthToken: 'tok-value-y',
    });
    // absent SEAM_OWNER_USER_ID → key omitted, sessions stay self-owned (N2)
    expect('seamOwnerUserId' in cfg).toBe(false);
  });

  it('carries SEAM_OWNER_USER_ID when set (N2 create-on-behalf, #420)', () => {
    const cfg = resolveRuntimeConfig({ ...REAL_ENV, SEAM_OWNER_USER_ID: 'owner-uuid-1' });
    expect((cfg as { seamOwnerUserId?: string }).seamOwnerUserId).toBe('owner-uuid-1');
  });

  it('fails fast naming every missing variable — never echoing values', () => {
    const err = (() => {
      try {
        resolveRuntimeConfig({ HUB_RUNTIME: 'real', SEAM_USERNAME: 'agenthub' });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(RuntimeConfigError);
    expect(err!.message).toContain('SEAM_BASE_URL');
    expect(err!.message).toContain('SEAM_PASSWORD');
    expect(err!.message).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(err!.message).not.toContain('agenthub'); // present values not echoed either
  });

  it('rejects an unknown HUB_RUNTIME value', () => {
    expect(() => resolveRuntimeConfig({ HUB_RUNTIME: 'staging' })).toThrow(RuntimeConfigError);
  });
});
