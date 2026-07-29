---
date: 2026-07-29T03:41:11+00:00
session_name: general
researcher: Brian Rumschlag
git_commit: 04d464d3
branch: spike/kelos-phase-runner
repository: foreman
topic: "TRD-2026-026 in-cluster Foreman + kelos end-to-end Implementation Strategy"
tags: [implementation, strategy, kelos, deployment, tool-policy, patch-transport, eks]
status: complete
last_updated: 2026-07-29
last_updated_by: Brian Rumschlag
type: implementation_strategy
root_span_id:
turn_span_id:
---

# Handoff: Foreman runs in Kubernetes; in-process path opens PRs, kelos path passes all agent phases

## Task(s)

Implement **TRD-2026-026 (Containerizing Foreman)**, then prove both execution
backends end to end against a real repository.

| Task | Status |
| --- | --- |
| Phase 1 — Elixir release | **complete** |
| Phase 2 — container image | **complete** |
| Phase 3 — deploy to `kelos-pilot` | **complete** |
| Phase 4 — non-interactive project registration | **complete** (no code needed) |
| Phase 5 — tool policy enforced in-cluster | **complete**, proven with live denials |
| Phase 5 — volume transport | **declined**, measured and rejected (EBS is AZ-pinned) |
| In-process path → real PR | **complete** — `brumschlag/packer-pipeline-test#1` |
| kelos path → real PR | **blocked** on one crash at the finalize boundary |

Plan doc: `docs/TRD/TRD-2026-026-foreman-containers.md` (updated in-place with each
phase's outcome, including four places its premises were wrong).
Follow-ups doc: `docs/TRD/TRD-2026-026-followups.md`.

## Critical References

- `docs/TRD/TRD-2026-026-foreman-containers.md` — the plan, annotated with outcomes
  and corrections per phase
- `docs/TRD/TRD-2026-026-followups.md` — open bugs, including a **corrected**
  diagnosis (two earlier ones in that file were wrong; the correction is recorded
  rather than silently replaced)
- `deploy/pilot/README.md` — the hand-applied cluster state; **not** GitOps-managed,
  so live changes must be mirrored here

## Recent changes

32 commits on `spike/kelos-phase-runner` (`53575fb3..04d464d3`). Foreman:

- `packages/foreman_server/lib/foreman_server/release.ex` — new; `migrate/0` for
  `bin/foreman_server eval`, because a mix release contains no Mix
- `packages/foreman_server/lib/foreman_server/http/endpoint.ex:7` — bind was
  hard-coded to `127.0.0.1`; now `FOREMAN_SERVER_HTTP_BIND`, still loopback-default
- `packages/foreman_server/lib/foreman_server/worker_launcher.ex:117` — `server_url`
  was hard-coded loopback, meaningless in an agent pod
- `packages/foreman_server/lib/foreman_server/phase_reports.ex` — new;
  `POST /worker/v1/reports`, path-traversal validated per segment
- `src/orchestrator/pi-sdk-runner.ts:381` — `getPiSdkEventError` missed errors
  nested on `event.message`, so 401-on-every-turn reported `success=true`
- `src/orchestrator/finalize-guards.ts` — scope guard now exempts worker-generated
  audit files and matches absolute Edit-First paths
- `src/lib/workspace-paths.ts:85` — `WORKER_ARTIFACT_PATHSPECS`, now exported and
  shared by the finalize unstage *and* the kelos seed diff
- `src/lib/vcs/git-backend.ts` — `createWorktreePatch` (seed generation, artifacts
  excluded); `git config --system` in the image instead of `--global`
- `src/orchestrator/kelos-client.ts` / `kelos-backend.ts` / `kelos-report-shim.ts`
  — tool policy, mail, report upload, and seed patch wired through
- `docker/server.Dockerfile` — `gh`, `kubectl`, system gitconfig, credential helper
- `deploy/pilot/*.yaml` — server, Postgres, RBAC, Workspace

kelos fork (`/home/brian/source/kelos`, branch `feat/pooled-task-env`, 3 commits):

- `internal/conversion/task.go` — preserve `pre/postCommands` across v1alpha1
  conversion (annotation stash, matching the existing AgentConfig pattern)
- `internal/controller/agent_command.go` — `agentProcessCommandWithHooks`
- `internal/controller/job_builder.go` — run hooks and apply `envOverrides` on the
  non-pooled path

## Learnings

**Deployment gotchas that will bite again**

- A fresh PVC mounts `root:root` and **masks** the image's `chown` of `$HOME`.
  `securityContext.fsGroup` fixes it. Same class: `git config --global` as root
  writes `/root/.gitconfig`, unreadable by uid 10001 — use `--system`.
- `FOREMAN_HOME` **already includes** `.foreman`. Appending it again writes to
  `~/.foreman/.foreman/reports`, which the artifact gate never reads.
- **Pi ignores `ANTHROPIC_BASE_URL`.** Pointing it at the LiteLLM gateway silently
  sends requests to `api.anthropic.com` and 401s. Pi supports Bedrock natively via
  Pod Identity — no key stored anywhere. Do **not** set `ANTHROPIC_API_KEY`, or Pi
  prefers the Anthropic provider and ignores Bedrock.
- Foreman assumed **every project is Node with a test suite** — hard-coded
  `npm test` in finalize, `npm install` in workflow setup, and a QA evidence check
  demanding runner output. Three separate places, one root cause. There is still
  **no end-to-end test against a non-Node project**, which is why it survived.
- The `github-token-write` secret reported `push: true` on the repo API while being
  **read-only**. That field reflects the *account's* role, not the token's grant —
  the only reliable check is attempting a write.

**kelos architecture**

- `preCommands`/`postCommands`/`envOverrides` were honoured **only on the pooled
  path** (`internal/workerrunner`); a non-pooled Job runs `/kelos_entrypoint.sh`
  and ignored them silently.
- Every phase runs in a **fresh clone**, so without a seed patch a verdict phase
  inspects the wrong filesystem. QA reported the task's own output missing while it
  sat in Foreman's worktree.
- `builtin` phases (`finalize`, `create-pr`, `pr-wait`, `merge`) run **in-process
  regardless of backend** (`pipeline-executor.ts:1807`) — they already see the real
  worktree.

**Volume transport is not viable here** — EBS is AZ-pinned, and the worktree PV's
zone has exactly one amd64 node, so it would pin the server *and* every phase pod
to that node. Needs EFS.

## Post-Mortem (Required for Artifact Index)

### What Worked

- **Running the real thing after every fix.** Nine Foreman bugs and three kelos
  bugs were found this way; a 3,800-test suite passed throughout. Unit tests never
  caught any of them.
- **Testing through real git instead of a stub.** A stub let a half-fixed patch bug
  pass: I cleared only the index, and the next live run failed on the other wording
  ("already exists in working directory") because the file was still on disk.
  Replacing the stub with a real-git test caught it immediately.
- **Verifying gate teeth by injecting a violation, in both directions.** Removing a
  fix must fail a test *and* over-broadening it must fail a different one. The
  over-broad direction caught a too-loose recovery guard that the narrow test missed.
- **Checking whether the deployed artifact contains the fix** (`grep` the compiled
  `dist/` in the image) before spending a run.
- **Comparing the two path builders by hand** caught the `.foreman/.foreman`
  mismatch before deploying, rather than after a wasted run.

### What Failed

- Tried: enumerating worker-artifact filenames → Failed because agents invent a new
  name almost every run (`SESSION_LOG.md`, `QA_SESSION_LOG.md`, `SESSION_LOG_DOCS.md`,
  `QA_DETAILED_SESSION_LOG.md`, `QA_VERIFICATION_SESSION.md`). Shipped three
  successively-broader lists before switching to keyword matching. **This was the
  worst process failure of the session — whack-a-mole instead of root cause.**
- Tried: diagnosing the kelos blocker as "newlines break CEL", then "command size"
  → Both wrong. A Task with `preCommands: [["true"]]` failed and the same Task
  without the key succeeded, so the variable was the **field**, not its contents.
  Corrected in the followups doc rather than quietly overwritten.
- Tried: asserting shell quoting by inspecting the string → the test failed on
  *correct* code. Replaced with one that **executes** a payload that would escape.
- Error: worker crash reported as `merge_conflict` → the patch had applied fine; the
  collision was a worker artifact, misattributed to the task's own work.
- Error: `pkill -f <pattern>` self-terminates (exit 144) because its own argv
  matches. Hit this repeatedly; verify separately rather than trusting the code.
- Error: `AskUserQuestion` renders blank on WSL — asked inline instead.

### Key Decisions

- Decision: **amd64-only image**, not multi-arch.
  - Alternatives: emulated arm64 build (40+ min under QEMU).
  - Reason: the plan claimed Graviton required it, but the `general-purpose`
    nodepool is amd64-only (arm64 lives in `system`). Pinned `nodeSelector` instead.
- Decision: **dedicated in-cluster Postgres**, not RDS or a shared instance.
  - Alternatives: six existing Postgres instances on the cluster.
  - Reason: each is owned by another app and four are ArgoCD-managed; reuse would
    couple Foreman's schema lifecycle to unrelated release cadences.
- Decision: **Bedrock direct via Pod Identity**, not the LiteLLM gateway.
  - Alternatives: `models.json` custom provider pointing at the gateway.
  - Reason: Pi ignores `ANTHROPIC_BASE_URL`. Tradeoff accepted: loses the gateway's
    per-user cost attribution.
- Decision: **Option A — seed each pod with one cumulative patch** of Foreman's
  worktree, not a chain of per-phase patches.
  - Alternatives: (B) route verdict phases to the in-process runner; (C) shared PVC.
  - Reason: no ordering to get wrong, no re-collision per boundary. C was measured
    and rejected (AZ pinning). Seed **must** precede baseline capture or it is
    attributed to the phase and re-uploaded.
- Decision: **skip** finalize test validation when no test setup is detected, rather
  than fail.
  - Reason: failing gives the pipeline nothing it can act on; mirrors what
    `installDependencies()` already did for missing dependencies.

## Artifacts

- `docs/TRD/TRD-2026-026-foreman-containers.md` — plan + per-phase outcomes
- `docs/TRD/TRD-2026-026-followups.md` — open bugs and corrected diagnoses
- `deploy/pilot/{README.md,foreman-server.yaml,postgres.yaml,kelos-rbac.yaml,kelos-workspace.yaml}`
- `docker/{server.Dockerfile,server-entrypoint.sh}`, `.dockerignore`
- `packages/foreman_server/lib/foreman_server/{release.ex,phase_reports.ex}`
- `src/orchestrator/{kelos-report-shim.ts,kelos-tool-policy-hook.ts}`
- `src/defaults/hooks/{report-shim.sh,tool-policy-pretooluse.sh}`
- Live: `foreman-server:0.1.22` in ECR, deployed to `kelos-pilot`;
  `kelos-controller:v0.49.0-hooks2` in `kelos-system`
- PR proving the in-process path: `brumschlag/packer-pipeline-test#1`

## Action Items & Next Steps

1. **Fix the finalize-boundary crash** (only blocker for kelos → PR).
   `[foreman-worker] Fatal: Unexpected end of JSON input` right after REVIEWER
   completed. `src/lib/elixir-server-client.ts` calls `await response.json()`
   unguarded in ≥5 places (lines 131, 162, 192, 211, 238); the server
   intermittently returns an empty body — the same error appears twice earlier as
   `heartbeat event append failed (non-fatal)`. **Affects both backends.** Guard the
   parses so an empty body degrades instead of killing the worker.
2. **Re-run the kelos path** after (1) — expect it to reach `create-pr`.
3. **Clean up PR #1**, which carries three files (`CLUSTER_SMOKE.md` plus
   `REVIEW_SESSION_LOG.md`, `TASK.md`) — created before the unstage fix landed.
4. **Add a non-Node end-to-end test.** Three bugs shared the Node assumption and
   nothing in CI would catch a fourth.
5. **Scheduler has no backoff** — a fast-failing task was re-dispatched ~44 times in
   7 minutes. Distinct from per-phase `retryOnFail`, which works correctly.
6. **A stale `in_progress` run holds a capacity slot forever**, silently blocking
   dispatch (`last_tick: null`). The scheduler already computes a `stale` flag but
   nothing acts on it.
7. **Fix `bd`** — `bd list` reports "no beads database found" while `bd where`
   resolves `.beads/`; it expects embedded-dolt but only legacy `beads.db` +
   `issues.jsonl` exist. Blocks filing any of this in beads.
8. **Fix `mulch sync`** — blocked by a pre-existing malformed record
   (`orchestrator:19` / `mx-139c97`, missing required `name`). Corpus was committed
   with plain `git` rather than `--no-validate`.
9. **Gitignore** `.beads/` (11 MB), `.qlty/`, `.claude/tsc-cache/`,
   `.foreman-pipeline-cache/` — currently untracked and easy to commit by accident.
10. Consider upstreaming the three kelos fixes; the fork is now level with
    `upstream/main` (was 11 behind) and merged cleanly.

## Other Notes

- **Cluster:** EKS `software-engineering`, account 565715328522, us-east-1,
  namespace `kelos-pilot`. Two pods: `foreman-server`, `foreman-postgres`.
- **ECR pushes need break-glass** (`AWS_PROFILE=TellihealthBreakGlassAdmin-565715328522`);
  the default Bedrock role is denied `ecr:GetAuthorizationToken`. Also set
  `DOCKER_CONFIG=$(mktemp -d)` — the WSL Docker credential store chokes on ECR
  tokens. ECR tags are **immutable**: bump, never re-push.
- **Pre-existing test failures** (not caused by this work; confirmed by reverting):
  Node `resolve-workflow-name.test.ts` + `pipeline-rebase-after-phase.test.ts`
  (7 tests); Elixir `migration_importer_test.exs:76` (1 test).
- **Workflow used for testing** is `nodeless` on the `foreman-home` PVC at
  `/home/foreman/.foreman/workflows/nodeless.yaml` — hand-edited on the volume, not
  in git. Models must be native Bedrock ids
  (`amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0`).
- **Spend:** ~$17 in Bedrock across ~12 live runs. A full kelos run is ~$3.
- `foreman init --force` must be run in-pod once per deployment or dispatch fails
  preflight with "runtime assets are out of date".
