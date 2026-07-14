#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Spike S-03 — D1 turn-commit latency, value-size limits, quota math.
// Gates ADR-002 acceptance (revert criteria: turn-commit p50 > 150 ms from the
// co-located host, or quota headroom < 10×).
//
// Usage:
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//   node run-spike.mjs [--label deployment-host|other]
//
// Talks to the D1 HTTP API (same access path a co-located Node backend would
// use). Uses the scratch database `agenthub-s03-scratch` — NEVER a production
// database; tables are dropped at the end. No tokens, account ids, or database
// UUIDs are written to the results file — only the scratch database's *name*
// appears (safe to share after review).
//
// What it measures against the simulated Phase-1 schema
// (messages / run_events / usage_records):
//   1. single-statement write latency (n=30) — the floor every write pays
//   2. turn-commit as ONE multi-statement call: 1 message + 20 events
//      (single multi-row INSERT) + 1 usage record (n=15)
//   3. turn-commit as 3 sequential calls (n=15) — the naive implementation
//   4. UI read-back: SELECT last 50 events (n=15)
//   5. value-size probe: event payload 64K→2M until the API refuses
//   6. statement count per turn → quota math happens in RESULTS.md
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const DB_NAME = "agenthub-s03-scratch";
const LABEL = process.argv.includes("--label")
  ? process.argv[process.argv.indexOf("--label") + 1]
  : "unlabeled";

if (!TOKEN || !ACCOUNT) {
  console.error("ERROR: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
  process.exit(1);
}

const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1`;
const HEADERS = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

async function api(path, body, method = "POST") {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({ success: false, errors: [{ message: `non-JSON ${res.status}` }] }));
  return { http: res.status, ...json };
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  return sorted[lo] + (sorted[Math.ceil(pos)] - sorted[lo]) * (pos - lo);
}
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return {
    n: s.length,
    p50_ms: Math.round(quantile(s, 0.5)),
    p95_ms: Math.round(quantile(s, 0.95)),
    min_ms: Math.round(s[0]),
    max_ms: Math.round(s[s.length - 1]),
  };
}

async function main() {
  // Resolve database id by name (id itself never lands in results).
  const list = await api(`/database?name=${DB_NAME}`, null, "GET");
  const db = list.result?.find((d) => d.name === DB_NAME);
  if (!db) {
    console.error(`ERROR: database ${DB_NAME} not found in account`);
    process.exit(1);
  }
  const q = (sql) => api(`/database/${db.uuid}/query`, { sql });

  const results = { spike: "S-03", label: LABEL, ranAt: new Date().toISOString(), database: DB_NAME };

  // Schema (simulated Phase-1 shape, throwaway).
  console.error("setup: schema");
  const schema = await q(`
    DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS run_events; DROP TABLE IF EXISTS usage_records;
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE run_events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE usage_records (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, total_cost_usd REAL, num_turns INTEGER, created_at TEXT NOT NULL);
    CREATE INDEX idx_events_run ON run_events (run_id, seq);`);
  if (!schema.success) {
    console.error("ERROR: schema setup failed:", JSON.stringify(schema.errors));
    process.exit(1);
  }

  // Warmup.
  for (let i = 0; i < 3; i++) await q("SELECT 1;");

  const uid = () => randomUUID();
  const now = () => new Date().toISOString();
  const payload = JSON.stringify({ type: "output", stream: "stdout", data: "x".repeat(400) }).replace(/'/g, "''");

  // 1. Single-statement write floor.
  console.error("probe 1: single-statement writes (n=30)");
  const single = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    const r = await q(`INSERT INTO run_events VALUES ('${uid()}','run-single',${i},'output','${payload}','${now()}');`);
    if (!r.success) console.error("  warn: insert failed", JSON.stringify(r.errors));
    single.push(performance.now() - t0);
  }
  results.single_statement_write = stats(single);

  // Helpers for turn commits.
  const eventsValues = (runId, n) =>
    Array.from({ length: n }, (_, i) => `('${uid()}','${runId}',${i},'output','${payload}','${now()}')`).join(",");

  // 2. Turn-commit, one multi-statement call.
  console.error("probe 2: turn-commit 1-call (n=15)");
  const oneCall = [];
  for (let i = 0; i < 15; i++) {
    const runId = `run-1c-${i}`;
    const sql = `
      INSERT INTO messages VALUES ('${uid()}','conv-1','assistant','answer text ${i}','${now()}');
      INSERT INTO run_events VALUES ${eventsValues(runId, 20)};
      INSERT INTO usage_records VALUES ('${uid()}','${runId}',0.01,1,'${now()}');`;
    const t0 = performance.now();
    const r = await q(sql);
    if (!r.success) console.error("  warn: 1-call commit failed", JSON.stringify(r.errors));
    oneCall.push(performance.now() - t0);
  }
  results.turn_commit_1call = stats(oneCall);

  // 3. Turn-commit, three sequential calls.
  console.error("probe 3: turn-commit 3-call (n=15)");
  const threeCall = [];
  for (let i = 0; i < 15; i++) {
    const runId = `run-3c-${i}`;
    const t0 = performance.now();
    await q(`INSERT INTO messages VALUES ('${uid()}','conv-1','assistant','answer ${i}','${now()}');`);
    await q(`INSERT INTO run_events VALUES ${eventsValues(runId, 20)};`);
    await q(`INSERT INTO usage_records VALUES ('${uid()}','${runId}',0.01,1,'${now()}');`);
    threeCall.push(performance.now() - t0);
  }
  results.turn_commit_3call = stats(threeCall);

  // 4. UI read-back.
  console.error("probe 4: read-back last 50 events (n=15)");
  const reads = [];
  for (let i = 0; i < 15; i++) {
    const t0 = performance.now();
    await q("SELECT * FROM run_events ORDER BY created_at DESC, seq DESC LIMIT 50;");
    reads.push(performance.now() - t0);
  }
  results.read_last_50_events = stats(reads);

  // 5. Value-size probe.
  console.error("probe 5: value-size limits");
  results.value_size = [];
  for (const kb of [64, 256, 512, 900, 1500, 2000]) {
    const big = "y".repeat(kb * 1024);
    const t0 = performance.now();
    const r = await q(`INSERT INTO run_events VALUES ('${uid()}','run-size',${kb},'output','${big}','${now()}');`);
    results.value_size.push({
      kb,
      ok: !!r.success,
      ms: Math.round(performance.now() - t0),
      error: r.success ? undefined : (r.errors?.[0]?.message ?? `http ${r.http}`).slice(0, 160),
    });
    if (!r.success) break; // found the ceiling
  }

  // 6. Statement counts for quota math.
  results.statements_per_turn = { one_call_http_requests: 1, statements: 22, three_call_http_requests: 3 };

  // Cleanup.
  console.error("cleanup: dropping tables");
  await q("DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS run_events; DROP TABLE IF EXISTS usage_records;");

  console.log(JSON.stringify(results, null, 1));
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
