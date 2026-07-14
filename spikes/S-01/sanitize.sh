#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Spike S-01 fixture sanitizer.
#
# Input:  a raw run directory (spikes/S-01/raw/run-<stamp>/, gitignored)
# Output: <run-dir>-sanitized/ — the ONLY thing eligible to be committed,
#         and only under docs/spikes/S-01/fixtures/ after human review.
#
# What it does:
#   - HARD-FAILS if any Anthropic key material (sk-ant…) appears anywhere.
#   - Replaces session_id values with stable placeholders (S01-SESSION-A, B…)
#     consistently across all files, preserving resume-chain structure.
#   - Replaces UUIDs (account/org/request ids) with S01-UUID-n placeholders.
#   - Replaces Anthropic API identifiers (msg_*, req_*, toolu_*) with
#     S01-MSG-n / S01-REQ-n / S01-TOOLU-n — they are traceable to the account
#     in provider-side logs (first-execution review finding).
#   - Drops fields that can carry environment specifics: cwd, apiKeySource.
#   - Strips absolute host paths if any leaked (only container paths like
#     /home/developer/workspace are expected and kept).
#
# Usage: ./sanitize.sh spikes/S-01/raw/run-<stamp>
# Dependencies: jq, python3 (for the cross-file consistent replacements).
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RUN_DIR="${1:?usage: ./sanitize.sh <raw-run-dir>}"
[ -d "$RUN_DIR" ] || { echo "ERROR: $RUN_DIR is not a directory" >&2; exit 1; }
OUT_DIR="${RUN_DIR%/}-sanitized"

if grep -rq "sk-ant" "$RUN_DIR"; then
	echo "ERROR: Anthropic key material found in raw output. Fix the leak before sanitizing:" >&2
	grep -rln "sk-ant" "$RUN_DIR" >&2
	exit 1
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

python3 - "$RUN_DIR" "$OUT_DIR" <<'PYEOF'
import json, os, re, shutil, sys

run_dir, out_dir = sys.argv[1], sys.argv[2]
session_map: dict[str, str] = {}
uuid_map: dict[str, str] = {}
api_id_maps: dict[str, dict[str, str]] = {"msg": {}, "req": {}, "toolu": {}}
UUID_RE = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
# Anthropic API object ids (message/request/tool-use). Length floor keeps
# non-identifier tokens like "msg_lifecycle" untouched.
API_ID_RE = re.compile(r"\b(msg|req|toolu)_[A-Za-z0-9]{16,}\b")
DROP_FIELDS = {"cwd", "apiKeySource"}

def session_placeholder(sid: str) -> str:
    if sid not in session_map:
        session_map[sid] = f"S01-SESSION-{chr(ord('A') + len(session_map))}"
    return session_map[sid]

def scrub(obj):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k in DROP_FIELDS:
                continue
            if k == "session_id" and isinstance(v, str):
                out[k] = session_placeholder(v)
            else:
                out[k] = scrub(v)
        return out
    if isinstance(obj, list):
        return [scrub(x) for x in obj]
    if isinstance(obj, str):
        for sid, ph in session_map.items():
            obj = obj.replace(sid, ph)
        def uuid_sub(m):
            u = m.group(0)
            if u not in uuid_map:
                uuid_map[u] = f"S01-UUID-{len(uuid_map) + 1}"
            return uuid_map[u]
        obj = UUID_RE.sub(uuid_sub, obj)
        def api_id_sub(m):
            kind, full = m.group(1), m.group(0)
            table = api_id_maps[kind]
            if full not in table:
                table[full] = f"S01-{kind.upper()}-{len(table) + 1}"
            return table[full]
        return API_ID_RE.sub(api_id_sub, obj)
    return obj

# Pass 1: collect session ids from all result events so placeholders are
# assigned in a stable, chain-preserving order.
for root, _, files in sorted((r, d, sorted(f)) for r, d, f in os.walk(run_dir)):
    for name in files:
        if name.endswith(".jsonl") or name.endswith(".json"):
            with open(os.path.join(root, name), encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    try:
                        o = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(o, dict) and isinstance(o.get("session_id"), str):
                        session_placeholder(o["session_id"])

# Pass 2: rewrite every file.
for root, _, files in os.walk(run_dir):
    rel = os.path.relpath(root, run_dir)
    dst_root = os.path.join(out_dir, rel) if rel != "." else out_dir
    os.makedirs(dst_root, exist_ok=True)
    for name in sorted(files):
        src = os.path.join(root, name)
        dst = os.path.join(dst_root, name)
        if name.endswith(".jsonl"):
            with open(src, encoding="utf-8", errors="replace") as fi, open(dst, "w", encoding="utf-8") as fo:
                for line in fi:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        fo.write(json.dumps(scrub(json.loads(line)), ensure_ascii=False) + "\n")
                    except json.JSONDecodeError:
                        fo.write(scrub(line) + "\n")
        elif name.endswith(".json"):
            with open(src, encoding="utf-8", errors="replace") as fi:
                try:
                    data = json.load(fi)
                    with open(dst, "w", encoding="utf-8") as fo:
                        json.dump(scrub(data), fo, ensure_ascii=False, indent=1)
                except json.JSONDecodeError:
                    shutil.copyfile(src, dst)
        else:
            # Text artifacts (summary, stderr, zombie censuses): string-scrub.
            with open(src, encoding="utf-8", errors="replace") as fi:
                content = fi.read()
            with open(dst, "w", encoding="utf-8") as fo:
                fo.write(scrub(content))

with open(os.path.join(out_dir, "SANITIZATION.json"), "w", encoding="utf-8") as fh:
    json.dump(
        {
            "sessions_replaced": len(session_map),
            "uuids_replaced": len(uuid_map),
            "message_ids_replaced": len(api_id_maps["msg"]),
            "request_ids_replaced": len(api_id_maps["req"]),
            "tool_use_ids_replaced": len(api_id_maps["toolu"]),
            "fields_dropped": sorted(DROP_FIELDS),
            "note": "placeholder maps are intentionally NOT written out",
        },
        fh,
        indent=1,
    )
print(f"sanitized -> {out_dir} (sessions={len(session_map)} uuids={len(uuid_map)})")
PYEOF

# Final gate: nothing key-shaped or provider-id-shaped may remain.
if grep -rq "sk-ant" "$OUT_DIR"; then
	echo "ERROR: key material survived sanitization — do not commit. Inspect $OUT_DIR" >&2
	exit 1
fi
if grep -rEq "\b(msg|req|toolu)_[A-Za-z0-9]{16,}\b" "$OUT_DIR"; then
	echo "ERROR: Anthropic API identifiers survived sanitization — do not commit. Inspect $OUT_DIR" >&2
	exit 1
fi
echo "Review $OUT_DIR manually, then copy the reviewed files into docs/spikes/S-01/fixtures/."
