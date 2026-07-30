#!/bin/sh
# Foreman report-write interception, run as a Claude Code PreToolUse hook.
#
# The report shim (report-shim.sh) is invoked as a SHELL command, so any phase
# denied the Bash tool cannot call it. The explorer is exactly that phase:
# foreman_server's overwatch denies it bash/find/ls ("explorer must use
# Grep/Glob/Read discovery"), so no prompt wording can make it upload a report —
# it writes EXPLORER_REPORT.md with the Write tool instead and hits EACCES,
# because Foreman's reports directory does not exist in the pod.
#
# This hook removes the agent's discretion. It intercepts a Write/Edit aimed at
# the reports directory, uploads the content itself with curl (a hook subprocess,
# not the Bash TOOL, so the tool policy does not apply), and then DENIES the
# write that would have failed anyway.
#
# Deny is the honest verdict: the file never lands in the pod, so reporting
# "allow" would leave the agent believing a local file exists. The reason string
# tells it the upload already happened so it does not retry or report blocked.
#
# stdin  : PreToolUse hook JSON (tool_name, tool_input, session_id)
# stdout : PreToolUse JSON decision (deny on intercept, nothing otherwise)
# exit 0 : always — a non-report write must fall through to the other hooks
#          untouched, and exit 0 WITHOUT JSON is "no decision", not an allow.
#
# Configuration (from the pod environment):
#   FOREMAN_SERVER_URL         base URL of the Foreman server (required)
#   FOREMAN_SERVER_AUTH_TOKEN  bearer token (optional)
#   FOREMAN_PROJECT_ID / FOREMAN_TASK_ID / FOREMAN_RUN_ID / FOREMAN_PHASE_ID
#   FOREMAN_REPORT_TIMEOUT     per-call timeout in seconds (default 20)

set -u

INPUT=$(cat)

# No decision: stay silent and exit 0 so the tool-policy hook still rules on the
# call. Printing an "allow" here would override that gate.
passthrough() {
  exit 0
}

# A PreToolUse decision. permissionDecisionReason is what the model actually
# reads, so it has to say whether the report is safe or still missing.
decide() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}\n' "$1"
  exit 0
}

command -v python3 >/dev/null 2>&1 || passthrough

# Pull the target path and the content out of the hook payload. Write uses
# `content`, Edit uses `new_string`; a report write is a whole-file write, so an
# Edit against the reports dir is still a full report body.
PARSED=$(printf '%s' "$INPUT" | python3 -c '
import json, os, sys
try:
    h = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
tool = (h.get("tool_name") or "").lower()
if tool not in ("write", "edit", "notebookwrite"):
    raise SystemExit(3)
args = h.get("tool_input") or {}
path = args.get("file_path") or args.get("path") or args.get("filePath") or ""
if not isinstance(path, str) or not path:
    raise SystemExit(3)
name = os.path.basename(path)
# Match on the reports LOCATION, not on the file name: a phase artifact can be
# any name the workflow declares (REVIEW.md, PR_METADATA.json), and matching
# *_REPORT.md would silently miss those. A repo-relative write is the agent
# working in its worktree and must not be intercepted.
norm = path.replace("\\", "/")
if "/.foreman/reports/" not in norm and "/foreman/reports/" not in norm:
    raise SystemExit(3)
content = args.get("content")
if content is None:
    content = args.get("new_string")
if content is None:
    content = args.get("new_str")
if not isinstance(content, str) or content == "":
    raise SystemExit(4)
sys.stdout.write(json.dumps({"name": name, "content": content}))
')
STATUS=$?

# 3 = not a report write (the common case). 4 = a report write we could not read
# a body from; denying with no upload would strand the phase, so let it through
# and let the artifact gate decide.
[ "$STATUS" -eq 0 ] || passthrough

FILE_NAME=$(printf '%s' "$PARSED" | python3 -c 'import json,sys; sys.stdout.write(json.loads(sys.stdin.read())["name"])') || passthrough

SERVER="${FOREMAN_SERVER_URL:-}"
if [ -z "$SERVER" ]; then
  decide '"Foreman reports directory is not writable in this pod and no FOREMAN_SERVER_URL is configured, so the report cannot be uploaded. Report this phase as blocked rather than retrying the write."'
fi

TIMEOUT="${FOREMAN_REPORT_TIMEOUT:-20}"

# Reuse the report endpoint the shim posts to, so both routes land in the same
# place and the server keeps deciding where a report belongs.
REQUEST=$(printf '%s' "$PARSED" | python3 -c '
import json, os, sys
parsed = json.loads(sys.stdin.read())
json.dump({
    "project_id": os.environ.get("FOREMAN_PROJECT_ID", ""),
    "task_id": os.environ.get("FOREMAN_TASK_ID", ""),
    "run_id": os.environ.get("FOREMAN_RUN_ID", ""),
    "phase_id": os.environ.get("FOREMAN_PHASE_ID", ""),
    "file_name": parsed["name"],
    "content": parsed["content"],
}, sys.stdout)
') || decide '"The report could not be encoded for upload, and this pod cannot write Foreman'"'"'s reports directory. Report this phase as blocked."'

if printf '%s' "$REQUEST" | curl -sS -f --max-time "$TIMEOUT" \
  -X POST "$SERVER/worker/v1/reports" \
  -H 'content-type: application/json' \
  ${FOREMAN_SERVER_AUTH_TOKEN:+-H "authorization: Bearer $FOREMAN_SERVER_AUTH_TOKEN"} \
  --data-binary @- >/dev/null 2>&1; then
  decide "\"Foreman uploaded $FILE_NAME for you. The reports directory does not exist in this pod, so the write itself was skipped — this is expected and is NOT a failure. Your report is saved: do not retry the write, do not write it elsewhere, and do not report this phase as blocked.\""
fi

decide "\"The upload of $FILE_NAME to Foreman FAILED, and this pod cannot write the reports directory, so the report is not saved. Say so explicitly in your final message rather than reporting this phase as complete.\""
