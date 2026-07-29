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

## BLOCKER (kelos-side) — a multi-line `preCommand` wedges the Task controller

**Found:** 2026-07-29, first end-to-end dispatch on the kelos phase backend.
**Not a Foreman bug** — it is in the kelos fork, and it blocks the kelos path
entirely.

**Symptom.** Foreman creates the Task successfully, then it sits with empty
`status` and no finalizer forever. No agent pod is ever scheduled. The controller
logs, every ~40s:

```
unable to add finalizer ... Task.kelos.dev "foreman-kelos-e2e-1-explorer" is
invalid: spec: Invalid value: Task spec is immutable after creation
```

`internal/controller/task_controller.go:118` adds `kelos.dev/finalizer` and calls
`r.Update(ctx, &task)`. That update carries the spec back, and the CRD's
`self == oldSelf` immutability rule (`api/v1alpha2/task_types.go:514`) rejects it
— so the controller can never take ownership of its own Task.

**Isolated by bisection.** Applying Tasks by hand, the finalizer is added fine
with: plain `podOverrides`, `podOverrides` containing a `secretKeyRef` env, and a
single-line `preCommands` entry. It fails as soon as a `preCommands` argument
contains **literal newlines** — which Foreman's tool-policy hook install does,
since it writes the hook script via a heredoc.

The stored value round-trips with real `\n` characters intact (verified), so this
looks like a CEL `self == oldSelf` comparison that is not stable for multi-line
strings rather than anything Foreman is doing wrong.

**Consequence.** The tool-policy hook cannot be installed via `preCommands` on
this controller build, so the kelos backend cannot run a policy-gated phase — the
capability TRD-2026-026 Phase 5 was written to unblock.

**Options, none of them Foreman-side:**
1. Fix kelos: skip the immutability rule for controller-originated updates, or add
   the finalizer with a JSON-patch on `metadata` only rather than a full-object
   `Update`. Cleanest, needs a controller rebuild and redeploy.
2. Avoid newlines in `preCommands` — e.g. base64 the hook script and decode in a
   single-line command. A workaround in Foreman for a kelos defect; feasible, and
   would let the path be proven before (1) lands.
3. Bake the hook into the agent image instead of installing per Task.

Reproduce with the probe used above:

```bash
kubectl apply -f - <<'YAML'
apiVersion: kelos.dev/v1alpha2
kind: Task
metadata: {name: probe-heredoc, namespace: kelos-pilot}
spec:
  model: claude-haiku
  prompt: echo hi
  type: claude-code
  credentials: {type: none}
  workspaceRef: {name: packer-pipeline-test}
  preCommands: [["sh","-c","set -e\necho two"]]
YAML
# → no finalizer, empty status, controller logs the immutability error
```
