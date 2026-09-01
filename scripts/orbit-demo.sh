#!/usr/bin/env bash
# Emit a synthetic multi-agent fleet for Orbit demos / screen recordings.
# Requires firehose on PATH (or builds via `go run ./cmd/firehose`).
set -euo pipefail

cd "$(dirname "$0")/.."

FIREHOSE="${FIREHOSE:-}"
if [ -z "$FIREHOSE" ]; then
  if command -v firehose >/dev/null 2>&1; then
    FIREHOSE=firehose
  else
    FIREHOSE="go run ./cmd/firehose"
  fi
fi

emit() {
  local source="$1"
  local payload="$2"
  printf '%s' "$payload" | $FIREHOSE emit --source "$source" >/dev/null
  sleep 0.15
}

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
S1="demo-claude-$(date +%s)"
S2="demo-codex-$(date +%s)"
S3="demo-blocked-$(date +%s)"

echo "orbit demo: emitting fleet ($S1, $S2, $S3)…"

# Working Claude session in repo alpha
emit claude-code "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$S1\",\"source\":\"startup\",\"cwd\":\"/demo/alpha\"}"
emit claude-code "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$S1\",\"cwd\":\"/demo/alpha\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/demo/alpha/main.go\"},\"tool_response\":{\"ok\":true}}"
emit claude-code "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$S1\",\"cwd\":\"/demo/alpha\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"go test ./...\"},\"tool_response\":{\"stdout\":\"ok\"}}"

# Second session (codex-shaped via generic envelope ingest would need adapter;
# use claude-code with different cwd/repo markers — emit still tags source).
# Prefer direct NDJSON ingest for a second family:
$FIREHOSE ingest <<EOF
{"id":"demo-c1","time":"$NOW","source":"codex","agent":"codex","session_id":"$S2","category":"prompt","summary":"refactor the auth module","cwd":"/demo/beta","repo":"beta"}
{"id":"demo-c2","time":"$NOW","source":"codex","agent":"codex","session_id":"$S2","category":"tool","summary":"ran apply_patch","cwd":"/demo/beta","repo":"beta"}
EOF

# Blocked Claude — needs permission (the attention signal)
emit claude-code "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$S3\",\"source\":\"startup\",\"cwd\":\"/demo/alpha\"}"
emit claude-code "{\"hook_event_name\":\"Notification\",\"session_id\":\"$S3\",\"cwd\":\"/demo/alpha\",\"message\":\"Claude needs your permission to use Bash\"}"

# Quiet tool on S2 then stop on a fourth finished session
S4="demo-done-$(date +%s)"
emit claude-code "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$S4\",\"source\":\"startup\",\"cwd\":\"/demo/gamma\"}"
emit claude-code "{\"hook_event_name\":\"Stop\",\"session_id\":\"$S4\"}"

echo "done. Open the Orbit panel — $S3 should be amber near center (NEEDS YOU)."
echo "  sessions: working=$S1  codex=$S2  blocked=$S3  done=$S4"

# Optional steady-work loop. Without it every session goes quiet and the
# projection turns the whole fleet idle after IdleAfter (90s), which is not what
# a screen recording wants. ORBIT_DEMO_LOOP=1 keeps $S1 visibly working while
# $S3 stays blocked and drifts inward. Ctrl-C to stop.
if [ "${ORBIT_DEMO_LOOP:-0}" = "1" ]; then
  echo "looping steady work on $S1 (ORBIT_DEMO_LOOP=1) — Ctrl-C to stop…"
  while true; do
    emit claude-code "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$S1\",\"cwd\":\"/demo/alpha\",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"/demo/alpha/main.go\"},\"tool_response\":{\"ok\":true}}"
    sleep 2
  done
fi
