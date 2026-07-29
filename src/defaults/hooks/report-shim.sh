#!/bin/sh
# Foreman phase-report upload, called by a kelos agent inside its pod.
#
# A kelos phase returns its work as a git patch of the REPOSITORY, so a report
# written to Foreman's reports directory never travels — that path does not exist
# in the pod. This posts the report to the server, which writes it where the
# artifact gate looks.
#
# Usage: report-shim.sh <FILE_NAME> [path-to-content-file]
#        cat report.md | report-shim.sh DOCUMENTATION_REPORT.md
#
# Unlike the tool-policy hook this is not a safety gate, so it reports failure
# loudly but does not pretend to succeed: the phase's artifact gate is what
# ultimately decides, and a silent success here would look like a written report.
#
# Configuration (from the pod environment):
#   FOREMAN_SERVER_URL         base URL of the Foreman server (required)
#   FOREMAN_SERVER_AUTH_TOKEN  bearer token (optional)
#   FOREMAN_PROJECT_ID / FOREMAN_TASK_ID / FOREMAN_RUN_ID  required by the server
#   FOREMAN_REPORT_TIMEOUT     per-call timeout in seconds (default 20)

set -u

fail() {
  echo "foreman report upload failed: $1" >&2
  exit 1
}

FILE_NAME="${1:-}"
[ -n "$FILE_NAME" ] || fail "usage: report-shim.sh <FILE_NAME> [content-file]"

SERVER="${FOREMAN_SERVER_URL:-}"
[ -n "$SERVER" ] || fail "no FOREMAN_SERVER_URL configured"

TIMEOUT="${FOREMAN_REPORT_TIMEOUT:-20}"

if [ -n "${2:-}" ]; then
  [ -f "$2" ] || fail "content file not found: $2"
  CONTENT_FILE="$2"
else
  CONTENT_FILE=$(mktemp)
  cat > "$CONTENT_FILE"
fi

command -v python3 >/dev/null 2>&1 || fail "python3 unavailable"

# Built with python3 so the report body is JSON-encoded rather than shell-escaped:
# reports contain quotes, newlines, and backticks.
REQUEST=$(FOREMAN_REPORT_FILE="$CONTENT_FILE" FOREMAN_REPORT_NAME="$FILE_NAME" python3 -c '
import json, os, sys
with open(os.environ["FOREMAN_REPORT_FILE"], encoding="utf-8") as handle:
    content = handle.read()
json.dump({
    "project_id": os.environ.get("FOREMAN_PROJECT_ID", ""),
    "task_id": os.environ.get("FOREMAN_TASK_ID", ""),
    "run_id": os.environ.get("FOREMAN_RUN_ID", ""),
    "phase_id": os.environ.get("FOREMAN_PHASE_ID", ""),
    "file_name": os.environ["FOREMAN_REPORT_NAME"],
    "content": content,
}, sys.stdout)
') || fail "could not encode the report"

printf '%s' "$REQUEST" | curl -sS -f --max-time "$TIMEOUT" \
  -X POST "$SERVER/worker/v1/reports" \
  -H 'content-type: application/json' \
  ${FOREMAN_SERVER_AUTH_TOKEN:+-H "authorization: Bearer $FOREMAN_SERVER_AUTH_TOKEN"} \
  --data-binary @- >/dev/null || fail "server rejected the upload"

echo "uploaded $FILE_NAME"
