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

## BUG 2 — Missing DEVELOPER_REPORT.md causes an unbounded retry loop

**Severity:** medium (correctness + cost).

**Observed.** On a successful Bedrock run, the pipeline looped
`developer → documentation → qa → developer → …`, burning ~$0.05 per phase, with
QA's own verdict **PASS** each time. The reports directory held
`EXPLORER_REPORT.md`, `DOCUMENTATION_REPORT.md`, `QA_REPORT.md`,
`DOCUMENTATION_HANDOFF.json`, `SESSION_LOG.md` — but **no
`DEVELOPER_REPORT.md`**, so the developer phase's artifact gate never satisfied
and it was re-run indefinitely.

Notably the documentation agent's own session log claims it read
`DEVELOPER_REPORT.md`, so the developer phase believed it wrote one.

**Why it matters.** The loop is unbounded and costs money per iteration. The
retry is also mis-attributed: QA passed, developer is what re-ran.

**Where.** The developer prompt (`src/defaults/prompts/developer.md`) plus the
artifact gate in the pipeline executor. Either the agent is not calling
`artifact_write` for its report, or it writes to the worktree root instead of
`{task.projectReportsDir}` (the documentation prompt warns against exactly that
mistake, which suggests it is a known failure mode).

**Fix sketch.** Reproduce first, then: (a) cap consecutive retries of the same
phase for the same reason so a missing artifact cannot loop forever, and (b) fix
the underlying write-path/prompt so the report lands where the gate looks. (a) is
the safety net and should land regardless of (b).

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
  ~44 times in ~7 minutes by the 5s auto-tick.
- **The bundled `smoke` workflow hardcodes `npm install` with `failFatal: true`**,
  so it cannot run against a non-Node repo. `installDependencies()` in
  `src/lib/setup.ts` already guards on a missing `package.json`; the workflow's
  raw `setup:` command does not.
