/**
 * Cloudflare Access JWT verification (Q-07, ADR-011): browser traffic reaches
 * the Hub through a Cloudflare tunnel with Access in front. Access authorizes
 * the human (OTP to an allow-listed email) and stamps every request with a
 * signed `Cf-Access-Jwt-Assertion`. The backend VERIFIES that JWT — signature
 * against the team's JWKS, plus `aud`/`iss`/expiry — and never trusts the
 * plaintext `Cf-Access-Authenticated-User-Email` header alone, which anything
 * reaching the backend off-tunnel could forge.
 *
 * No JWT library: Cloudflare Access signs RS256, and `node:crypto` imports a
 * JWK public key and verifies RS256 directly. The JWKS fetch is injectable so
 * the suite stays offline (13 §6).
 */

import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export interface AccessIdentity {
  email: string;
}

/** Verifies a Cloudflare Access JWT; resolves the identity or null (never throws). */
export interface AccessVerifier {
  verify(token: string): Promise<AccessIdentity | null>;
}

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  alg?: string;
}

export interface AccessConfig {
  /** team domain, e.g. `https://<team>.cloudflareaccess.com` (no trailing slash) */
  issuer: string;
  /** the Access application's AUD tag */
  aud: string;
  /** JWKS source; default fetches `${issuer}/cdn-cgi/access/certs`. Injected in tests. */
  fetchJwks?: () => Promise<{ keys: Jwk[] }>;
  /** clock (ms); default `Date.now`. Injected in tests for exp/nbf. */
  now?: () => number;
}

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function b64urlToJson(s: string): Record<string, unknown> {
  return JSON.parse(b64urlToBuf(s).toString('utf8')) as Record<string, unknown>;
}

/**
 * RS256 Access-JWT verifier over `node:crypto`. Keys are cached by `kid`; an
 * unknown `kid` triggers exactly one refetch (key rotation) before giving up.
 */
export class CryptoAccessVerifier implements AccessVerifier {
  private readonly issuer: string;
  private readonly aud: string;
  private readonly fetchJwks: () => Promise<{ keys: Jwk[] }>;
  private readonly now: () => number;
  private keys = new Map<string, KeyObject>();

  constructor(cfg: AccessConfig) {
    this.issuer = cfg.issuer.replace(/\/+$/, '');
    this.aud = cfg.aud;
    this.now =
      cfg.now ??
      (() => Date.now());
    this.fetchJwks =
      cfg.fetchJwks ??
      (async () => {
        const res = await fetch(`${this.issuer}/cdn-cgi/access/certs`);
        if (!res.ok) throw new Error(`JWKS fetch ${res.status}`);
        return (await res.json()) as { keys: Jwk[] };
      });
  }

  async verify(token: string): Promise<AccessIdentity | null> {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const [rawHeader, rawPayload, rawSig] = parts as [string, string, string];
      const header = b64urlToJson(rawHeader);
      if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

      const key = await this.keyForKid(header.kid);
      if (key === null) return null;

      const signed = Buffer.from(`${rawHeader}.${rawPayload}`);
      if (!cryptoVerify('RSA-SHA256', signed, key, b64urlToBuf(rawSig))) return null;

      const payload = b64urlToJson(rawPayload);
      // aud may be a string or an array; ours must be present
      const aud = payload.aud;
      const audOk = Array.isArray(aud) ? aud.includes(this.aud) : aud === this.aud;
      if (!audOk) return null;
      if (payload.iss !== this.issuer) return null;

      const nowSec = Math.floor(this.now() / 1000);
      if (typeof payload.exp === 'number' && nowSec >= payload.exp) return null;
      if (typeof payload.nbf === 'number' && nowSec < payload.nbf) return null;

      const email = typeof payload.email === 'string' ? payload.email : '';
      return { email };
    } catch {
      // any malformed token / JWKS failure is a rejection, never a throw into
      // the gateway — an auth check that errors must fail closed
      return null;
    }
  }

  private async keyForKid(kid: string): Promise<KeyObject | null> {
    const cached = this.keys.get(kid);
    if (cached !== undefined) return cached;
    await this.refreshKeys();
    return this.keys.get(kid) ?? null;
  }

  private async refreshKeys(): Promise<void> {
    const { keys } = await this.fetchJwks();
    const next = new Map<string, KeyObject>();
    for (const jwk of keys) {
      if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.n || !jwk.e) continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
      } catch {
        // skip a malformed key rather than fail the whole set
      }
    }
    this.keys = next;
  }
}

/** Build a verifier from env config, or null when Access is not configured. */
export function resolveAccessVerifier(
  env: Record<string, string | undefined>,
): CryptoAccessVerifier | null {
  const issuer = env.HUB_ACCESS_ISSUER;
  const aud = env.HUB_ACCESS_AUD;
  if (!issuer || !aud) return null;
  return new CryptoAccessVerifier({ issuer, aud });
}
