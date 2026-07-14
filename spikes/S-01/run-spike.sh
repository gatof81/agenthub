#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Spike S-01 — headless Claude CLI runner probe.
#
# Runs against a container from the shared-terminal session image (CLI pinned
# 2.1.207) and records stream-json fixtures answering (see docs/spikes/S-01/):
#
#   P0  onboarding/trust behavior of a bare headless run on a fresh state dir
#   P1  does a headless run WITHOUT permission flags freeze on the first
#       tool prompt? (risk R-03)
#   P2  baseline turn: timings + session_id/cost fields of the result event
#   P3  per-turn --resume startup latency, 3 turns (Q-01)
#   P4  cancellation via process-group TERM→poll→KILL mid tool call, plus a
#       zombie census before/after (R-04 residual, Q-08)
#   P5  tool_use event shape: are commands and file paths derivable for the
#       activity view? (adjustment A2)
#
# Usage:
#   ANTHROPIC_API_KEY=sk-...        ./run-spike.sh [image-tag]   # pay-as-you-go
#   CLAUDE_CODE_OAUTH_TOKEN=sk-...  ./run-spike.sh [image-tag]   # subscription
#
# Exactly one auth source is required. Under subscription auth the result
# events' cost fields may read 0/absent — that is itself a probe-iv finding.
#
# Image tag defaults to `shared-terminal-session` (smoke-test convention).
# SPENDS TOKENS (small prompts, ~6 turns; see runbook cost note). Prompts for
# confirmation unless S01_YES=1. Dependencies: docker, jq, mktemp.
#
# Raw output lands in spikes/S-01/raw/run-<utc-stamp>/ (gitignored). Run
# ./sanitize.sh afterwards; only sanitized fixtures may be committed, and only
# under docs/spikes/S-01/fixtures/ after human review.
# ──────────────────────────────────────────────────────────────────────────────
set -uo pipefail

IMAGE="${1:-shared-terminal-session}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$SCRIPT_DIR/raw/run-$STAMP"
C="st-s01-$$"
WS="$(mktemp -d)"
FAILS=0

AUTH_ARGS=()
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
	AUTH_ARGS+=(-e ANTHROPIC_API_KEY)
	AUTH_MODE="api-key"
elif [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
	AUTH_ARGS+=(-e CLAUDE_CODE_OAUTH_TOKEN)
	AUTH_MODE="subscription-oauth"
else
	echo "ERROR: set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN" >&2
	exit 1
fi
command -v jq >/dev/null || { echo "ERROR: jq is required" >&2; exit 1; }

if [ "${S01_YES:-0}" != "1" ]; then
	echo "This spike SPENDS API TOKENS (~6 small turns on the default model)."
	read -r -p "Continue? [y/N] " reply
	[ "$reply" = "y" ] || [ "$reply" = "Y" ] || { echo "aborted"; exit 1; }
fi

mkdir -p "$OUT"
chmod 777 "$WS"

cleanup() {
	docker rm -f "$C" >/dev/null 2>&1
	# Workspace contents are uid-1000-owned; empty from a throwaway container
	# (same trick as the substrate's smoke test), then remove.
	docker run --rm -v "$WS":/ws --entrypoint bash "$IMAGE" \
		-c 'rm -rf /ws/* /ws/.[!.]* 2>/dev/null; true' >/dev/null 2>&1
	rm -rf "$WS" 2>/dev/null
}
trap cleanup EXIT

phase() { echo; echo "── $1 ──"; }
ok() { echo "  ok: $1"; }
fail() { echo "  FAIL: $1" >&2; FAILS=$((FAILS + 1)); }
now_ms() { date +%s%3N; }

# ── boot ─────────────────────────────────────────────────────────────────────
phase "boot: $IMAGE"
docker run -d --name "$C" "${AUTH_ARGS[@]}" -v "$WS":/home/developer/workspace "$IMAGE" >/dev/null \
	|| { fail "docker run failed"; exit 1; }
echo "  auth mode: $AUTH_MODE"
i=0
until docker logs "$C" 2>&1 | grep -q "container ready"; do
	i=$((i + 1))
	[ "$i" -gt 60 ] && { fail "never reached 'container ready'"; docker logs "$C" | tail -20 >&2; exit 1; }
	sleep 0.5
done
ok "container ready"
CLI_VERSION=$(docker exec "$C" bash -c 'command claude --version' 2>&1)
echo "  claude --version: $CLI_VERSION"

# ── helpers ──────────────────────────────────────────────────────────────────
# exec_probe NAME TIMEOUT_S CMD...
# Runs CMD in the container under setsid (own process group, sentinel pgid
# line — mirrors the substrate's streamExec wrapper). Streams stdout lines to
# $OUT/NAME/stream.jsonl with per-line timestamps in times.tsv. Writes
# meta.json with t0/t_first/t_end/rc/pgid.
exec_probe() {
	local name="$1" timeout_s="$2"; shift 2
	local dir="$OUT/$name"; mkdir -p "$dir"
	: > "$dir/stream.jsonl"; : > "$dir/times.tsv"; : > "$dir/pgid"
	local t0; t0=$(now_ms)
	timeout -k 5 "$timeout_s" docker exec "$C" setsid bash -c \
		'echo "__S01_PGID__ $$"; exec "$@"' s01-exec "$@" 2>"$dir/stderr.log" \
		| while IFS= read -r line; do
			case "$line" in
				"__S01_PGID__ "*) printf '%s' "${line#__S01_PGID__ }" > "$dir/pgid" ;;
				*)
					printf '%s\n' "$line" >> "$dir/stream.jsonl"
					printf '%s\t%s\n' "$(now_ms)" "${#line}" >> "$dir/times.tsv"
					;;
			esac
		done
	local rc="${PIPESTATUS[0]}"
	local t_end; t_end=$(now_ms)
	local t_first=null
	[ -s "$dir/times.tsv" ] && t_first=$(head -1 "$dir/times.tsv" | cut -f1)
	jq -n --argjson t0 "$t0" --argjson tFirst "$t_first" --argjson tEnd "$t_end" \
		--argjson rc "$rc" --arg pgid "$(cat "$dir/pgid")" --arg cli "$CLI_VERSION" \
		'{t0_ms:$t0, t_first_line_ms:$tFirst, t_end_ms:$tEnd, exit_code:$rc, pgid:$pgid, cli_version:$cli}' \
		> "$dir/meta.json"
	echo "  $name: rc=$rc lines=$(wc -l < "$dir/stream.jsonl") pgid=$(cat "$dir/pgid")"
	return "$rc"
}

# kill_group PGID GRACE_MS — TERM the group, poll /proc (zombie-aware, same
# parse as the substrate's alive() probe), KILL survivors. Prints the outcome.
kill_group() {
	docker exec "$C" bash -c '
		pg="$1"; grace_ms="$2"
		alive() {
			for f in /proc/[0-9]*/stat; do
				rest="$(cat "$f" 2>/dev/null)" || continue
				rest="${rest##*) }"; set -- $rest
				[ "${3:-}" = "$pg" ] && [ "${1:-}" != "Z" ] && return 0
			done; return 1
		}
		alive || { echo already-exited; exit 0; }
		kill -TERM -- "-$pg" 2>/dev/null
		polls=$(( grace_ms / 200 )); [ "$polls" -lt 1 ] && polls=1
		for _ in $(seq 1 "$polls"); do
			alive || { echo terminated; exit 0; }
			sleep 0.2
		done
		kill -KILL -- "-$pg" 2>/dev/null
		sleep 0.3
		alive && echo survivors || echo killed
	' s01-kill "$1" "$2"
}

zombie_census() { # NAME — snapshot zombies in the container
	docker exec "$C" bash -c '
		for f in /proc/[0-9]*/stat; do
			rest="$(cat "$f" 2>/dev/null)" || continue
			pid="${f#/proc/}"; pid="${pid%/stat}"
			comm="${rest#*(}"; comm="${comm%%)*}"
			rest="${rest##*) }"; set -- $rest
			[ "${1:-}" = "Z" ] && echo "pid=$pid ppid=${2:-?} comm=$comm"
		done; true
	' > "$OUT/zombies-$1.txt"
	echo "  zombies($1): $(wc -l < "$OUT/zombies-$1.txt")"
}

CLAUDE="claude -p --output-format stream-json --verbose"

# ── P0: bare headless run on fresh state (onboarding/trust behavior) ────────
phase "P0: fresh-state headless run (onboarding probe)"
exec_probe p0-onboarding 90 bash -lc "$CLAUDE --max-turns 1 'Reply with exactly: ok'"
if jq -e 'select(.type=="result")' "$OUT/p0-onboarding/stream.jsonl" >/dev/null 2>&1; then
	ok "P0 produced a result event — no onboarding blocker"
else
	fail "P0 produced no result event — inspect stream/stderr (onboarding or auth blocker; this IS a finding)"
	# Fallback so later probes still run: mark onboarding complete.
	docker exec "$C" bash -c 'jq -n "{hasCompletedOnboarding:true}" > ~/.claude.json 2>/dev/null || echo "{\"hasCompletedOnboarding\":true}" > ~/.claude.json'
	echo "  seeded hasCompletedOnboarding=true as fallback (recorded)"
fi

# ── P1: no permission flags + a tool-requiring task (freeze probe) ──────────
phase "P1: freeze without permission flags (90s timeout)"
exec_probe p1-freeze 90 bash -lc "$CLAUDE --max-turns 3 'Create a file named probe.txt containing the word hello. You must actually create it.'"
P1_RC=$(jq -r .exit_code "$OUT/p1-freeze/meta.json")
if jq -e 'select(.type=="result")' "$OUT/p1-freeze/stream.jsonl" >/dev/null 2>&1; then
	echo "  P1 completed with a result event (rc=$P1_RC) — did NOT freeze; check whether the tool ran or was auto-denied"
else
	echo "  P1 timed out or died without a result (rc=$P1_RC, 124=timeout) — freeze/deny behavior confirmed; see last stream event"
fi
P1_PGID=$(cat "$OUT/p1-freeze/pgid")
[ -n "$P1_PGID" ] && echo "  p1 leftover kill: $(kill_group "$P1_PGID" 3000)"
zombie_census after-p1

# ── P2: baseline turn — timings, session_id, cost fields ────────────────────
phase "P2: baseline turn"
exec_probe p2-baseline 120 bash -lc "$CLAUDE --max-turns 1 'Reply with exactly: ready'"
SID=$(jq -r 'select(.type=="result") | .session_id // empty' "$OUT/p2-baseline/stream.jsonl" | tail -1)
if [ -n "$SID" ]; then ok "session_id captured"; else fail "no session_id in P2 result — resume probes will fail"; fi
jq -c 'select(.type=="result")' "$OUT/p2-baseline/stream.jsonl" > "$OUT/p2-baseline/result-event.json" 2>/dev/null

# ── P3: --resume startup latency × 3 ─────────────────────────────────────────
phase "P3: resume latency (3 turns)"
for n in 1 2 3; do
	exec_probe "p3-resume-$n" 120 bash -lc "$CLAUDE --max-turns 1 --resume $SID 'Reply with exactly: again $n'"
	NEW_SID=$(jq -r 'select(.type=="result") | .session_id // empty' "$OUT/p3-resume-$n/stream.jsonl" | tail -1)
	[ -n "$NEW_SID" ] && SID="$NEW_SID"   # some CLI versions fork a new id per resume — capture drift
done

# ── P4: cancellation mid tool call + zombie census ───────────────────────────
phase "P4: cancel mid tool call"
DIR="$OUT/p4-cancel"; mkdir -p "$DIR"
: > "$DIR/stream.jsonl"; : > "$DIR/times.tsv"; : > "$DIR/pgid"
T0=$(now_ms)
docker exec "$C" setsid bash -c 'echo "__S01_PGID__ $$"; exec "$@"' s01-exec \
	bash -lc "$CLAUDE --max-turns 4 --allowedTools Bash 'Run this exact bash command: sleep 120. After it finishes, reply done.'" \
	> "$DIR/rawpipe" 2>"$DIR/stderr.log" &
EXEC_PID=$!
# Tail the pipe file: capture pgid, wait for the Bash tool_use to appear.
PGID=""; SAW_TOOL=0
for _ in $(seq 1 240); do
	[ -z "$PGID" ] && PGID=$(awk '/^__S01_PGID__/ {print $2; exit}' "$DIR/rawpipe" 2>/dev/null)
	if grep -q '"tool_use"' "$DIR/rawpipe" 2>/dev/null && grep -q 'sleep 120' "$DIR/rawpipe" 2>/dev/null; then SAW_TOOL=1; break; fi
	sleep 0.5
done
grep -v '^__S01_PGID__' "$DIR/rawpipe" > "$DIR/stream.jsonl" 2>/dev/null || true
printf '%s' "$PGID" > "$DIR/pgid"
if [ "$SAW_TOOL" -eq 1 ] && [ -n "$PGID" ]; then
	ok "tool_use observed (pgid=$PGID); waiting 2s into the tool call, then killing the group"
	sleep 2
	zombie_census before-p4-kill
	T_KILL=$(now_ms)
	OUTCOME=$(kill_group "$PGID" 5000)
	echo "  kill outcome: $OUTCOME"
	wait "$EXEC_PID" 2>/dev/null; RC=$?
	T_END=$(now_ms)
	# Anything the CLI flushed after TERM landed in rawpipe — refresh the fixture.
	grep -v '^__S01_PGID__' "$DIR/rawpipe" > "$DIR/stream.jsonl" 2>/dev/null || true
	jq -n --argjson t0 "$T0" --argjson tKill "$T_KILL" --argjson tEnd "$T_END" \
		--argjson rc "$RC" --arg pgid "$PGID" --arg outcome "$OUTCOME" --arg cli "$CLI_VERSION" \
		'{t0_ms:$t0, t_kill_ms:$tKill, t_end_ms:$tEnd, exec_exit_code:$rc, pgid:$pgid, kill_outcome:$outcome, cli_version:$cli}' \
		> "$DIR/meta.json"
	zombie_census after-p4-kill
	SLEEPERS=$(docker exec "$C" bash -c 'for f in /proc/[0-9]*/cmdline; do tr "\0" " " < "$f" 2>/dev/null | grep -q "^sleep 120" && echo survived; done; true')
	[ -z "$SLEEPERS" ] && ok "sleep 120 did not survive the group kill" || fail "sleep 120 SURVIVED the group kill"
else
	fail "P4 never showed the Bash tool_use (pgid='$PGID') — inspect $DIR"
	[ -n "$PGID" ] && kill_group "$PGID" 3000 >/dev/null
	wait "$EXEC_PID" 2>/dev/null
fi
rm -f "$DIR/rawpipe"

# ── P5: tool_use shape for the activity view ─────────────────────────────────
phase "P5: tool_use event shape"
exec_probe p5-toolshape 180 bash -lc "$CLAUDE --max-turns 6 --allowedTools 'Write,Bash' 'Create a file named hello.txt containing exactly: hello from S-01. Then run: cat hello.txt'"
jq -c '.. | objects | select(.type? == "tool_use") | {name: .name, input: .input}' \
	"$OUT/p5-toolshape/stream.jsonl" > "$OUT/p5-toolshape/tool-use-extract.json" 2>/dev/null
echo "  tool_use blocks extracted: $(wc -l < "$OUT/p5-toolshape/tool-use-extract.json")"

# ── wrap-up ──────────────────────────────────────────────────────────────────
phase "summary"
zombie_census final
{
	echo "run: $STAMP"
	echo "image: $IMAGE"
	echo "cli: $CLI_VERSION"
	echo "auth: $AUTH_MODE"
	for d in "$OUT"/p*/; do
		name=$(basename "$d")
		[ -f "$d/meta.json" ] || continue
		jq -r --arg n "$name" '"\($n): rc=\(.exit_code // .exec_exit_code) t_first=\((.t_first_line_ms // 0) - .t0_ms)ms t_total=\(.t_end_ms - .t0_ms)ms"' "$d/meta.json"
	done
	echo "costs:"
	for d in "$OUT"/p*/; do
		jq -r --arg n "$(basename "$d")" 'select(.type=="result") | "\($n): cost=\(.total_cost_usd // .cost_usd // "?") turns=\(.num_turns // "?") session=\(.session_id // "?")"' "$d/stream.jsonl" 2>/dev/null
	done
} | tee "$OUT/summary.txt"

echo
if [ "$FAILS" -eq 0 ]; then echo "S-01 complete, 0 failures. Raw output: $OUT"; else echo "S-01 complete with $FAILS failure(s). Raw output: $OUT"; fi
echo "Next: ./sanitize.sh $OUT   (only sanitized fixtures may be committed)"
exit 0
