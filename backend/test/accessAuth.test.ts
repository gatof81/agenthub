/**
 * Cloudflare Access JWT verification (ADR-011, Q-07). Offline: an RSA keypair
 * signs test JWTs and the JWKS is injected, so the real crypto path (RS256
 * signature + aud/iss/exp) is exercised with no network (13 §6).
 */

import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { Broadcaster } from '../src/api/broadcaster.js';
import { CryptoAccessVerifier, type AccessVerifier } from '../src/api/accessAuth.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { FakeRuntimeAdapter } from '../src/runtime/fakeAdapter.js';
import { MemoryHubStore } from '../src/store/memory.js';
import { FakeSubstrateExecPort } from '../src/substrate/fake.js';
import { DEV_AGENT } from './apiHarness.js';

const ISSUER = 'https://team.cloudflareaccess.com';
const AUD = 'aud-tag-abc123';
const KID = 'key-1';
const FIXED_NOW = 1_800_000_000_000; // fixed ms clock for exp/nbf

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256' };
const jwks = { keys: [jwk] };

function signJwt(
  payload: Record<string, unknown>,
  opts: { kid?: string; key?: KeyObject } = {},
): string {
  const header = { alg: 'RS256', kid: opts.kid ?? KID, typ: 'JWT' };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = cryptoSign('RSA-SHA256', Buffer.from(`${h}.${p}`), opts.key ?? privateKey).toString(
    'base64url',
  );
  return `${h}.${p}.${sig}`;
}

/** A valid-shaped Access payload, `exp` 1h ahead of FIXED_NOW. */
function validPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  const nowSec = Math.floor(FIXED_NOW / 1000);
  return { iss: ISSUER, aud: AUD, email: 'owner@example.com', exp: nowSec + 3600, ...over };
}

function makeVerifier(over: Partial<ConstructorParameters<typeof CryptoAccessVerifier>[0]> = {}) {
  let fetches = 0;
  const verifier = new CryptoAccessVerifier({
    issuer: ISSUER,
    aud: AUD,
    now: () => FIXED_NOW,
    fetchJwks: () => {
      fetches += 1;
      return Promise.resolve(jwks);
    },
    ...over,
  });
  return { verifier, fetches: () => fetches };
}

describe('CryptoAccessVerifier', () => {
  it('accepts a correctly signed token with our aud + iss and returns the email', async () => {
    const { verifier } = makeVerifier();
    const id = await verifier.verify(signJwt(validPayload()));
    expect(id).toEqual({ email: 'owner@example.com' });
  });

  it('accepts aud as an array containing our aud', async () => {
    const { verifier } = makeVerifier();
    const id = await verifier.verify(signJwt(validPayload({ aud: ['other', AUD] })));
    expect(id).not.toBeNull();
  });

  it('rejects a token for a different aud (another Access app)', async () => {
    const { verifier } = makeVerifier();
    expect(await verifier.verify(signJwt(validPayload({ aud: 'someone-else' })))).toBeNull();
  });

  it('rejects a token from a different issuer', async () => {
    const { verifier } = makeVerifier();
    expect(
      await verifier.verify(signJwt(validPayload({ iss: 'https://evil.cloudflareaccess.com' }))),
    ).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { verifier } = makeVerifier();
    const nowSec = Math.floor(FIXED_NOW / 1000);
    expect(await verifier.verify(signJwt(validPayload({ exp: nowSec - 1 })))).toBeNull();
  });

  it('rejects a token not yet valid (nbf in the future)', async () => {
    const { verifier } = makeVerifier();
    const nowSec = Math.floor(FIXED_NOW / 1000);
    expect(await verifier.verify(signJwt(validPayload({ nbf: nowSec + 60 })))).toBeNull();
  });

  it('rejects a token signed by a different (attacker) key', async () => {
    const { verifier } = makeVerifier();
    const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(await verifier.verify(signJwt(validPayload(), { key: attacker.privateKey }))).toBeNull();
  });

  it('rejects a malformed token without throwing', async () => {
    const { verifier } = makeVerifier();
    expect(await verifier.verify('not.a.jwt')).toBeNull();
    expect(await verifier.verify('garbage')).toBeNull();
    expect(await verifier.verify('')).toBeNull();
  });

  it('rejects an unsupported alg (e.g. none/HS256) — never a signature bypass', async () => {
    const { verifier } = makeVerifier();
    const h = Buffer.from(JSON.stringify({ alg: 'none', kid: KID })).toString('base64url');
    const p = Buffer.from(JSON.stringify(validPayload())).toString('base64url');
    expect(await verifier.verify(`${h}.${p}.`)).toBeNull();
  });

  it('refetches the JWKS once on an unknown kid, then caches', async () => {
    const { verifier, fetches } = makeVerifier();
    await verifier.verify(signJwt(validPayload())); // kid known after first fetch
    await verifier.verify(signJwt(validPayload())); // cached, no refetch
    expect(fetches()).toBe(1);
    // a token with an unknown kid triggers exactly one refetch, still null
    expect(await verifier.verify(signJwt(validPayload(), { kid: 'rotated' }))).toBeNull();
    expect(fetches()).toBe(2);
  });

  it('fails closed when the JWKS fetch throws', async () => {
    const { verifier } = makeVerifier({ fetchJwks: () => Promise.reject(new Error('network')) });
    expect(await verifier.verify(signJwt(validPayload()))).toBeNull();
  });
});

// — gateway integration: bearer OR Access JWT —

const TOKEN = 'gateway-bearer-token';

function makeApp(accessVerifier?: AccessVerifier): ReturnType<typeof buildApp> {
  const store = new MemoryHubStore();
  const port = new FakeSubstrateExecPort();
  return buildApp({
    store,
    orchestrator: new Orchestrator({
      store,
      adapter: new FakeRuntimeAdapter(port),
      execPort: port,
      agents: new Map([[DEV_AGENT.id, DEV_AGENT]]),
    }),
    agents: new Map([[DEV_AGENT.id, DEV_AGENT]]),
    workspaceTemplates: [{ id: 'tpl', name: 'Test workspace' }],
    broadcaster: new Broadcaster(),
    authToken: TOKEN,
    ...(accessVerifier ? { accessVerifier } : {}),
  });
}

describe('gateway auth (ADR-011): bearer OR Access JWT', () => {
  it('accepts a valid Access JWT with no bearer token (browser via Access)', async () => {
    const { verifier } = makeVerifier();
    const app = makeApp(verifier);
    const res = await request(app)
      .get('/api/agents')
      .set('Cf-Access-Jwt-Assertion', signJwt(validPayload()));
    expect(res.status).toBe(200);
  });

  it('still accepts the bearer token (localhost / programmatic)', async () => {
    const { verifier } = makeVerifier();
    const app = makeApp(verifier);
    const res = await request(app).get('/api/agents').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
  });

  it('rejects an invalid Access JWT with no bearer (401, fail closed)', async () => {
    const { verifier } = makeVerifier();
    const app = makeApp(verifier);
    const res = await request(app)
      .get('/api/agents')
      .set('Cf-Access-Jwt-Assertion', signJwt(validPayload({ aud: 'wrong' })));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: 'unauthorized' });
  });

  it('does not trust the plaintext email header alone (no signed JWT → 401)', async () => {
    const { verifier } = makeVerifier();
    const app = makeApp(verifier);
    const res = await request(app)
      .get('/api/agents')
      .set('Cf-Access-Authenticated-User-Email', 'owner@example.com');
    expect(res.status).toBe(401);
  });

  it('with no verifier configured, an Access JWT is ignored — bearer only (dev/local)', async () => {
    const app = makeApp(); // no verifier
    const jwtOnly = await request(app)
      .get('/api/agents')
      .set('Cf-Access-Jwt-Assertion', signJwt(validPayload()));
    expect(jwtOnly.status).toBe(401);
    const withBearer = await request(app).get('/api/agents').set('Authorization', `Bearer ${TOKEN}`);
    expect(withBearer.status).toBe(200);
  });

  it('leaves /api/health public regardless of Access', async () => {
    const { verifier } = makeVerifier();
    const res = await request(makeApp(verifier)).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
