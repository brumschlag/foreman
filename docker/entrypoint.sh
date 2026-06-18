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
#
# Exit codes:
#   0  — Pipeline completed; CHANGES.patch written to /output
#   1  — Pipeline failed or required variable missing

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

# ── Verify /repo is a git repository ────────────────────────────────────────
if [[ ! -d /repo/.git ]]; then
  echo "[entrypoint] ERROR: /repo does not appear to be a git repository (.git missing)" >&2
  exit 1
fi
if [[ ! -d /output ]]; then
  echo "[entrypoint] ERROR: /output directory is not mounted" >&2
  exit 1
fi

# ── Export API key for the model provider ───────────────────────────────────
export OPENROUTER_API_KEY

# ── Install bundled workflows into ~/.foreman/workflows/ ────────────────────
# The no-pr workflow is bundled in the image at /app/docker/no-pr.yaml.
# Copy it to the search path so `foreman run task` can resolve it by name.
FOREMAN_WORKFLOWS_DIR="${HOME}/.foreman/workflows"
mkdir -p "${FOREMAN_WORKFLOWS_DIR}"
if [[ ! -f "${FOREMAN_WORKFLOWS_DIR}/no-pr.yaml" ]]; then
  cp /app/docker/no-pr.yaml "${FOREMAN_WORKFLOWS_DIR}/no-pr.yaml"
  echo "[entrypoint] Installed no-pr workflow to ${FOREMAN_WORKFLOWS_DIR}/"
fi

# Also install the bundled default workflows (explorer.md prompts etc rely on
# these being present even if we don't run them directly).
node /app/docker/install-workflows.mjs 2>&1 || true

# ── Create task in local SQLite store ───────────────────────────────────────
echo "[entrypoint] Creating task in local store..."
TASK_ID=$(node /app/docker/bootstrap.mjs /repo "${TASK_TITLE}" "${TASK_DESCRIPTION}")
if [[ -z "${TASK_ID}" ]]; then
  echo "[entrypoint] ERROR: bootstrap.mjs returned an empty task ID" >&2
  exit 1
fi
echo "[entrypoint] Task ID: ${TASK_ID}"

# ── Build the run-task command ───────────────────────────────────────────────
CMD_ARGS=(
  run task
  "${TASK_ID}"
  "${WORKFLOW}"
  --project-path /repo
  --no-watch
  --target-branch "${BASE_BRANCH}"
)
if [[ -n "${MODEL}" ]]; then
  CMD_ARGS+=(--model "${MODEL}")
fi

echo "[entrypoint] Spawning worker: foreman ${CMD_ARGS[*]}"
foreman "${CMD_ARGS[@]}" || {
  echo "[entrypoint] ERROR: foreman run task exited with non-zero status" >&2
  exit 1
}

# ── Poll for pipeline completion ─────────────────────────────────────────────
# The worker is a detached child process; foreman run task --no-watch exits
# immediately after spawning it.  We poll the local SQLite store for the run
# status until it reaches a terminal state.
echo "[entrypoint] Polling for pipeline completion (max 60 min)..."
POLL_INTERVAL=15
MAX_POLLS=240  # 240 × 15s = 60 min

for i in $(seq 1 "${MAX_POLLS}"); do
  STATUS=$(node /app/docker/poll-run.mjs /repo "${TASK_ID}" 2>/dev/null || echo "unknown")
  echo "[entrypoint] [${i}/${MAX_POLLS}] run status: ${STATUS}"

  case "${STATUS}" in
    completed|merged)
      echo "[entrypoint] Pipeline completed successfully."
      break
      ;;
    failed|stuck|conflict|test-failed)
      echo "[entrypoint] ERROR: Pipeline ended with status '${STATUS}'" >&2
      # Print the last few lines of the run log if available
      LOG_DIR="${HOME}/.foreman/logs"
      LAST_LOG=$(ls -t "${LOG_DIR}"/*.err 2>/dev/null | head -1 || true)
      if [[ -n "${LAST_LOG}" ]]; then
        echo "[entrypoint] Last 30 lines of ${LAST_LOG}:" >&2
        tail -30 "${LAST_LOG}" >&2
      fi
      exit 1
      ;;
    *)
      # Still running / pending / unknown — keep polling
      sleep "${POLL_INTERVAL}"
      ;;
  esac
done

# If we exhausted the poll loop without breaking, the run timed out.
if [[ "${STATUS}" != "completed" && "${STATUS}" != "merged" ]]; then
  echo "[entrypoint] ERROR: Pipeline timed out after $((MAX_POLLS * POLL_INTERVAL)) seconds" >&2
  exit 1
fi

# ── Locate CHANGES.patch and copy to /output ─────────────────────────────────
echo "[entrypoint] Locating CHANGES.patch..."
PATCH_FILE=$(node /app/docker/find-patch.mjs /repo "${TASK_ID}" 2>/dev/null || echo "")

if [[ -z "${PATCH_FILE}" || ! -f "${PATCH_FILE}" ]]; then
  # Fallback: search the reports directory tree directly
  PATCH_FILE=$(find "${HOME}/.foreman/reports" -name "CHANGES.patch" -newer /proc/1 2>/dev/null | head -1 || true)
fi

if [[ -z "${PATCH_FILE}" || ! -f "${PATCH_FILE}" ]]; then
  echo "[entrypoint] WARNING: CHANGES.patch not found — the pipeline may have produced no changes" >&2
  # Write an empty patch so /output always has a file
  touch /output/CHANGES.patch
  echo "[entrypoint] Wrote empty /output/CHANGES.patch"
  exit 0
fi

cp "${PATCH_FILE}" /output/CHANGES.patch
echo "[entrypoint] Wrote /output/CHANGES.patch ($(wc -c < "${PATCH_FILE}") bytes)"
exit 0
