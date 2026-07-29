#!/bin/sh
# Foreman tool-policy gate, run as a Claude Code PreToolUse hook.
#
# Claude Code hooks fail OPEN: every exit code except 2 lets the tool run, and that
# includes a crash, a timeout, an unreachable endpoint, and a response this script
# cannot parse. A safety gate has to invert that, so every path here that does not
# receive an explicit allow exits 2.
#
# stdin  : PreToolUse hook JSON (tool_use_id, tool_name, tool_input, session_id)
# stderr : shown to the model when the call is blocked
# exit 0 : allowed
# exit 2 : blocked
#
# Configuration (from the pod environment):
#   FOREMAN_SERVER_URL         base URL of the Foreman server (required)
#   FOREMAN_WORKER_EVENT_TOKEN bearer token (falls back to FOREMAN_SERVER_AUTH_TOKEN)
#   FOREMAN_POLICY_TIMEOUT     per-call timeout in seconds (default 5)
#   FOREMAN_RUN_ID / FOREMAN_TASK_ID / FOREMAN_PHASE_ID  correlation ids

set -u

deny() {
  echo "Foreman tool policy: $1" >&2
  exit 2
}

INPUT=$(cat)

SERVER="${FOREMAN_SERVER_URL:-}"
[ -n "$SERVER" ] || deny "no FOREMAN_SERVER_URL configured, so the policy could not be consulted"

TOKEN="${FOREMAN_WORKER_EVENT_TOKEN:-${FOREMAN_SERVER_AUTH_TOKEN:-}}"
TIMEOUT="${FOREMAN_POLICY_TIMEOUT:-5}"

# Build the request from the hook payload. python3 is present in the reference agent
# images; without it the policy cannot be consulted, so that also denies.
command -v python3 >/dev/null 2>&1 || deny "python3 unavailable, so the policy could not be consulted"

REQUEST=$(printf '%s' "$INPUT" | python3 -c '
import json, os, sys
try:
    h = json.load(sys.stdin)
except Exception:
    sys.exit(1)
json.dump({
    "run_id": os.environ.get("FOREMAN_RUN_ID", ""),
    "task_id": os.environ.get("FOREMAN_TASK_ID", ""),
    "phase_id": os.environ.get("FOREMAN_PHASE_ID", ""),
    "worker_id": "kelos-pretooluse:" + h.get("session_id", ""),
    "sequence": 0,
    "tool_call_id": h.get("tool_use_id", ""),
    "tool_name": h.get("tool_name", ""),
    "args": h.get("tool_input", {}),
}, sys.stdout)
') || deny "hook input could not be parsed"

# -f makes an error status a failure; --max-time bounds the stall this adds to every
# tool call. Any curl failure falls through to deny.
RESPONSE=$(
  printf '%s' "$REQUEST" | curl -sS -f --max-time "$TIMEOUT" \
    -X POST "$SERVER/worker/v1/tool-policy" \
    -H 'content-type: application/json' \
    ${TOKEN:+-H "authorization: Bearer $TOKEN"} \
    --data-binary @- 2>/dev/null
) || deny "policy endpoint unavailable at $SERVER"

# Only an explicit allow permits the call. An unparseable or unexpected body denies.
VERDICT=$(printf '%s' "$RESPONSE" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("DENY unparseable policy response"); raise SystemExit
decision = d.get("decision")
if not isinstance(decision, dict) or "allowed" not in decision:
    print("DENY policy response contained no decision"); raise SystemExit
if decision.get("allowed") is True:
    print("ALLOW")
else:
    reason = decision.get("reason") or decision.get("action") or "denied by policy"
    print("DENY " + str(reason))
') || deny "policy response could not be evaluated"

case "$VERDICT" in
  ALLOW) exit 0 ;;
  "DENY "*) deny "${VERDICT#DENY }" ;;
  *) deny "unexpected policy verdict" ;;
esac
