# ADR-011 — Browser authentication via Cloudflare Access (Q-07, Phase 1)

Status: accepted (owner, 2026-07-17)
Date: 2026-07-17

Supersedes the Phase-1 provisional in Q-07 (single static token) for
browser traffic. The bearer token stays for localhost/programmatic callers.

## Context

Deploying the Hub at `<hub-hostname>` (ADR-002: one Cloudflare tunnel → the
co-located backend serving `/api` and the SPA) exposes it beyond localhost.
The Phase-1 auth was a single static `HUB_API_TOKEN` bearer, pasted into the
SPA's token gate. A shared secret a browser must hold is not a real
human-auth model for a public origin: it cannot be rotated per session, it
lives in `localStorage`, and anyone who obtains it is the owner.

Q-07 (Hub user/auth model) was deliberately deferred "until multi-user
pressure is real." Public exposure makes it real now — narrowly: still one
user (the owner), but reachable from the internet, so the gate has to be an
actual identity check.

Cloudflare Access is already in front of the tunnel (owner + shared-terminal,
2026-07-17): it authorizes the human (one-time PIN to an allow-listed email)
and stamps every forwarded request with a **signed** `Cf-Access-Jwt-Assertion`
JWT, plus a plaintext `Cf-Access-Authenticated-User-Email`. `/api/health` has
a public bypass for liveness.

## Options

1. **Do nothing — keep the static bearer, rely on Access alone.** Access at
   the edge blocks unauthenticated traffic, so "it works." Rejected: the
   backend would trust that it is *only* ever reachable through Access. The
   moment it is reachable off-tunnel (localhost on the VM, LAN, a future
   bypass rule), there is no auth at all. Auth the backend does not enforce
   itself is not auth.
2. **Trust the `Cf-Access-Authenticated-User-Email` header.** Zero crypto,
   read a header. Rejected outright: a plaintext header is forgeable by
   anything that reaches the backend off the Access path — the classic
   trusted-header trap. It would turn "reachable off-tunnel" from a
   defense-in-depth gap into a full auth bypass.
3. **The backend verifies the signed Access JWT.** Validate
   `Cf-Access-Jwt-Assertion` — RS256 signature against the team's JWKS, plus
   `aud` (this Access application) and `iss` (the team domain) and expiry —
   for browser traffic; keep the bearer token for localhost/programmatic.
4. **A full Hub-owned login (users, sessions, password/OAuth).** Rejected for
   now: real auth surface to build and secure for a single user, when Access
   already owns identity and the allow policy. Revisit if the Hub becomes
   multi-user or must run without Cloudflare.

## Decision

Option 3. The `/api` gateway accepts a request when **either**:

- it carries the valid bearer `HUB_API_TOKEN` (localhost, programmatic, and
  the SPA's dev/local fallback), **or**
- it carries a `Cf-Access-Jwt-Assertion` that **verifies**: RS256 signature
  against the JWKS at `${issuer}/cdn-cgi/access/certs`, `aud` equal to the
  configured Access AUD, `iss` equal to the configured team domain, and not
  expired / not-before. The plaintext email header is **never** trusted; the
  email is read from the verified JWT only.

Verification is fail-closed: any malformed token, unknown signing key, or
JWKS-fetch error is a rejection, never an exception into the gateway. Keys
are cached by `kid` with a single refetch on an unknown `kid` (rotation).

Configuration is env-only (`HUB_ACCESS_ISSUER`, `HUB_ACCESS_AUD`) — a
deployment identifier, never committed (R-09). Absent → Access verification
is off and the gateway is bearer-only (dev, local, CI). No JWT library: the
verifier is RS256 over `node:crypto`, JWKS injectable so the suite stays
offline (13 §6).

Authorization stays with Access: a JWT bearing our `aud` was issued for our
Access application, whose policy admits only the owner's email. The backend
therefore checks the token's provenance, not an allow-list of its own — Q-07
stays single-user.

The SPA, on load, probes an authenticated endpoint with no token; behind
Access the injected JWT authorizes it and the token gate is skipped, so a
human never pastes a token. A `401` (no Access) falls through to the gate.

## Consequences

- The Hub enforces identity itself, not just at the edge — the off-tunnel
  reachability gap (defense-in-depth) is closed. The threat-model note in
  doc 10 §2 (Substrate JWT / execution identity) is unaffected; this is the
  **inbound** human-auth surface, previously just a static token.
- New env: `HUB_ACCESS_ISSUER`, `HUB_ACCESS_AUD` (`.env.example` documents
  them). The bearer `HUB_API_TOKEN` is retained, not replaced.
- The email from a verified JWT is available for future per-user audit
  (SEC-08) without any new trust — it rides the signature.
- Follow-ups (not this ADR): binding runs/audit rows to the authenticated
  email; a Hub-owned login only if Cloudflare-independent deployment or
  multi-user is ever required (Option 4).
- Q-07 moves from "deferred" to "resolved for Phase-1 browser auth"; the
  full user/tenant model remains future work.
