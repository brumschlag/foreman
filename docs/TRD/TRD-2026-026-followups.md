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

---

## kelos: `preCommands` are only honoured on the POOLED path

**Found:** 2026-07-29, after fixing the conversion bug below.

With the conversion fix deployed, Foreman's Task was reconciled, an agent pod ran,
and the Task **Succeeded** — but the tool-policy hook never fired. Server-side
`ToolCall*` events: **zero**. The agent called `Bash` freely in the explorer
phase, which the policy denies.

**Cause.** `preCommands`/`postCommands` are executed by
`internal/workerrunner/runner.go` (`runPreCommands`, called from `runAgent`), and
that binary only runs on the **pooled** path:

| Path | Container command | Runs preCommands |
| --- | --- | --- |
| pooled (`workerPoolRef`) | `/kelos/bin/kelos-worker-runner` | yes |
| non-pooled (Job) | `/kelos_entrypoint.sh` | **no** |

So the fields are accepted, stored, and silently ignored on the non-pooled path.
Foreman uses non-pooled specifically because the CRD forbids `podOverrides`
alongside `workerPoolRef`, and `podOverrides` is how agents receive gateway
credentials.

**This is the real blocker for tool policy on kelos**, and it is a genuine
conflict rather than a bug to patch quickly:

- pooled → `preCommands` run, but no `podOverrides`, so no per-Task gateway
  credentials, and the pool's workspace is a fixed repo (`envoverrides-scratch` →
  octocat/Hello-World);
- non-pooled → credentials and the right repo, but `preCommands` are ignored.

**Options:**
1. Teach the non-pooled entrypoint to run pre/postCommands, so the two paths agree.
   The honest fix; `/kelos_entrypoint.sh` is in the agent image, not the controller.
2. Bake the hook into the agent image and enable it by env var, avoiding
   `preCommands` altogether. Works on both paths.
3. Give the WorkerPool the gateway env in its own template (already supported) and
   create a per-repo pool, then use the pooled path. No kelos change, but a pool
   per repository.

Until one of these lands, a policy-gated phase on the kelos backend runs
**unguarded** — the pod accepts the Task, ignores the hook install, and the agent
proceeds. Foreman cannot detect this from the Task status, which reports Succeeded.

---

## Agent Mail now reaches a kelos agent — DONE (pooled path)

**The gap.** All six `src/orchestrator/kelos-*.ts` files contained zero mail
references, and `KelosTaskRequest` carried only prompt/systemPrompt/model/
phaseName/taskId. Mail on the Pi path is three in-process tool closures over a
live `AgentMailClient` (`agent-worker.ts:898-900`), which cannot reach a separate
program in a separate pod. So a kelos phase had no mail channel at all:

- `foreman inbox send` stored the message and no agent ever read it;
- Overwatch steering landed at `delivery_status: "unsupported"` — the flag
  `Inbox.send_operator_message` already had for a worker that cannot receive;
- the explorer prompt's `/send-mail` error path was silently dead, so an agent
  hitting a blocker reported nothing.

**The fix mirrors the tool policy exactly.** The mail store does not move; only
the interception point does. Server-side authority is three new endpoints —
`GET /worker/v1/mail`, `POST /worker/v1/mail/send`, `POST /worker/v1/mail/ack` —
and the pod-side point is `src/defaults/hooks/mail-shim.sh` plus `/mail-read`
and `/mail-send` slash commands, installed by `preCommands` and advertised in the
phase prompt.

Three things are all required, and each was a separate way to ship nothing:
without the install there is no shim; without `envOverrides` it cannot reach the
server; without the prompt guidance the commands exist and are never invoked
(the Pi path's tool descriptions, where an agent normally learns a channel
exists, do not travel to a pod).

**Fails open, deliberately.** The policy hook must deny when it cannot reach the
server. Mail must not: losing steering is bad, wedging the phase because steering
is unavailable is worse. The shim reports the failure and exits non-zero, and a
test asserts `exit 2` never appears in it.

**Scoped to the pooled path by the constraint above.** Because non-pooled Tasks
silently ignore `preCommands`, `KelosClient.deliversMail` is
`Boolean(mail) && preCommandsRun(options)` — requested AND actually installable.
A configured-but-uninstallable channel must not report itself as working; that is
the same "looks equipped and is not" failure the tool-policy work hit. Unlike the
policy this does not refuse the phase — mail is a capability, not a guard — so
callers warn and skip mail-dependent hooks rather than aborting. **The pilot's
non-pooled path therefore still has no mail channel**; it unblocks with the same
options listed for tool policy above.

**Verified against a real server, not just unit tests.** The tool-policy lesson
was that 75 green tests missed a hook that never fired, because they asserted the
settings file was *written* rather than *read*. So: a real Elixir server was run
locally, an operator message seeded through `inbox.send` (landing as
`unsupported`, reproducing the diagnosis), then the install commands were executed
in a clean `env -i` sandbox and **the pod-installed copy** — not the `src/` one —
was run against it. Results: the agent saw the steering, `unsupported` →
`delivered`, a second read correctly returned "No new mail", and a
`/mail-send foreman agent-error` round-tripped back to the operator inbox.

**Two bugs the live run caught that the tests would not have.**

1. *Only the first message was ever acknowledged.* The ack loop was
   `while read id ... done < "$IDFILE"`, and `curl` inside the body inherits the
   loop's stdin and consumes the remaining ids. Fixed by reading into a variable
   first; a regression test pins the shape.
2. *No `.sh` file was ever packaged into `dist/`.* The `build-atomic.js` asset
   filter allowed only extensionless/`.md`/`.yaml`. Both the mail shim and the
   **pre-existing tool-policy hook** were resolving through their `src/` fallback,
   invisible locally because `package.json` also ships `src/defaults/`. Filter
   fixed; both now resolve from `dist/`.

---

## kelos path end-to-end — DONE

**2026-07-29, `foreman-server:0.1.24`.** Run
`a130060c-8513-fcbd-5ad2-0032fe54c666` (`kelos-e2e-10`) ran
explorer → developer → documentation → qa → reviewer as kelos Tasks, then
finalize and create-pr in-process, and opened
**`brumschlag/packer-pipeline-test#3`** — one file, `+1/-0`, no worker artifacts.
$3.49. That last part confirms the finalize unstage fix: PR #1 carried three
stray files, this carries none.

Three bugs stood between the handoff and that PR. Only the first was known.

**1. An empty response body killed the worker** (the handoff's only listed
blocker). All seven parse sites in `ElixirServerClient` called
`await response.json()` unguarded, so an empty body raised
`Unexpected end of JSON input` out of the client. The same error appeared twice
earlier in the crashed run as `heartbeat event append failed (non-fatal)` —
the guarded paths logged it, the unguarded one killed the process. Bodies now
parse through a helper returning `undefined`, and each site decides what an
absent body means: 2xx worker-event/command calls synthesise the envelope, reads
still throw but report the HTTP status, and **tool policy fails closed** because
a missing decision must never read as allowed.

**2. The scheduler crashed on every tick, so nothing could dispatch at all.**
`age_seconds/2` clause-matched `nil`, `DateTime` and binary, but the Postgres
read model returns `updated_at` as a `NaiveDateTime` — every tick raised
`FunctionClauseError` in `active_runs/0` and terminated the GenServer. The tell
was misleading twice over: the tick endpoint returned **500 with an empty body**
(the very shape bug 1 guards), and the scheduler state reported `last_tick: nil`,
which reads as "never started" rather than "dies every 5s".
`coerce_datetime/1` in `projection_store.ex` already handled the naive case, so
this was a missed clause on a known shape, not an unknown one.

**3. RBAC omitted `patch`/`update` on `tasks.kelos.dev`.**
`kelos-kubectl-api` dispatches with `kubectl apply`, which PATCHes when the
object already exists, and a phase **retry** reuses the name
`foreman-<task>-<phase>`. This is what killed `kelos-e2e-8`, where the Forbidden
surfaced as `worker_exited_without_terminal_event` — so a permissions problem
was reported as a worker crash.

**Still open from this run.** Dispatch requires status `ready`, so a task created
as `open` sits forever with no diagnostic — it appears in neither `claimed` nor
`skipped`, because `dispatchable_tasks/0` filters it out before the scheduler
ever sees it.

---

## The Node assumption had a FOURTH site — DONE

`resolveProjectTestCommand` (`npm test`) and `setupStepApplies` (`npm install`)
were each fixed after a live run caught them, but the finalize builtin still ran
`npm ci` and `npx tsc --noEmit` unconditionally. The run that produced
`packer-pipeline-test#3` recorded, in `FINALIZE_REPORT.md`:

```
## Dependency Install
- Status: FAILED
- Details: npm error code EUSAGE ... can only install with an existing
           package-lock.json
## Type Check
- Status: FAILED
- Details: This is not the tsc command you are looking for
```

**Neither blocked the run, which is exactly why it survived three rounds of
fixes.** Every non-Node finalize report carried two false failures that a reader
cannot distinguish from real ones. A step that cannot apply is now skipped, and
the report says `SKIPPED` rather than `SUCCESS`, so "nothing to do" stays
distinguishable from "passed".

Two narrower bugs fell out of this: `npm ci` *requires* a lockfile, so it failed
even on a Node project that had only a manifest (now `npm install`); and
typecheck requires a `tsconfig.json`, not merely a `package.json`, because
`npx tsc` otherwise tries to *fetch* a package — the source of the "not the tsc
command" message.

`non-node-project-finalize.test.ts` is the end-to-end guard. It asserts all four
sites **together** over a realistic packer/ansible worktree, since each was
previously found one at a time by a live run and nothing in CI exercised a
project without a `package.json`. It also pins the opposite direction: a
skip-everything implementation satisfies every non-Node assertion, so a Node
project is checked to still install, typecheck and test.

---

## Scheduler backoff — DONE

A task that failed and returned to `ready` was re-claimed on the very next tick,
forever. Measured with a throwaway probe: **6 ticks → 6 launches → 6 runs**,
unbounded — at the 5s auto-tick, the ~44 dispatches in 7 minutes seen on the
pilot. Each attempt spawns a worker and can spend real money, so this is a cost
bug as much as a correctness one. Still distinct from per-phase `retryOnFail`,
which is bounded and works correctly.

Re-claim is now delayed 30s, 60s, 120s … capped at 15m, counting only failures
inside the cap so an old scar does not penalise a task forever. A task with no
recent failure is unaffected, and the skip reason names the remaining wait.

**Two projection details the tests had to respect, both found by probing rather
than reading the code:**

1. `RunFailed` stamps `failed_at` from the **event** time and ignores a payload
   `failed_at`. A payload-only fixture therefore records every failure as "now"
   and cannot test expiry — the fixture must set `occurred_at`.
2. A run's `task_id` is populated by `RunStarted`, so a run recorded only via
   `RunFailed` has none and is **not attributable to its task**. Association
   accepts the task's own `run_id` as a fallback, and the fixture emits
   `RunStarted` first as a real run does. Before this, a 4-failure fixture
   counted as 1 and the backoff window was wrong.

---

## Stale runs no longer hold capacity slots — DONE

**`foreman-server:0.1.25`.** Capacity was counted over *all* `active_runs` while
the `stale` flag the scheduler already computed went unused, and nothing sweeps
stale runs (`RecoveryEngine` only reconciles an observation *pushed* to it), so a
dead run's slot was never released. Four abandoned runs (11–15h old) pinned
`max_concurrent: 2` and had to be failed by hand before `kelos-e2e-10` could be
claimed. Fixing the tick crash *exposed* this rather than resolving it.

Capacity now counts live runs only. Reporting still includes every active run, so
a stale one stays visible in the tick output instead of vanishing.

**Staleness could not be judged on `updated_at` alone.** `WorkerHeartbeat` does
**not** bump `run.updated_at` — only phase transitions do — so a single long
phase looks stale by timestamp while its worker is alive and working, and freeing
that slot would double-dispatch the task. A heartbeat within
`stale_heartbeat_seconds` (5m) therefore overrides an old `updated_at`, and
`heartbeat_age_seconds` is now reported alongside `age_seconds`.

**Verified against the live cluster, not just tests.** The abandoned
`kelos-e2e-9` run was still present and flagged `stale: true` with
`heartbeat_age_seconds: 44677` (12.4h — the worker was long dead while
`updated_at` was only ~42m old, which is exactly why the heartbeat signal
matters). A probe task then dispatched *despite* that run occupying what used to
be the only slot. Both directions were also checked in tests: reverting the
capacity change fails the stale-slot test, and dropping the heartbeat override
fails the double-dispatch test.
