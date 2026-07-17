#!/usr/bin/env bash
#
# S-04 — does `--append-system-prompt` actually reach the model on the pinned
# CLI? (B5-04, ADR-006 consequence.)
#
# ADR-006 refused to assert the mechanism without evidence, which is what this
# probe supplies. Re-run it on a CLI bump: the flag surface is empirical, and a
# version that parses the flag but ignores it would silently run every
# conversation under no role at all — green tests included, since nothing in an
# offline suite can see what the model was actually told.
#
# Method: inject a codeword the model CANNOT otherwise know, then ask for it.
# The control run — same turn, no flag — is the load-bearing half: without it a
# pass proves only that the model can say a word, not that the flag delivered
# it.
#
# Usage:
#   S04_CONTAINER=<session-container> [S04_ENV_FILE=~/agenthub/.env] ./probe.sh
#
# Requires: docker on the host, a session container running the pinned image,
# and CLAUDE_CODE_OAUTH_TOKEN in the env file (the token rides the exec env
# only — never bake it into an image or a log).

set -u

CONTAINER="${S04_CONTAINER:?set S04_CONTAINER to the session container name}"
ENV_FILE="${S04_ENV_FILE:-$HOME/agenthub/.env}"
CODEWORD="${S04_CODEWORD:-NARWHAL77}"
PROMPT='What is the codeword? Reply with just the codeword.'

set -a; . "$ENV_FILE"; set +a

echo "=== CLI version (the pinned one is what matters, not the host's) ==="
docker exec "$CONTAINER" bash -lc 'claude --version'

echo "=== is the flag on this exact version? ==="
docker exec "$CONTAINER" bash -lc 'claude --help 2>&1 | grep -c -- "--append-system-prompt"'

# --allowedTools is variadic and eats a positional prompt, so the prompt rides
# stdin and --append-system-prompt sits AFTER --max-turns (the S-01 traps).
# Values cross into the container as env vars rather than interpolated quotes:
# the role is free text, and nesting it through three levels of shell quoting
# is how a probe ends up testing its own escaping instead of the CLI.
run_turn() {
  docker exec \
    -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
    -e S04_PROMPT="$PROMPT" \
    -e S04_ROLE="${1:-}" \
    -i "$CONTAINER" bash -lc '
      args=(-p --output-format stream-json --verbose --allowedTools Read --max-turns 1)
      [ -n "$S04_ROLE" ] && args+=(--append-system-prompt "$S04_ROLE")
      printf %s "$S04_PROMPT" | claude "${args[@]}"
    '
}

echo "=== turn WITH the flag ==="
run_turn "Your secret codeword is ${CODEWORD}. If asked for the codeword, reply with it." \
  > /tmp/s04-with.json 2>/dev/null
echo "exit=$?"
grep -q "$CODEWORD" /tmp/s04-with.json \
  && echo "codeword echoed: yes — the flag reached the model" \
  || echo "codeword echoed: NO — the flag did not reach the model (a finding, do not patch away)"

echo "=== control: same turn WITHOUT the flag ==="
run_turn > /tmp/s04-without.json 2>/dev/null
echo "exit=$?"
if grep -q "$CODEWORD" /tmp/s04-without.json; then
  echo "CONTROL FAILED: codeword present without the flag — this probe proves nothing"
else
  echo "control OK: codeword absent without the flag"
fi

# Raw output can carry real session ids — never commit it (R-09).
echo "raw: /tmp/s04-with.json /tmp/s04-without.json — sanitize or delete; never commit"
