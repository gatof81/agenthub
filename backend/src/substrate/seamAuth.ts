/**
 * Seam authentication (Q-04, ADR-001, SEC-06): the Hub logs into the
 * substrate as its dedicated account via the existing `POST /auth/login`
 * and rides the httpOnly `st_token` JWT cookie on every seam call. The
 * token exists only in the Set-Cookie header (the login body never carries
 * it), is cached in memory, and is never logged (SEC-04).
 */

export class SeamAuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SeamAuthError';
  }
}

export interface SeamAuth {
  /** Value for the `Cookie` request header. Logs in lazily, single-flight. */
  cookieHeader(): Promise<string>;
  /** Drop the cached cookie (after a 401) so the next call re-logs-in. */
  invalidate(): void;
}

const COOKIE_NAME = 'st_token';

export interface CookieSeamAuthOptions {
  baseUrl: string;
  username: string;
  password: string;
  fetchImpl?: typeof fetch;
}

export class CookieSeamAuth implements SeamAuth {
  private cookie: string | null = null;
  private pending: Promise<string> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: CookieSeamAuthOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async cookieHeader(): Promise<string> {
    if (this.cookie !== null) return this.cookie;
    // single-flight: concurrent callers share one login round-trip
    this.pending ??= this.login().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  invalidate(): void {
    this.cookie = null;
  }

  private async login(): Promise<string> {
    const res = await this.fetchImpl(`${this.opts.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.opts.username, password: this.opts.password }),
    });
    if (!res.ok) {
      // body may hold rate-limit hints, but never echo credentials
      throw new SeamAuthError(res.status, `seam login failed (${res.status})`);
    }
    const setCookies = res.headers.getSetCookie();
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      if (pair?.startsWith(`${COOKIE_NAME}=`)) {
        this.cookie = pair;
        return pair;
      }
    }
    throw new SeamAuthError(res.status, `seam login succeeded but no ${COOKIE_NAME} cookie was set`);
  }
}
