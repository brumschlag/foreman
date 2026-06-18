---
document_id: TRD-2026-016
prd_reference: (none — greenfield)
version: 1.0.0
status: Draft
date: 2026-06-18
design_readiness_score: 4.25
---

# TRD-2026-016: Milestone Layer and Quality Gates

## Architecture Decision

### Chosen Approach: Milestone as a First-Class Task Type with Completion Watcher

Add `milestone` as a first-class task type sitting above `epic` in the hierarchy. A milestone
groups epics via `parent-child` dependency edges, watches for their completion, and runs its own
pipeline once all children are closed/merged. The milestone pipeline executes quality gates
(complexity, CRAP score, coverage) and mutation testing across the full change set of all child
epics.

Per-task quality gates (complexity + CRAP score) are added as a new `quality-gate` phase inserted
after `qa` in the standard workflow. Mutation testing is expensive and runs only at milestone
completion.

**Key insight:** The DB schema (`task_dependencies`, `tasks.type = varchar(32)`) already supports
this with zero schema migrations. The dispatcher already has an epic detection branch — the same
pattern extends to milestones. The existing `bash:` phase type handles shell-based metric
collection cleanly.

### Alternatives Considered

| Option | Pros | Cons | Rejected Because |
|--------|------|------|------------------|
| A: Milestone as project-level metadata only | No schema change | Can't track status, can't run pipeline | No completion signaling, no quality gate execution |
| B: Separate milestones table | Clean separation | Schema migration, new adapter methods | Unnecessary — tasks table + type field already works |
| C: Quality gate as external CI step | Zero foreman changes | Requires CI setup, out of band | Breaks developer feedback loop; findings arrive too late |

### Hierarchy

```
Project  (projects table — registered repo)
  └── Milestone  (tasks.type = 'milestone')
        └── Epic  (tasks.type = 'epic')
              └── Story  (tasks.type = 'story', parent-child edge, parsed from TRD)
                    └── Task / Bug / Chore  (leaf — gets a pipeline run)
```

### Architecture Diagram

```
Dispatcher
  │
  ├── type=task/bug/chore  → standard pipeline
  │                            phases: explorer→developer→quality-gate→qa→reviewer→finalize
  │
  ├── type=epic            → epic runner (existing TRD-2026-007)
  │                            taskPhases: [developer, quality-gate, qa]
  │                            finalPhases: [finalize]
  │
  └── type=milestone       → milestone watcher (new)
        │  waits until all child epics closed/merged
        └── milestone pipeline (runs once)
              phases: acceptance-check→mutation-test→quality-gate-final→milestone-summary
```

### Component Boundaries

| Component | File | Responsibility |
|-----------|------|----------------|
| **Dispatcher** | `dispatcher.ts` | Detect milestone tasks; skip dispatch until all children closed; trigger milestone pipeline when ready |
| **Milestone Completion Watcher** | `milestone-watcher.ts` (new) | Poll or event-driven check: when any task closes, check if its parent milestone's children are all done; if so, transition milestone to `ready` |
| **Pipeline Executor** | `pipeline-executor.ts` | No change — milestone runs as a standard single-task pipeline |
| **Quality Gate Phase** | `quality-gate-runner.ts` (new) | Collect lizard complexity + vitest coverage for changed files; compute CRAP scores; emit structured JSON report |
| **Milestone Workflow** | `workflows/milestone.yaml` (new) | phases: acceptance-check, mutation-test, quality-gate-final, milestone-summary |
| **Per-task Quality Gate** | `workflows/feature.yaml` + others | Add `quality-gate` phase after `qa` across all standard workflows |
| **Prompts** | `prompts/default/quality-analyst.md`, `prompts/default/acceptance-check.md`, `prompts/default/milestone-summary.md` (new) | LLM interpretation of metric reports |
| **Workflow Loader** | `workflow-loader.ts` | No change needed — milestone.yaml uses existing phase schema |

### Data Flow — Per-task Quality Gate

```
1. Developer commits code in worktree
2. QA phase passes (verdict PASS)
3. quality-gate bash: phase runs:
   a. git diff --name-only <base>..<HEAD> -- '*.ts' '*.tsx' → changed files
   b. lizard <changed files> --CCN 10 -w → cyclomatic complexity per function
   c. npx vitest run --coverage --reporter=json → coverage data
   d. compute CRAP = CC × (1 - coverage)² per function
   e. write QUALITY_METRICS.md to worktree root
4. quality-analyst LLM phase reads QUALITY_METRICS.md:
   a. identifies violations (CC > 10 OR CRAP > 30)
   b. verdict: PASS if no violations, FAIL if any
   c. writes QUALITY_REPORT.md with specific actionable findings
5. On FAIL → retryWith: developer (developer sees QUALITY_REPORT.md in context)
6. On PASS → pipeline continues to reviewer
```

### Data Flow — Milestone Completion and Pipeline

```
1. Epics close one by one as their pipelines complete
2. MilestoneWatcher fires after each task-close event:
   a. find parent milestone via task_dependencies (parent-child, to_task_id = milestone)
   b. listChildTasks(milestoneId) → check all status IN ('closed', 'merged')
   c. if all done → pg.approveTask(milestoneId) → status = 'ready'
3. Dispatcher picks up milestone (type='milestone', status='ready')
4. Milestone pipeline runs:
   a. acceptance-check: LLM reads original spec + all child epic QUALITY_REPORTs
      verdict: PASS if all acceptance criteria met
   b. mutation-test bash: phase:
      collect all changed files across child epics (git log range)
      npx stryker run --mutate <changed-files>
      write MUTATION_REPORT.md (score, surviving mutants)
   c. quality-gate-final: LLM reads MUTATION_REPORT.md
      verdict PASS if mutation score >= threshold (default 70%)
   d. milestone-summary: generate human-readable completion report
5. Milestone transitions to 'closed'
```

---

## Requirements

| REQ | Description |
|-----|-------------|
| REQ-001 | `milestone` is a valid task type; milestone tasks are created via `tasks.create` or `foreman task create --type milestone` |
| REQ-002 | Milestones link to child epics via `parent-child` dependency edges |
| REQ-003 | Dispatcher skips milestones until all child epics are closed/merged |
| REQ-004 | When all children close, milestone transitions to `ready` automatically |
| REQ-005 | Milestone pipeline runs once: acceptance-check → mutation-test → quality-gate-final → milestone-summary |
| REQ-006 | Per-task quality gate runs after QA on every leaf task (feature/bug/chore workflows) |
| REQ-007 | Quality gate collects cyclomatic complexity (lizard) and coverage (vitest) for changed files only |
| REQ-008 | CRAP score computed as CC × (1 - line_coverage)² per function |
| REQ-009 | Quality gate verdict FAIL loops back to developer with specific violation list |
| REQ-010 | Quality gate thresholds are configurable: default CC > 10, CRAP > 30 |
| REQ-011 | Mutation testing (Stryker) runs only at milestone pipeline — not per-task |
| REQ-012 | Mutation testing scoped to files changed across all child epics in the milestone |
| REQ-013 | Milestone pipeline fails (quality-gate-final verdict) if mutation score < threshold (default 70%) |
| REQ-014 | `foreman status` shows milestone progress: N/M epics complete |
| REQ-015 | `foreman doctor` validates no two workflows declare `task_type: milestone` |
| REQ-016 | Quality gate is skipped (continueOnFail) for doc-only changes (no .ts/.tsx files changed) |

---

## Master Task List

### Sprint 1: Milestone Type and Completion Watcher

#### TRD-001: Add milestone detection to dispatcher
**2h** | [satisfies REQ-001, REQ-003]
- Implementation ACs:
  - Given a task with `type='milestone'` and `status='ready'`, when the dispatcher's `listDispatchableReadyTasks` runs, then the milestone is excluded from standard dispatch
  - Given `type='milestone'`, when the dispatcher encounters it, then it routes to `spawnMilestonePipeline()` (new method)
  - Given no `type='milestone'` tasks, then dispatcher behavior is unchanged (no regression)

#### TRD-001-TEST: Unit tests for milestone dispatch routing
**1h** | [verifies TRD-001] [depends: TRD-001]
- Test: milestone type excluded from standard task dispatch
- Test: milestone routes to milestone pipeline path
- Test: non-milestone tasks unaffected

#### TRD-002: Implement MilestoneWatcher
**3h** | [satisfies REQ-003, REQ-004]
- New file: `src/orchestrator/milestone-watcher.ts`
- Implementation ACs:
  - Given any task transitions to `closed` or `merged`, when `MilestoneWatcher.onTaskClose(taskId)` is called, then it queries `task_dependencies` for a `parent-child` edge where `to_task_id` is a milestone
  - Given a parent milestone found, when all sibling children have `status IN ('closed','merged')`, then `pg.approveTask(milestoneId)` is called setting `status='ready'`
  - Given not all children are done, then no action is taken
  - Given no parent milestone, then no action is taken

#### TRD-002-TEST: Unit tests for MilestoneWatcher
**2h** | [verifies TRD-002] [depends: TRD-002]
- Test: last epic closes → milestone transitions to ready
- Test: one epic still open → milestone stays as-is
- Test: no parent milestone → no action
- Test: milestone with 1 child that closes → transitions immediately

#### TRD-003: Wire MilestoneWatcher into task-close events
**2h** | [satisfies REQ-004] [depends: TRD-002]
- Implementation ACs:
  - Given `pipeline-executor.ts` transitions a task to `merged` or `closed`, when the transition occurs, then `MilestoneWatcher.onTaskClose(taskId)` is called
  - Given `postgres-adapter.ts` `closeTask()` is called directly (e.g. from CLI), when close occurs, then the watcher fires via a Postgres NOTIFY trigger or adapter hook
  - Given watcher throws, when the error occurs, then it is logged and does not propagate (milestone check is non-fatal)

#### TRD-003-TEST: Integration tests for watcher wiring
**2h** | [verifies TRD-003] [depends: TRD-003]
- Test: epic completion in pipeline-executor fires watcher
- Test: direct closeTask() fires watcher
- Test: watcher error does not fail the pipeline

#### TRD-004: `milestone.yaml` workflow
**2h** | [satisfies REQ-005]
- New file: `src/defaults/workflows/milestone.yaml`
- Implementation ACs:
  - Given `task_type: milestone` declared, when a milestone is dispatched, then phases run in order: acceptance-check → mutation-test → quality-gate-final → milestone-summary
  - `mutation-test` and `quality-gate-final` use `continueOnFail: true` so a score below threshold is reported but does not hard-fail the pipeline
  - `acceptance-check` uses `verdict: true`; FAIL retries once with `retryWith: acceptance-check` to allow LLM re-evaluation
  - All phases use `models.default: sonnet`

#### TRD-004-TEST: Tests for milestone workflow loading
**1h** | [verifies TRD-004] [depends: TRD-004]
- Test: milestone.yaml parses without error
- Test: task_type=milestone declared, no duplicate
- Test: all 4 phases present in correct order

---

### Sprint 2: Per-Task Quality Gate

#### TRD-005: Quality gate bash: phase — metric collection
**3h** | [satisfies REQ-006, REQ-007, REQ-008, REQ-016]
- New file: `docker/scripts/quality-gate.sh` (reusable across workflows)
- Implementation ACs:
  - Given changed `.ts`/`.tsx` files exist, when the script runs, then it calls `lizard <files> --CCN 10 -w --json` and captures output
  - Given `npx vitest run --coverage --reporter=json` completes, when the script processes output, then it extracts per-file line coverage percentages
  - Given both lizard and coverage data, when CRAP is computed, then `CRAP = CC × (1 - line_coverage)²` is written per-function to `QUALITY_METRICS.md`
  - Given no `.ts`/`.tsx` files changed (doc-only), when the script detects this, then it writes `QUALITY_METRICS.md` with `doc-only: true` and exits 0
  - Given `lizard` not installed, when the script detects this, then it writes a warning to QUALITY_METRICS.md and exits 0 (tool missing is non-fatal)

#### TRD-005-TEST: Unit tests for quality-gate script
**2h** | [verifies TRD-005] [depends: TRD-005]
- Test: changed TS files → lizard called with correct args
- Test: coverage JSON → correct per-file extraction
- Test: CRAP formula correctness (CC=5, cov=0.8 → CRAP=5×0.04=0.2)
- Test: doc-only → QUALITY_METRICS.md has doc-only flag
- Test: missing lizard → warning written, exit 0

#### TRD-006: `quality-analyst.md` prompt
**1h** | [satisfies REQ-009, REQ-010]
- New file: `src/defaults/prompts/default/quality-analyst.md`
- Implementation ACs:
  - Given QUALITY_METRICS.md with `doc-only: true`, when the LLM reads it, then it writes `## Verdict: PASS\nReason: documentation-only change` and stops
  - Given violations exist (CC > 10 or CRAP > 30), when the LLM analyzes, then QUALITY_REPORT.md lists each violation as: `<file>:<function> CC=N CRAP=N.N — <actionable suggestion>`
  - Given no violations, when analysis completes, then `## Verdict: PASS` is written
  - Given violations, when analysis completes, then `## Verdict: FAIL` with violation list is written
  - Thresholds are stated in the prompt (CC > 10, CRAP > 30) and can be overridden by user prompt override

#### TRD-007: Wire quality-gate phase into standard workflows
**2h** | [satisfies REQ-006] [depends: TRD-005, TRD-006]
- Modify: `src/defaults/workflows/feature.yaml`, `bug.yaml`, `task.yaml`, `chore.yaml`
- Modify: `docker/no-pr.yaml`
- Implementation ACs:
  - Given each workflow, when updated, then a `quality-gate` bash: phase appears after `qa` and before `reviewer`
  - Given a `quality-analyst` LLM phase, when it follows the bash: phase, then it reads QUALITY_METRICS.md, has `verdict: true`, `retryWith: developer`, `retryOnFail: 1`
  - Given the epic workflow's `taskPhases`, when updated, then `quality-gate` and `quality-analyst` are included after `qa`

#### TRD-007-TEST: Integration tests for quality gate in pipeline
**2h** | [verifies TRD-007] [depends: TRD-007]
- Test: feature workflow contains quality-gate phase after qa
- Test: quality-gate FAIL → developer retry with QUALITY_REPORT.md in context
- Test: quality-gate PASS → pipeline continues to reviewer
- Test: doc-only change → quality-gate PASS immediately

---

### Sprint 3: Milestone Pipeline Phases

#### TRD-008: `acceptance-check.md` prompt
**2h** | [satisfies REQ-005]
- New file: `src/defaults/prompts/default/acceptance-check.md`
- Implementation ACs:
  - Given the milestone task's description contains the original spec/acceptance criteria, when the LLM reads it, then it checks each criterion against the current codebase state
  - Given all criteria met, when analysis completes, then `## Verdict: PASS` written to ACCEPTANCE_REPORT.md
  - Given unmet criteria, when analysis completes, then `## Verdict: FAIL` with per-criterion status written
  - The prompt instructs the LLM to read child epic QUALITY_REPORTs from `{task.projectReportsDir}/../*/QUALITY_REPORT.md` for supporting evidence

#### TRD-009: Mutation test bash: phase
**3h** | [satisfies REQ-011, REQ-012, REQ-013]
- New file: `docker/scripts/mutation-test.sh`
- Implementation ACs:
  - Given a milestone run, when the script executes, then it determines changed files as `git diff --name-only <upstream-base>..HEAD -- '*.ts' '*.tsx'` excluding test files
  - Given changed files, when `npx stryker run` executes, then `--mutate <files>` scopes mutation to those files only
  - Given Stryker completes, when results are parsed, then mutation score, total mutants, killed, and surviving mutant list are written to MUTATION_REPORT.md
  - Given mutation score < threshold (default 70), when written, then MUTATION_REPORT.md includes `## Threshold: FAIL`
  - Given mutation score >= threshold, when written, then `## Threshold: PASS`
  - Given Stryker not installed or times out (> 30 min), when detected, then MUTATION_REPORT.md notes the skip and exits 0

#### TRD-009-TEST: Unit tests for mutation test script
**1h** | [verifies TRD-009] [depends: TRD-009]
- Test: changed files correctly scoped (excludes test files)
- Test: score < 70 → FAIL threshold in report
- Test: score >= 70 → PASS threshold
- Test: Stryker timeout → graceful skip

#### TRD-010: `milestone-summary.md` prompt
**1h** | [satisfies REQ-005]
- New file: `src/defaults/prompts/default/milestone-summary.md`
- Implementation ACs:
  - Given all phase reports exist, when the LLM runs, then MILESTONE_SUMMARY.md includes: milestone title, epic count, total tasks completed, total cost, acceptance verdict, mutation score, quality gate pass rate, and a human-readable summary paragraph
  - Given any phase had FAIL verdict, when summarizing, then the summary highlights which criteria failed

#### TRD-011: Milestone progress in `foreman status`
**2h** | [satisfies REQ-014] [depends: TRD-002]
- Modify: `src/cli/commands/status.ts` or equivalent status display
- Implementation ACs:
  - Given an active milestone, when `foreman status` runs, then output includes `[MILESTONE] <title>: N/M epics complete`
  - Given a milestone in its pipeline phase, when status runs, then output shows current phase name

#### TRD-011-TEST: Tests for milestone status display
**1h** | [verifies TRD-011] [depends: TRD-011]
- Test: partial milestone shows N/M count
- Test: milestone in pipeline shows phase name
- Test: completed milestone shows closed

---

### Sprint 4: Tooling and Polish

#### TRD-012: `lizard` install in Docker image
**1h** | [satisfies REQ-007] [depends: TRD-005]
- Modify: `docker/pipeline.Dockerfile`
- Add: `RUN pip3 install lizard` (or system package)
- Implementation ACs:
  - Given the Docker image, when built, then `lizard --version` exits 0
  - Given the image, when `which lizard` runs, then a path is returned

#### TRD-013: Stryker config in Docker image
**1h** | [satisfies REQ-011] [depends: TRD-009]
- Modify: `docker/pipeline.Dockerfile`
- Add default `stryker.config.json` baked into image
- Implementation ACs:
  - Given the Docker image, when built, then `npx stryker --version` exits 0
  - Given no project-level stryker.config, when mutation-test.sh runs, then the bundled config is used

#### TRD-014: Quality gate threshold configuration
**1h** | [satisfies REQ-010] [depends: TRD-005, TRD-006]
- Implementation ACs:
  - Given `FOREMAN_QUALITY_CC_THRESHOLD` env var set, when quality-gate.sh runs, then it uses that value instead of default (10)
  - Given `FOREMAN_QUALITY_CRAP_THRESHOLD` env var set, when quality-analyst.md LLM runs, then the prompt includes the custom threshold
  - Given `FOREMAN_MUTATION_THRESHOLD` env var set, when mutation-test.sh runs, then that score is used as pass/fail threshold

#### TRD-015: `foreman doctor` validates milestone workflow uniqueness
**1h** | [satisfies REQ-015] [depends: TRD-004]
- Implementation ACs:
  - Given two workflows both declare `task_type: milestone`, when `foreman doctor` runs, then it reports a duplicate task_type error
  - This is already handled by `validateWorkflowTaskTypes()` in `workflow-loader.ts` — just verify milestone.yaml participates

---

## 3. Sprint Planning

### 3.1 Sprint 1: Milestone Type and Completion Watcher (~13h)

#### Story 1.1: Dispatcher and Watcher

| ID | Task | Est. | Deps |
|----|------|------|------|
| TRD-001 | Add milestone detection to dispatcher — exclude milestone type from standard dispatch, route to spawnMilestonePipeline() | 2h | |
| TRD-001-TEST | Unit tests for milestone dispatch routing — milestone excluded from standard dispatch, routes to milestone path, non-milestone tasks unaffected | 1h | TRD-001 |
| TRD-002 | Implement MilestoneWatcher in src/orchestrator/milestone-watcher.ts — onTaskClose() queries parent-child edges, approves milestone when all children closed/merged | 3h | |
| TRD-002-TEST | Unit tests for MilestoneWatcher — last epic closes triggers ready, one epic still open no action, no parent milestone no action, single child closes immediately | 2h | TRD-002 |
| TRD-003 | Wire MilestoneWatcher into task-close events in pipeline-executor.ts and postgres-adapter.ts closeTask() | 2h | TRD-002 |
| TRD-003-TEST | Integration tests for watcher wiring — epic completion in pipeline-executor fires watcher, direct closeTask fires watcher, watcher error does not fail pipeline | 2h | TRD-003 |

#### Story 1.2: Milestone Workflow

| ID | Task | Est. | Deps |
|----|------|------|------|
| TRD-004 | Create src/defaults/workflows/milestone.yaml — task_type milestone, phases: acceptance-check, mutation-test, quality-gate-final, milestone-summary | 2h | |
| TRD-004-TEST | Tests for milestone workflow loading — parses without error, task_type milestone declared no duplicate, all 4 phases present in correct order | 1h | TRD-004 |

### 3.2 Sprint 2: Per-Task Quality Gate (~13h)

#### Story 2.1: Quality Gate Implementation

| ID | Task | Est. | Deps |
|----|------|------|------|
| TRD-005 | Implement quality-gate.sh bash phase — lizard complexity + vitest coverage on changed TS files, compute CRAP = CC x (1 - coverage)^2, write QUALITY_METRICS.md, doc-only skip, missing tool graceful fallback | 3h | |
| TRD-005-TEST | Unit tests for quality-gate script — changed TS files calls lizard, coverage JSON extraction, CRAP formula correctness, doc-only flag, missing lizard warning | 2h | TRD-005 |
| TRD-006 | Create src/defaults/prompts/default/quality-analyst.md — reads QUALITY_METRICS.md, doc-only pass, violations list CC>10 or CRAP>30, verdict PASS/FAIL | 1h | TRD-005 |

#### Story 2.2: Workflow Integration

| ID | Task | Est. | Deps |
|----|------|------|------|
| TRD-007 | Wire quality-gate bash phase and quality-analyst LLM phase into feature.yaml, bug.yaml, task.yaml, chore.yaml after qa phase; add to epic taskPhases | 2h | TRD-005, TRD-006 |
| TRD-007-TEST | Integration tests for quality gate in pipeline — feature workflow contains quality-gate after qa, FAIL retries developer with QUALITY_REPORT in context, PASS continues to reviewer, doc-only passes immediately | 2h | TRD-007 |

### 3.3 Sprint 3: Milestone Pipeline Phases (~12h)

#### Story 3.1: Acceptance and Mutation

| ID | Task | Est. | Deps |
|----|------|------|------|
| TRD-008 | Create src/defaults/prompts/default/acceptance-check.md — reads spec from milestone description, checks criteria against codebase, reads child epic QUALITY_REPORTs, verdict PASS/FAIL | 2h | TRD-004 |
| TRD-009 | Implement src/scripts/mutation-test.sh — git diff changed files across milestone, npx stryker run scoped to changed files, MUTATION_REPORT.md with score and threshold PASS/FAIL, 30min timeout graceful skip | 3h | |
| TRD-009-TEST | Unit tests for mutation test script — changed files scoped excludes test files, score < 70 FAIL threshold, score >= 70 PASS, Stryker timeout graceful skip | 1h | TRD-009 |

#### Story 3.2: Summary and Observability

| ID | Task | Est. | Deps |
|----|------|------|------|
| TRD-010 | Create src/defaults/prompts/default/milestone-summary.md — reads all phase reports, writes MILESTONE_SUMMARY.md with epic count, tasks completed, cost, acceptance verdict, mutation score, quality gate pass rate | 1h | TRD-004 |
| TRD-011 | Add milestone progress to foreman status — MILESTONE title N/M epics complete, current phase name when in pipeline | 2h | TRD-002 |
| TRD-011-TEST | Tests for milestone status display — partial milestone shows N/M count, milestone in pipeline shows phase name, completed milestone shows closed | 1h | TRD-011 |

### 3.4 Sprint 4: Tooling and Polish (~4h)

#### Story 4.1: Tooling

| ID | Task | Est. | Deps |
|----|------|------|------|
| TRD-012 | Install lizard in local dev environment and document in README — pip3 install lizard, verify lizard --version exits 0 | 1h | TRD-005 |
| TRD-013 | Add Stryker configuration — stryker.config.json at repo root with sensible defaults for TypeScript, document mutation test invocation | 1h | TRD-009 |
| TRD-014 | Quality gate threshold configuration via env vars — FOREMAN_QUALITY_CC_THRESHOLD, FOREMAN_QUALITY_CRAP_THRESHOLD, FOREMAN_MUTATION_THRESHOLD read by scripts and prompts | 1h | TRD-005, TRD-006 |
| TRD-015 | Verify foreman doctor validates milestone workflow uniqueness — confirm milestone.yaml participates in validateWorkflowTaskTypes() duplicate detection | 1h | TRD-004 |

**Total: ~42h estimated across 28 tasks (15 implementation + 13 test)**

---

## Acceptance Criteria Traceability

| REQ | Description | Implementation Tasks | Test Tasks |
|-----|-------------|---------------------|------------|
| REQ-001 | milestone task type | TRD-001 | TRD-001-TEST |
| REQ-002 | milestone-epic parent-child edges | TRD-002 | TRD-002-TEST |
| REQ-003 | dispatcher skips milestone until children done | TRD-001, TRD-002 | TRD-001-TEST, TRD-002-TEST |
| REQ-004 | auto-transition to ready when children close | TRD-002, TRD-003 | TRD-002-TEST, TRD-003-TEST |
| REQ-005 | milestone pipeline phases | TRD-004, TRD-008, TRD-009, TRD-010 | TRD-004-TEST, TRD-009-TEST |
| REQ-006 | per-task quality gate after QA | TRD-005, TRD-007 | TRD-005-TEST, TRD-007-TEST |
| REQ-007 | complexity + coverage on changed files | TRD-005 | TRD-005-TEST |
| REQ-008 | CRAP score formula | TRD-005, TRD-006 | TRD-005-TEST |
| REQ-009 | quality gate FAIL → developer retry | TRD-006, TRD-007 | TRD-007-TEST |
| REQ-010 | configurable thresholds | TRD-014 | — |
| REQ-011 | mutation testing at milestone only | TRD-009 | TRD-009-TEST |
| REQ-012 | mutation scope = all milestone changes | TRD-009 | TRD-009-TEST |
| REQ-013 | mutation score gate | TRD-009 | TRD-009-TEST |
| REQ-014 | milestone progress in status | TRD-011 | TRD-011-TEST |
| REQ-015 | doctor validates milestone uniqueness | TRD-015 | — |
| REQ-016 | doc-only skips quality gate | TRD-005, TRD-006 | TRD-005-TEST, TRD-007-TEST |

---

## Design Readiness Scorecard

| Dimension | Score (1-5) | Notes |
|-----------|-------------|-------|
| Architecture Completeness | 4 | All components defined; MilestoneWatcher event wiring depends on whether postgres-adapter exposes close hooks cleanly |
| Task Coverage | 5 | Every REQ has implementation + test tasks; traceability complete |
| Dependency Clarity | 4 | Two independent critical paths (TRD-002 milestone watcher, TRD-005 quality gate); no circular deps |
| Estimate Confidence | 4 | TRD-002 (3h) and TRD-009 (3h) are highest risk; both are greenfield but bounded scope |
| **Overall** | **4.25** | **PASS** |

### Issues Identified and Resolved

1. **Watcher trigger mechanism**: The cleanest approach is an adapter hook in `closeTask()` and `mergeTask()` in `postgres-adapter.ts` that calls `MilestoneWatcher.onTaskClose()`. A Postgres NOTIFY/LISTEN approach is an alternative but adds complexity. Adapter hook is simpler and sufficient given the dispatcher already polls.

2. **Coverage for changed files only**: `vitest --coverage` runs the full test suite and produces a full coverage report. The quality-gate script filters the output to changed files only after the fact — coverage is still accurate since tests across the whole suite run (correct behavior).

3. **Mutation test scope across epics**: Collecting "all changed files in this milestone" requires knowing the base commit before any epic work started. The script uses `git merge-base upstream/main HEAD` as the base — this correctly captures all changes across all merged epic branches.

4. **CRAP score without coverage data**: If vitest fails or the project has no coverage configured, the quality gate script falls back to CC-only threshold (no CRAP). Documented in quality-analyst.md prompt.

5. **Stryker runtime**: On a large codebase, Stryker can run 20-40 minutes. The mutation-test.sh sets a 30-minute timeout and treats timeout as a skip (not a failure) to avoid blocking the milestone pipeline indefinitely.
