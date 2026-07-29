# TRD-2026-026 follow-ups: bugs found by the first in-cluster run

**Date:** 2026-07-28
**Status:** Open
**Context:** Found while proving TRD-2026-026 Phase 5 end-to-end — dispatching a
real task to the in-cluster server. Both are pipeline-correctness bugs, not
deployment issues; both reproduce on the laptop path too.

Filed here rather than in beads because `bd` is currently broken in this repo
(`bd list` → "no beads database found" while `bd where` resolves `.beads/`; the
directory holds a legacy `beads.db` + `issues.jsonl` with no `embeddeddolt/`).
Move these into beads once that is repaired.

---

## BUG 1 — A phase whose every LLM turn 401s reports success

**Severity:** high. This is a failure that presents as success.

**Observed.** With Pi misconfigured (an API key for a gateway that Pi does not
honour), every turn came back
`401 {"type":"authentication_error","message":"invalid x-api-key"}`, yet:

```
[pi-sdk-runner] success=true turns=1 maxTurns=500 tools=0 cost=$0.0000 tokensIn=0 tokensOut=0
[PHASE: DEVELOPER] COMPLETED ($0.0000)
```

Three phases "COMPLETED" in ~0.3s having called no model and done no work. The
run only stopped later, at `documentation`, because no artifact existed — so the
real cause (auth) was reported two phases downstream from where it happened.

**Why it matters.** `stopReason: "error"` with an `errorMessage` on every message
is unambiguous, and the aggregate signals (`turns=1`, `tools=0`, `cost=$0`,
`tokensIn=0`) are all consistent with "nothing happened". A phase that made zero
successful model calls must not be `success=true`.

**Where.** `src/orchestrator/pi-sdk-runner.ts` — the success determination
around the `session.prompt()` result. It appears to treat "the SDK returned
without throwing" as success.

**Fix sketch (TDD).** RED first: feed the runner a transcript whose messages all
carry `stopReason: "error"` and assert `success === false` with the provider's
error surfaced as `errorMessage`. Then fail the phase when no message completed
successfully. Consider also treating `turns > 0 && tokensIn === 0 && tokensOut === 0`
as a hard error, since that combination cannot occur on a real call.

---

## BUG 2 — git has no identity in the container, so finalize cannot commit

**Severity:** high. Blocks every run from completing, on any repo.

**Corrects an earlier draft of this document,** which claimed the retry loop was
unbounded and blamed a missing `DEVELOPER_REPORT.md`. Reading the pipeline
decision lines disproved both:

```
[PIPELINE] qa failed, retrying developer (retry 1/2)
[PIPELINE] qa failed, retrying developer (retry 2/2)
[PIPELINE] qa failed after 2 retries, continuing
[PIPELINE] finalize FAIL: nothing_to_commit: git commit failed: Author identity unknown
[PIPELINE] finalize failed, retrying developer (retry 1/1)
```

Retries are correctly bounded by `retryOnFail` (qa 2, reviewer 1, finalize 1) and
the pipeline *continued* after exhausting them, exactly as designed. The repeated
`developer` phases I saw were those bounded retries, not a loop.

**Actual root cause.** `docker/server.Dockerfile` ran `git config --global`
during the build **as root**, which writes `/root/.gitconfig`. The container runs
as uid 10001 whose `$HOME` is `/home/foreman` — and that path is the
`foreman-home` **PVC mount**, which starts empty and shadows anything the image
put there. So git had no `user.email`/`user.name` and finalize failed with
`Author identity unknown`.

Confirmed in the live pod: `/root/.gitconfig` is unreadable to uid 10001, and the
identity only appeared later because `foreman init` happened to write
`/home/foreman/.gitconfig` after the fact.

**Fix.** Use `git config --system` (writes `/etc/gitconfig`) in the image, which
is readable by any uid and cannot be shadowed by a volume mount over `$HOME`.

**Still open, lower priority.** `DEVELOPER_REPORT.md` was genuinely absent from
the reports directory while every other report was present, so QA's `fail`
verdict may be legitimate rather than a gate bug. Worth a separate look at
whether the developer phase actually wrote it — but it is not what stopped the
run.

---

## Smaller items, same run

- **`worker_launcher.ex:117` hardcodes `server_url` to `http://127.0.0.1:<port>`**,
  ignoring `FOREMAN_SERVER_URL`. Works today only because the launcher and server
  share a pod; it blocks ever splitting them (a plan open question).
- **Worker → Elixir callbacks got `missing or invalid authorization`** and fell
  back to a local store (`[agent-worker-run-status] ... falling back to local
  store`). Terminal run state is supposed to be event-sourced, so this silently
  degrades the audit trail.
- **No backoff on repeated dispatch failure.** A failing task was re-dispatched
  ~44 times in ~7 minutes by the 5s auto-tick. This is at the SCHEDULER level and
  is distinct from the per-phase `retryOnFail` bound, which works correctly — a
  task that fails fast is re-claimed immediately, forever.
- **The bundled `smoke` workflow hardcodes `npm install` with `failFatal: true`**,
  so it cannot run against a non-Node repo. `installDependencies()` in
  `src/lib/setup.ts` already guards on a missing `package.json`; the workflow's
  raw `setup:` command does not.

---

## BLOCKER (kelos-side) — lossy v1alpha1 conversion drops `preCommands`

**Found:** 2026-07-29, first end-to-end dispatch on the kelos phase backend.
**Root cause is in the kelos fork** (`internal/conversion/task.go`), not Foreman.

**Corrects two earlier wrong diagnoses in this document.** I first blamed literal
newlines in the heredoc, then command size. Both were wrong: a Task with
`preCommands: [["true"]]` fails, and the byte-identical Task with the
`preCommands` key removed succeeds. The variable is the FIELD, not its contents.

**Symptom.** Foreman creates the Task; it then sits with empty `status` and no
finalizer forever, no agent pod ever scheduled, controller logging every ~40s:

```
unable to add finalizer ... Task.kelos.dev "..." is invalid:
spec: Invalid value: Task spec is immutable after creation
```

**Mechanism.** The CRD serves BOTH `v1alpha1` and `v1alpha2` (storage
`v1alpha2`) with a conversion webhook. `preCommands`/`postCommands` exist only in
`v1alpha2` — `v1alpha1.TaskSpec` has no such fields — and
`internal/conversion/task.go` converts specs with a plain `convertViaJSON` that
has no preservation for them. So a round-trip through `v1alpha1` silently drops
both.

`task_controller.go:118` then adds `kelos.dev/finalizer` with a full-object
`r.Update()`, which carries the (now field-stripped) spec back. The CRD's
`self == oldSelf` rule (`api/v1alpha2/task_types.go:514`) sees a changed spec and
rejects it, so **the controller can never take ownership of a Task that uses
`preCommands`**.

**Proven** with a throwaway test in the fork (`internal/conversion`):

```
preCommands LOST in round-trip: got [] want 1 entry
postCommands LOST in round-trip: got [] want 1 entry
```

i.e. `taskFromHub` → `taskToHub` loses both fields. That is the whole bug; the
immutability error is a downstream symptom.

**Why the pooled path worked.** `foreman-turns-1-developer` (24h old, pooled) has
`preCommands` and succeeded — Tasks with `workerPoolRef` are reconciled by the
WorkerPoolReconciler *after* the finalizer is in place, taking a different code
path. Only the non-pooled path trips this.

**Fix (in kelos).** The fork already has a pattern for exactly this: fields absent
from `v1alpha1` are stashed on annotations and restored on the way back — see
`preservedMCPValueFromEnvAnnotation` / `preservedSkillsSecretRefAnnotation` in
`internal/conversion/agentconfig.go`. Apply the same to
`preCommands`/`postCommands` in `internal/conversion/task.go`.

Cheaper alternatives, if a controller rebuild is not wanted now:
1. Stop serving `v1alpha1` (`served: false`) so no conversion happens. One CRD
   edit, but breaks any v1alpha1 client.
2. Have the controller add its finalizer with a metadata-only JSON patch instead
   of a full-object `Update`, so the spec is never resubmitted. Arguably correct
   regardless — a finalizer add should not rewrite the spec.

**Reproduce:**

```bash
# fails: no finalizer, empty status
kubectl apply -f - <<'YAML'
apiVersion: kelos.dev/v1alpha2
kind: Task
metadata: {name: probe-pre, namespace: kelos-pilot}
spec:
  model: claude-haiku
  prompt: echo hi
  type: claude-code
  credentials: {type: none}
  workspaceRef: {name: packer-pipeline-test}
  preCommands: [["true"]]
YAML
# succeeds with the preCommands line removed
```
