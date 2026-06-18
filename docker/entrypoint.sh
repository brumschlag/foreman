#!/usr/bin/env bash
# docker-entrypoint.sh — Run the Foreman no-pr pipeline inside the container.
#
# Environment variables (required):
#   TASK_TITLE          — Short title for the task (required)
#   OPENROUTER_API_KEY  — API key forwarded to the model provider (required)
#
# Environment variables (optional):
#   TASK_DESCRIPTION    — Longer task description (default: empty)
#   WORKFLOW            — Workflow name or path (default: no-pr)
#   BASE_BRANCH         — Branch to create the worktree from (default: feature/darkfactory)
#   MODEL               — Model override (default: workflow default)
#
# Volume mounts (required):
#   /repo    — The repository to work on (mounted read-write)
#   /output  — Where CHANGES.patch will be written on success

set -euo pipefail

# ── Validate required env vars ──────────────────────────────────────────────
if [[ -z "${TASK_TITLE:-}" ]]; then
  echo "[entrypoint] ERROR: TASK_TITLE is required" >&2
  exit 1
fi
if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "[entrypoint] ERROR: OPENROUTER_API_KEY is required" >&2
  exit 1
fi

WORKFLOW="${WORKFLOW:-no-pr}"
BASE_BRANCH="${BASE_BRANCH:-feature/darkfactory}"
TASK_DESCRIPTION="${TASK_DESCRIPTION:-}"
MODEL="${MODEL:-}"

echo "[entrypoint] Starting Foreman pipeline"
echo "[entrypoint]   Task:     ${TASK_TITLE}"
echo "[entrypoint]   Workflow: ${WORKFLOW}"
echo "[entrypoint]   Branch:   ${BASE_BRANCH}"

# ── Verify mounts ────────────────────────────────────────────────────────────
if [[ ! -d /repo/.git ]]; then
  echo "[entrypoint] ERROR: /repo does not appear to be a git repository (.git missing)" >&2
  exit 1
fi
if [[ ! -d /output ]]; then
  echo "[entrypoint] ERROR: /output directory is not mounted" >&2
  exit 1
fi

# ── Start PostgreSQL ─────────────────────────────────────────────────────────
echo "[entrypoint] Starting PostgreSQL..."
PG_BIN=$(find /usr/lib/postgresql -name "pg_ctl" 2>/dev/null | head -1)
PG_DATA="/var/lib/postgresql/data"

gosu postgres "$PG_BIN" start -D "$PG_DATA" -l /tmp/postgres.log -w -t 30 || {
  echo "[entrypoint] ERROR: PostgreSQL failed to start" >&2
  cat /tmp/postgres.log >&2
  exit 1
}

gosu postgres createdb foreman 2>/dev/null || true
echo "[entrypoint] PostgreSQL ready."

# ── Export API keys ───────────────────────────────────────────────────────────
export OPENROUTER_API_KEY
export DATABASE_URL="postgresql://postgres:***@localhost:5432/foreman"
# Set default model for all pipeline phases
export FOREMAN_DEFAULT_MODEL="${MODEL:-openrouter/qwen/qwen3-coder-next}"
# Set up pi-sdk: copy auth from read-only mount to writable location
PI_AGENT_DIR="${HOME}/.pi-agent"
mkdir -p "${PI_AGENT_DIR}/sessions"
if [[ -f "${HOME}/.pi/agent/auth.json" ]]; then
  cp "${HOME}/.pi/agent/auth.json" "${PI_AGENT_DIR}/auth.json"
fi
export PI_CODING_AGENT_DIR="${PI_AGENT_DIR}"

# ── Install bundled workflows ─────────────────────────────────────────────────
FOREMAN_WORKFLOWS_DIR="${HOME}/.foreman/workflows"
mkdir -p "${FOREMAN_WORKFLOWS_DIR}"
cp /app/docker/no-pr.yaml "${FOREMAN_WORKFLOWS_DIR}/no-pr.yaml"
node /app/docker/install-workflows.mjs 2>&1 || true

# ── Run DB migrations ─────────────────────────────────────────────────────────
echo "[entrypoint] Running database migrations..."
cd /app
node scripts/run-pg-migrate.mjs -m dist/lib/db/migrations/ up 2>&1 || {
  echo "[entrypoint] ERROR: migrations failed" >&2
  exit 1
}
cd /

# ── Init foreman schema and project ───────────────────────────────────────────
echo "[entrypoint] Setting up Foreman schema and project..."
TASK_ID=$(node /app/docker/bootstrap.mjs /repo "${TASK_TITLE}" "${TASK_DESCRIPTION}")
if [[ -z "${TASK_ID}" ]]; then
  echo "[entrypoint] ERROR: bootstrap failed to produce a task ID" >&2
  exit 1
fi
echo "[entrypoint] Task ID: ${TASK_ID}"

# ── Run the pipeline ──────────────────────────────────────────────────────────
CMD_ARGS=(run task "${TASK_ID}" "${WORKFLOW}" --project-path /repo --no-watch --target-branch "${BASE_BRANCH}")

echo "[entrypoint] Spawning worker: foreman ${CMD_ARGS[*]}"
cd /repo
foreman "${CMD_ARGS[@]}" &
FOREMAN_PID=$!
cd /
# Give the worker time to actually spawn, then we poll independently
sleep 5

# ── Poll for completion ───────────────────────────────────────────────────────
echo "[entrypoint] Polling for pipeline completion (max 60 min)..."
POLL_INTERVAL=15
MAX_POLLS=240
STATUS="unknown"

for i in $(seq 1 "${MAX_POLLS}"); do
  STATUS=$(node /app/docker/poll-run.mjs /repo "${TASK_ID}" 2>/dev/null || echo "unknown")

  # Also check if CHANGES.patch exists — command phases don't update run status
  PATCH_FILE=$(find "${HOME}/.foreman/reports" -name "CHANGES.patch" -newer /proc/1 2>/dev/null | head -1 || true)

  echo "[entrypoint] [${i}/${MAX_POLLS}] status: ${STATUS}${PATCH_FILE:+ (patch found)}"

  if [[ -n "${PATCH_FILE}" && -f "${PATCH_FILE}" ]]; then
    echo "[entrypoint] Patch file found — pipeline complete."
    break
  fi

  case "${STATUS}" in
    completed|merged)
      echo "[entrypoint] Pipeline completed."
      break
      ;;
    failed|stuck|conflict|test-failed)
      # Check once more for patch — command phases can fail status but still produce output
      PATCH_FILE=$(find "${HOME}/.foreman/reports" -name "CHANGES.patch" 2>/dev/null | head -1 || true)
      if [[ -n "${PATCH_FILE}" && -f "${PATCH_FILE}" ]]; then
        echo "[entrypoint] Patch file found despite failure status — proceeding."
        break
      fi
      echo "[entrypoint] ERROR: Pipeline ended with status '${STATUS}'" >&2
      LAST_LOG=$(ls -t "${HOME}/.foreman/logs"/*.err 2>/dev/null | head -1 || true)
      if [[ -n "${LAST_LOG}" ]]; then
        tail -30 "${LAST_LOG}" >&2
      fi
      exit 1
      ;;
    *)
      sleep "${POLL_INTERVAL}"
      ;;
  esac
done

if [[ "${STATUS}" != "completed" && "${STATUS}" != "merged" && ( -z "${PATCH_FILE}" || ! -f "${PATCH_FILE}" ) ]]; then
  echo "[entrypoint] ERROR: Pipeline timed out" >&2
  exit 1
fi

# ── Copy patch to /output ─────────────────────────────────────────────────────
echo "[entrypoint] Locating CHANGES.patch..."
PATCH_FILE=$(node /app/docker/find-patch.mjs /repo "${TASK_ID}" 2>/dev/null || true)

if [[ -z "${PATCH_FILE}" || ! -f "${PATCH_FILE}" ]]; then
  PATCH_FILE=$(find "${HOME}/.foreman/reports" -name "CHANGES.patch" 2>/dev/null | head -1 || true)
fi

if [[ -z "${PATCH_FILE}" || ! -f "${PATCH_FILE}" ]]; then
  echo "[entrypoint] WARNING: CHANGES.patch not found" >&2
  touch /output/CHANGES.patch
  exit 0
fi

cp "${PATCH_FILE}" /output/CHANGES.patch
echo "[entrypoint] Wrote /output/CHANGES.patch ($(wc -c < "${PATCH_FILE}") bytes)"
exit 0
