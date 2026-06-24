# Epic Execution Mode

This guide explains how Foreman runs **epic** tasks: multi-task bodies of work that share one git worktree, execute child tasks in dependency order, and finalize once at the end. It is written for operators and integrators. For formal requirements, see [PRD-2026-007](../PRD/PRD-2026-007-epic-execution-mode.md) and [TRD-2026-007](../TRD/TRD-2026-007-epic-execution-mode.md).

## Why epic mode exists

Standard Foreman dispatch treats every ready task as an independent unit: one worktree, the full phase pipeline (explorer → developer → QA → reviewer → finalize → PR → merge), and merge per task. That model is appropriate for one-off changes but is expensive for TRD-scale work with dozens of related tasks.

Epic execution mode optimizes for **sequential, interdependent work**:

| Standard task pipeline | Epic runner |
|------------------------|-------------|
| One worktree per task | **One worktree per epic** |
| Full phase list every time | **developer → QA per child task** |
| Explorer on every task | No explorer in the task loop (shared context) |
| Merge/push per task | **Single finalize / PR / merge at epic end** |
| Tasks may race on integration branch | Linear commits on one branch |

Target outcome (from PRD-2026-007): run ~40 related tasks in under ~2 hours with high first-pass success, without empty commits or redundant full-suite runs on every child task.

---

## Mental model

```
                    ┌──────────────────────────────────────┐
                    │            Dispatcher                 │
                    │                                       │
   ready epic ─────►│  Has actionable children?             │
                    │       │ yes                           │
                    │       ▼                               │
                    │  Order children (deps / bv / native)  │
                    │       │                               │
                    │       ▼                               │
                    │  Spawn **epic runner** (1 agent slot) │
                    │       │                               │
                    │       │  shared worktree              │
                    │       │  for each child: dev → QA     │
                    │       │  commit on success            │
                    │       │  finalPhases once at end      │
                    │                                       │
   ready task  ────►│  Standard pipeline (unchanged)        │
                    └──────────────────────────────────────┘
```

An epic consumes **one agent slot** regardless of how many child tasks it contains. Multiple epics can run in parallel on separate worktrees, subject to `maxAgents`.

---

## Two epic shapes

The bundled `epic` workflow (`src/defaults/workflows/epic.yaml`) supports two distinct shapes. The dispatcher chooses the path based on whether the epic has **actionable child tasks**.

### 1. Epic with children (epic runner — primary mode)

Use when you have decomposed work under a parent epic:

```
epic-001 (type: epic)
├── task-a (type: task, blocks → …)
├── task-b (type: task, parent: epic-001)
└── task-c (type: chore, parent: epic-001)
```

When `foreman run` dispatches `epic-001`:

1. Children are ordered by blocking dependencies (Postgres-native graph or beads + `bv` fallback).
2. The **epic runner** receives an ordered `epicTasks` list.
3. Each child runs `taskPhases` from the workflow (default: `developer`, `qa`).
4. After each successful child, Foreman commits: `<task title> (<task-id>)`.
5. When all children complete, `finalPhases` run once (default: `finalize`, then PR/merge phases if configured).

### 2. Epic without children (planning pipeline)

If an epic has **no children**, the dispatcher **auto-closes** it with reason `no children (empty epic)` and does not dispatch.

If you intentionally run an epic through the **full skill pipeline** (PRD → TRD → implement → …) without pre-created child tasks, use explicit workflow invocation (e.g. `foreman run task <id> epic`) so it behaves as a **single-agent** pipeline over all phases in `epic.yaml`. That path is for greenfield planning, not for TRD task loops.

---

## Task hierarchy and types

| Type | Role in epic mode |
|------|-------------------|
| `epic` | Container; triggers epic runner when it has actionable children |
| `task`, `bug`, `chore` | Actionable child types included in `epicTasks` ordering |
| `story`, `feature` | Story containers; see [Story grouping](#story-worktree-grouping) |
| `story` / `feature` children | Not included in epic expansion themselves; tasks under stories can collapse |

**Actionable child types** for ordering and story collapse: `task`, `bug`, `chore`.

### Dependencies

Child order respects **blocking** edges:

- **Postgres-native tasks:** `task_dependencies` with type `blocks` via `getBlockingDependencies`.
- **Beads mode:** child `dependencies` in issue detail; external blockers outside the epic are ignored for ordering.

If no order is satisfiable, dispatch fails with `CircularDependencyError`.

**Priority tie-break:** When multiple tasks are ready at the same topological level, lower P-number wins (P0 before P1 before P2).

---

## Dispatch flow (detailed)

### Step 1 — Ready scan

The daemon/dispatcher collects ready seeds like any other task.

### Step 2 — Story worktree grouping (optional)

Before per-seed dispatch, ready **task/bug/chore** children that share the same **story** parent can collapse into one synthetic story seed carrying `__epicTasks`. That group:

- Dispatches as **one epic runner**
- Uses the **story parent’s id** as `worktreeSeedId` (shared worktree)
- Avoids N worktrees for N tasks under the same story

See [Story worktree grouping](#story-worktree-grouping).

### Step 3 — Epic expansion

For seeds with `type === "epic"`, `prepareEpicTasks()`:

1. Counts children (native `getChildren` or beads `show().children`).
2. **0 children** → auto-close, skip dispatch.
3. Loads child details and builds ordered `EpicTask[]`.
4. **0 actionable children** (e.g. only story nodes) → auto-close, skip dispatch.
5. Otherwise → spawn with `epicTasks` passed to the pipeline executor.

### Step 4 — Spawn

The worker/pipeline receives:

- `epicTasks`: ordered `{ seedId, seedTitle, seedDescription? }[]`
- `workflowConfig.taskPhases` / `finalPhases`
- Standard run config (worktree, model, project, etc.)

If `epicTasks` is missing, the executor runs the **single-task** pipeline over all workflow phases (legacy/full epic.yaml path).

---

## Epic runner task loop

Implemented in `executeEpicPipeline()` (`src/orchestrator/pipeline-executor.ts`).

For each child task in order:

1. **Progress** — `RunProgress.epicCurrentTaskId` and `epicTasksCompleted` updated in the run record.
2. **Task status** — child marked `in_progress` (when hooks configured).
3. **Phases** — `runPhaseSequence()` runs `taskPhases` only (default developer → QA).
4. **On QA PASS**
   - Increment completed count; reset consecutive failure streak.
   - **Git commit** in the shared worktree: `Title (task-id)`.
   - Child marked `completed`.
   - Per-task cost recorded in `epicCostByTask`.
5. **On QA FAIL** (after retries exhausted)
   - Increment failed count; increment consecutive failure streak.
   - **Circuit breakers** evaluated (see below).
   - Optional **bug bead** created for traceability; child marked `failed`.
   - `onError: continue` → skip to next child; `onError: stop` → halt epic.

After the loop:

- If `finalPhases` configured and at least one child succeeded, run finalize (and downstream PR/merge phases) **once**.
- Session log and pipeline completion callbacks fire with accumulated progress.

### QA retry semantics

Per-task QA uses the workflow phase’s `retryOnFail` / `retryWith` (default in `epic.yaml`: QA retries developer up to 2 times). In epic mode, exhausted retries mark the **task** failed; they do not silently continue as success.

### Developer vs QA test scope

Epic children should follow the [Test Execution Policy](./test-execution-policy.md):

- **Developer:** targeted verification only; no full suite.
- **QA:** narrowest proof first; full suite only with justification.
- **Finalize:** full suite only when target branch drifted after QA.

The validation ledger (`VALIDATION_LEDGER.md`) lets downstream phases skip redundant runs.

---

## Workflow configuration

Bundled defaults: `src/defaults/workflows/epic.yaml`.

### Epic-specific top-level keys

| Key | Default | Purpose |
|-----|---------|---------|
| `task_type` | `epic` | Routes workflow by task type |
| `taskPhases` | `[developer, qa]` | Phases repeated **per child task** |
| `finalPhases` | `[finalize]` | Phases run **once** after the task loop |
| `onError` | `stop` | `stop` halts epic on child failure; `continue` skips failed children |
| `epicMaxBudgetUsd` | `50` | Cumulative run cost ceiling; checked after each failed task |
| `maxConsecutiveEpicTaskFailures` | `3` | Halt after N consecutive child failures |
| `taskTimeout` | `300` | Per-task timeout (minutes) |
| `merge` | `auto` | Merge behavior after PR phases |

Example override in a project workflow copy:

```yaml
name: epic
task_type: epic
onError: continue
epicMaxBudgetUsd: 75
maxConsecutiveEpicTaskFailures: 5
taskPhases:
  - developer
  - qa
finalPhases:
  - finalize
  - create-pr
  - pr-wait
  - merge
```

Install overrides under `.foreman/workflows/epic.yaml` or `~/.foreman/workflows/epic.yaml`. See [Workflow YAML Reference](../workflow-yaml-reference.md).

---

## Circuit breakers

Epic-level guardrails prevent runaway spend and failure streaks. Both trigger in the **failure branch** after a child task fails (post retry exhaustion).

### Budget ceiling (`epicMaxBudgetUsd`)

When `totalProgress.costUsd >= epicMaxBudgetUsd`:

- Epic halts immediately.
- Run marked stuck with reason `epic-budget-exceeded`.
- No further child tasks execute.

Cost is **cumulative across all phases and all children** in the epic run.

### Consecutive failures (`maxConsecutiveEpicTaskFailures`)

When N consecutive child tasks fail (without an intervening success):

- Epic halts with reason `epic-consecutive-failures`.
- A successful child **resets** the streak to zero.

These are independent of `onError`: a halt via circuit breaker stops the epic even if `onError: continue`.

---

## Story worktree grouping

When several **ready** tasks share the same story parent, the dispatcher can collapse them into one dispatch:

```
Ready queue:
  task-1 (parent: story-A)
  task-2 (parent: story-A)
  task-3 (parent: story-B)

After collapse:
  story-A synthetic seed + __epicTasks: [task-1, task-2]
  story-B synthetic seed + __epicTasks: [task-3]
```

Effects:

- **One worktree** per story group (`worktreeSeedId = story parent id`).
- **One epic runner** executes the grouped tasks in dependency order inside the executor loop.
- Duplicate story children already scheduled in the same cycle are deduplicated.

Story detection: parent `type` is `story` or `feature`, or labels include `kind:story`.

Implementation: `collapseReadyStoryChildren()` in `src/orchestrator/dispatch-planning.ts`.

---

## Resume and crash recovery

Epic runs can resume without re-doing completed children.

### Git-log resume (current)

On epic start, the executor parses `git log --oneline` in the worktree and extracts task IDs from commit messages matching `(<task-id>)` at the end of the line—the same format used when committing successful tasks.

Already-committed tasks are **skipped**; the loop continues from the first remaining child.

Logs include:

```text
[EPIC] Resuming from task 4 of 12 (3 completed)
```

### Limitations

- Resume depends on **commit messages preserving task IDs**. Do not rewrite history in the epic worktree unless you know which tasks to re-run.
- Session/conversation continuity is best-effort via the agent session; very long epics may hit token limits (see PRD REQ-008).
- Persisted `completedTaskIds` in Postgres progress is written during the run but git-log detection is the primary resume source today.

To force a clean re-run: remove or reset the epic worktree, reset child task statuses, and re-dispatch.

---

## Progress and observability

During an epic run, `RunProgress` includes:

| Field | Meaning |
|-------|---------|
| `epicTaskCount` | Total children in this run (after resume filtering) |
| `epicTasksCompleted` | Successfully finished children |
| `epicCurrentTaskId` | Child currently executing |
| `epicCostByTask` | Per-child cost map (USD) |
| `costUsd` | Cumulative run cost (feeds budget breaker) |

Inspect via run logs, daemon APIs, and board/watch UIs where epic fields are surfaced.

Phase reports for each child land under the runtime report directory (`{task.projectReportsDir}`), same as standard tasks.

---

## Operator cookbook

### Create an epic with children (Postgres-native)

```bash
# 1. Create the epic
foreman task create \
  --title "Implement TRD-2026-042 widgets" \
  --type epic \
  --priority high

# 2. Create child tasks
foreman task create --title "Add widget model" --type task
foreman task create --title "Add widget API"   --type task

# 3. Link children to epic (parent-child) and order work (blocks)
foreman task dep add <epic-id> <model-task-id> --type parent-child
foreman task dep add <epic-id> <api-task-id>   --type parent-child
foreman task dep add <model-task-id> <api-task-id> --type blocks   # model before API

# 4. Approve children (and epic when ready)
foreman task approve <model-task-id>
foreman task approve <api-task-id>
foreman task approve <epic-id>

# 5. Dispatch
foreman run --project my-project
# or target one epic:
foreman run --task <epic-id> --workflow epic
```

For large TRD breakdowns, prefer `foreman sling` or `foreman plan` to generate the hierarchy and blocking edges automatically.

### Dry-run dispatch

```bash
foreman run --dry-run --project my-project
```

Confirms epic expansion, ordering, and skip/close decisions without spawning agents.

### Retry a stuck epic

```bash
foreman retry <epic-id> --dispatch
```

Resume semantics apply if the worktree still contains per-task commits.

### Tune guardrails for a large epic

Copy `epic.yaml` to `.foreman/workflows/epic.yaml` and adjust:

```yaml
epicMaxBudgetUsd: 120
maxConsecutiveEpicTaskFailures: 5
onError: continue   # finish remaining children even if one fails
```

---

## Troubleshooting

| Symptom | Likely cause | What to do |
|---------|--------------|------------|
| Epic auto-closed, never ran | No children or no actionable children | Add task/bug/chore children; check parent links |
| Epic ran full PRD→TRD pipeline once | No `epicTasks` passed (empty epic or wrong workflow path) | Ensure children exist; use dispatcher path not manual single-agent run |
| Wrong task order | Missing or incorrect `blocks` deps | Fix dependencies; check circular deps error |
| Epic halted: budget exceeded | Cumulative cost ≥ `epicMaxBudgetUsd` | Raise budget in workflow or reduce model cost; inspect `epicCostByTask` |
| Epic halted: consecutive failures | N failures in a row | Fix failing child; retry; check QA reports |
| Resume skipped wrong tasks | Commit messages missing `(task-id)` | Preserve commit format; or reset worktree |
| Story tasks not grouped | Children not ready simultaneously | Grouping only applies to ready seeds in same dispatch cycle |
| Full test suite ran 40 times | Prompt/policy drift | Enforce [Test Execution Policy](./test-execution-policy.md); check `VALIDATION_LEDGER.md` |

---

## Architecture reference

| Component | Responsibility |
|-----------|----------------|
| `dispatcher.ts` | Epic detection, story collapse, `prepareEpicTasks`, spawn with `epicTasks` |
| `dispatch-planning.ts` | Story grouping, `buildDispatchSeedPlan`, native story parent walk |
| `task-ordering.ts` | `getNativeEpicTaskOrder`, topological sort, `bv` ordering |
| `pipeline-executor.ts` | `executeEpicPipeline`, resume, circuit breakers, per-task commits |
| `postgres-adapter.ts` | `getParentTaskId`, `listChildTaskIds`, `listBlockingDependencyIds` |
| `workflow-loader.ts` | Parses `epicMaxBudgetUsd`, `maxConsecutiveEpicTaskFailures`, `taskPhases` |
| `epic.yaml` | Default phases, models, guardrails |

### Related tests

Focused regression suite (PR #25):

```bash
npx vitest run \
  src/orchestrator/__tests__/dispatcher-epic.test.ts \
  src/orchestrator/__tests__/dispatcher-story-grouping.test.ts \
  src/orchestrator/__tests__/dispatch-planning.test.ts \
  src/orchestrator/__tests__/pipeline-epic-loop.test.ts \
  src/orchestrator/__tests__/task-ordering.test.ts \
  src/lib/__tests__/workflow-loader.test.ts
```

Mutation testing (optional, tight scope):

```bash
npx stryker run stryker.epic-pr.config.json
```

---

## Comparison checklist: when to use epic mode

Use an **epic** when:

- You have **many related tasks** with explicit dependencies
- You want **one integration branch** and one merge at the end
- Tasks share codebase context (explorer/reviewer overhead is wasteful)
- You accept **sequential** execution within the epic

Use a **standard task/feature workflow** when:

- The change is isolated and needs full explorer/reviewer/PR scrutiny
- Parallel merge of independent work is desired
- The work is a single unit without decomposition

---

## Further reading

- [PRD-2026-007: Epic Execution Mode](../PRD/PRD-2026-007-epic-execution-mode.md) — requirements and acceptance criteria
- [TRD-2026-007: Epic Execution Mode](../TRD/TRD-2026-007-epic-execution-mode.md) — implementation specification
- [Workflow YAML Reference](../workflow-yaml-reference.md) — phase and workflow fields
- [Test Execution Policy](./test-execution-policy.md) — avoiding redundant test runs across phases
- [User Guide](../user-guide.md) — day-to-day Foreman operation
