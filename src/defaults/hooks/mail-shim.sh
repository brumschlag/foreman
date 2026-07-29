#!/bin/sh
# Foreman Agent Mail shim for a kelos agent pod.
#
# On the Pi path mail is three in-process tool closures over a live
# AgentMailClient. A kelos agent is a separate program in a separate pod, so the
# closures cannot reach it. This script is the pod-side interception point for
# the same server-side authority, exactly as the tool-policy hook is for the
# policy gate: the mail store does not move, only the way the agent reaches it.
#
# Unlike the policy hook, this is NOT a safety gate. A gate must fail closed; a
# mail read that cannot reach the server must fail OPEN-ish — report the failure
# on stderr and exit non-zero, so the agent learns it has no mail channel rather
# than being blocked from working. Losing steering is bad; wedging the phase
# because steering is unavailable is worse.
#
# usage : mail-shim.sh read
#         mail-shim.sh send <to> <subject> <body>
#         mail-shim.sh ack <message-id>
# stdout: for `read`, the formatted messages (empty when the inbox is empty)
# stderr: diagnostics
# exit 0: the operation reached the server
# exit 1: misuse or the server could not be reached
#
# Configuration (from the pod environment):
#   FOREMAN_SERVER_URL         base URL of the Foreman server (required)
#   FOREMAN_WORKER_EVENT_TOKEN bearer token (falls back to FOREMAN_SERVER_AUTH_TOKEN)
#   FOREMAN_MAIL_TIMEOUT       per-call timeout in seconds (default 10)
#   FOREMAN_RUN_ID / FOREMAN_TASK_ID / FOREMAN_PHASE_ID  correlation ids
#   FOREMAN_AGENT_NAME         inbox owner; defaults to FOREMAN_PHASE_ID

set -u

fail() {
  echo "Foreman mail: $1" >&2
  exit 1
}

SERVER="${FOREMAN_SERVER_URL:-}"
[ -n "$SERVER" ] || fail "no FOREMAN_SERVER_URL configured, so mail is unavailable"

TOKEN="${FOREMAN_WORKER_EVENT_TOKEN:-${FOREMAN_SERVER_AUTH_TOKEN:-}}"
TIMEOUT="${FOREMAN_MAIL_TIMEOUT:-10}"
RUN_ID="${FOREMAN_RUN_ID:-}"
PHASE_ID="${FOREMAN_PHASE_ID:-}"
AGENT="${FOREMAN_AGENT_NAME:-$PHASE_ID}"

[ -n "$RUN_ID" ] || fail "no FOREMAN_RUN_ID configured, so mail cannot be correlated to a run"

# python3 is present in the reference agent images and is how the policy hook
# already builds its request bodies. Without it there is no mail channel.
command -v python3 >/dev/null 2>&1 || fail "python3 unavailable, so mail cannot be encoded"

# Wraps curl so every call carries auth, a bounded timeout, and -f (an error
# status is a failure rather than a body printed as if it were data).
call() {
  _method="$1"
  _path="$2"
  _body="${3:-}"

  if [ -n "$_body" ]; then
    printf '%s' "$_body" | curl -sS -f --max-time "$TIMEOUT" \
      -X "$_method" "$SERVER$_path" \
      -H 'content-type: application/json' \
      ${TOKEN:+-H "authorization: Bearer $TOKEN"} \
      --data-binary @- 2>/dev/null
  else
    curl -sS -f --max-time "$TIMEOUT" \
      -X "$_method" "$SERVER$_path" \
      ${TOKEN:+-H "authorization: Bearer $TOKEN"} 2>/dev/null
  fi
}

# Builds a JSON object from KEY=VALUE pairs passed on stdin, one per line, so no
# caller has to hand-escape a body containing quotes or newlines.
encode() {
  python3 -c '
import json, sys
out = {}
for line in sys.stdin.read().split("\x00"):
    if not line:
        continue
    key, _, value = line.partition("=")
    out[key] = value
json.dump(out, sys.stdout)
'
}

case "${1:-}" in
  read)
    RESPONSE=$(call GET "/worker/v1/mail?run_id=$RUN_ID&agent=$AGENT&unread=true") ||
      fail "mail endpoint unavailable at $SERVER"

    # One parse: messages render to stdout for the agent, ids go to a temp file
    # for the acknowledge pass. Reading twice risked the two passes disagreeing.
    IDFILE=$(mktemp)
    trap 'rm -f "$IDFILE"' EXIT

    printf '%s' "$RESPONSE" | ID_FILE="$IDFILE" python3 -c '
import json, os, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("Could not read mail (unparseable server response).")
    raise SystemExit(0)
messages = d.get("mail") or []
if not messages:
    print("No new mail.")
ids = []
for m in messages:
    mid = m.get("message_id") or m.get("id") or ""
    if mid:
        ids.append(str(mid))
    print("--- message %s" % (mid or "?"))
    print("from: %s" % (m.get("from") or m.get("sender_agent_type") or "?"))
    print("subject: %s" % (m.get("subject") or ""))
    print(m.get("body") or "")
    print()
with open(os.environ["ID_FILE"], "w") as fh:
    fh.write("\n".join(ids))
'

    # Acknowledge what was just shown, so the next read does not re-deliver it
    # and leave the agent looping on stale steering. Non-fatal: the agent has
    # already seen the content, and a redelivery beats a lost read.
    #
    # The ids are read into a variable rather than piped into a `while read`
    # loop: curl inside the loop body inherits the loop's stdin and consumes the
    # remaining ids, so only the first message ever got acknowledged.
    IDS=$(cat "$IDFILE")
    for id in $IDS; do
      [ -n "$id" ] || continue
      body=$(printf 'message_id=%s\000run_id=%s\000delivery_status=delivered' "$id" "$RUN_ID" | encode)
      call POST "/worker/v1/mail/ack" "$body" >/dev/null 2>&1 ||
        echo "Foreman mail: ack failed for $id (non-fatal)" >&2
    done
    ;;

  send)
    [ $# -ge 4 ] || fail "usage: mail-shim.sh send <to> <subject> <body>"
    TO="$2"
    SUBJECT="$3"
    shift 3
    BODY="$*"

    payload=$(printf 'run_id=%s\000phase_id=%s\000from=%s\000to=%s\000subject=%s\000body=%s' \
      "$RUN_ID" "$PHASE_ID" "$AGENT" "$TO" "$SUBJECT" "$BODY" | encode)

    call POST "/worker/v1/mail/send" "$payload" >/dev/null ||
      fail "mail send failed; the server could not be reached at $SERVER"
    echo "Sent to $TO: $SUBJECT"
    ;;

  ack)
    [ $# -ge 2 ] || fail "usage: mail-shim.sh ack <message-id>"
    payload=$(printf 'message_id=%s\000run_id=%s\000delivery_status=delivered' "$2" "$RUN_ID" | encode)
    call POST "/worker/v1/mail/ack" "$payload" >/dev/null ||
      fail "mail ack failed; the server could not be reached at $SERVER"
    echo "Acknowledged $2"
    ;;

  *)
    fail "usage: mail-shim.sh {read|send <to> <subject> <body>|ack <message-id>}"
    ;;
esac
