# foreman-pipeline

Runs Foreman's `no-pr` workflow against a mounted repository. The pipeline
executes Explorer → Developer ⇄ QA → Reviewer → Validate → Export-Patch
and writes a `CHANGES.patch` to the output volume.

No GitHub account, Postgres, or PR is required — the patch is produced
entirely locally and can be inspected or applied manually.

## Build

```
docker build -f docker/pipeline.Dockerfile -t foreman-pipeline .
```

## Run

```
docker run --rm \
  -v /path/to/your/repo:/repo \
  -v /path/to/output:/output \
  -e TASK_TITLE="Add dark mode toggle" \
  -e TASK_DESCRIPTION="Add a dark/light mode toggle to the settings page." \
  -e OPENROUTER_API_KEY="sk-or-..." \
  foreman-pipeline
```

On success, `/path/to/output/CHANGES.patch` contains the diff. Apply it:

```
cd /path/to/your/repo
git apply /path/to/output/CHANGES.patch
```

## Environment variables

| Variable             | Required | Default               | Description                        |
|----------------------|----------|-----------------------|------------------------------------|
| `TASK_TITLE`         | yes      | —                     | Short title for the task           |
| `OPENROUTER_API_KEY` | yes      | —                     | OpenRouter API key                 |
| `TASK_DESCRIPTION`   | no       | (empty)               | Longer task description            |
| `WORKFLOW`           | no       | `no-pr`               | Workflow name or path to YAML      |
| `BASE_BRANCH`        | no       | `feature/darkfactory` | Branch the worktree is created from|
| `MODEL`              | no       | (workflow default)    | Model override                     |

## Volume mounts

| Mount     | Required | Description                              |
|-----------|----------|------------------------------------------|
| `/repo`   | yes      | Repository to work on (read-write)       |
| `/output` | yes      | Destination for `CHANGES.patch`          |

## Exit codes

- `0` — Pipeline completed; `CHANGES.patch` written to `/output`
- `1` — Pipeline failed, timed out, or required variable missing

## How it works

1. The entrypoint installs the `no-pr` workflow into `~/.foreman/workflows/`
2. A task is created in a local SQLite store (no Postgres needed)
3. `foreman run task <id> no-pr --project-path /repo --no-watch` spawns the pipeline worker
4. The entrypoint polls the SQLite store every 15s for run completion (max 60 min)
5. On success, `CHANGES.patch` is located under `~/.foreman/reports/` and copied to `/output/`

## Pipeline phases

| Phase     | What it does                                     |
|-----------|--------------------------------------------------|
| Explorer  | Reads the codebase, writes an exploration report |
| Developer | Implements the change                            |
| QA        | Runs tests, validates the change                 |
| Reviewer  | Code review — retries developer if issues found  |
| Validate  | Type-checks the final result                     |
| Export    | Diffs the branch and writes `CHANGES.patch`      |
