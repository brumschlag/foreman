---
document_id: TRD-2026-025
prd_reference: (none — engineering-led hardening initiative)
version: 1.0.0
status: Implemented
date: 2026-06-24
design_readiness_score: n/a (retrospective)
---

# TRD-2026-025: Code Quality and Supply-Chain Security Hardening

> **Retrospective TRD.** This document was written *after* the work shipped (commits
> `2a55c788..729dd353`, 2026-06-24) to capture the requirements that were satisfied, the
> decisions made, and the standing policy the codebase now enforces. Status is `Implemented`.

## Summary

A single-day hardening sprint that paid down accumulated static-analysis debt, eliminated
loose-typing escape hatches, hardened the GitHub Actions supply chain against the
findings surfaced by `zizmor`, and remediated dependency CVEs. The change set is
deliberately **behavior-preserving**: 173 files, +1,262 / −1,228 lines (net ≈ 0). No
runtime feature was added or removed — the goal was to make existing behavior safer,
better-typed, and clean under the `qlty` gate.

## Motivation

- **Static-analysis noise was masking real defects.** `qlty check` produced enough
  accepted-but-undocumented findings that new findings were easy to miss.
- **TypeScript escape hatches had crept in.** `any`, non-null assertions (`!`), inline
  `import()` type annotations, and `@ts-ignore` directives violated the project's
  declared "strict mode, no `any`" rule (CLAUDE.md, Development Rules).
- **CI workflows were vulnerable to template injection and over-privileged.** `zizmor`
  flagged unscoped `GITHUB_TOKEN` permissions, credential persistence, unpinned actions,
  and `${{ }}` interpolation of attacker-controllable inputs into `run:` blocks.
- **Open dependency CVEs.** 25 advisories were outstanding against the dependency tree.

## Architecture Decision

This work is governed by four Architecture Decision Records (see `docs/adr/`):

| ADR | Decision |
|-----|----------|
| [ADR-0001](../adr/0001-qlty-as-quality-gate.md) | Adopt `qlty` as the unified code-quality gate; plugin curation policy |
| [ADR-0002](../adr/0002-ci-supply-chain-hardening.md) | CI supply-chain hardening posture (zizmor-driven) |
| [ADR-0003](../adr/0003-typescript-strictness-enforcement.md) | Enforce TS strictness: ban `any` and non-null assertions via eslint |
| [ADR-0004](../adr/0004-accepted-findings-policy.md) | Accepted-findings policy for no-fix CVEs and intentional lint ignores |

## Requirements

### Code Quality (qlty / eslint)

- **REQ-001** — No `any` types in `src/`. Replace with precise types or `unknown` + narrowing.
- **REQ-002** — No non-null assertions (`!`). Replace with explicit guards that fail safe.
- **REQ-003** — Type-only imports use `import type` (top-level), not inline `import()` annotations.
- **REQ-004** — `@ts-ignore` replaced with `@ts-expect-error` (fails when the suppressed error disappears).
- **REQ-005** — Remove dead code and unused imports; underscore-prefix intentionally-unused params.
- **REQ-006** — Reduce cognitive complexity in flagged functions (e.g. `fix-doc-blocks` via lookup table).
- **REQ-007** — `factory-ui` package clears lint (dead code, `any`→types, `require`→`import`, root guard).
- **REQ-008** — `.mjs` and docker scripts get node globals + relaxed tooling eslint rules rather than blanket disables.

### CI / Supply-Chain Security (zizmor)

- **REQ-010** — Every workflow job declares least-privilege `permissions:` explicitly.
- **REQ-011** — Disable credential persistence (`persist-credentials: false`) on checkout where the token is not reused.
- **REQ-012** — Pin third-party actions to a full commit SHA (e.g. `release-please`).
- **REQ-013** — No untrusted input interpolated directly into `run:`; pass via `env:` instead (template-injection fix) across `update-homebrew-tap`, `publish-npm`, `release-binaries`, `test-release-dry-run`, `release`.
- **REQ-014** — Drop publish/release build caches where cache poisoning is a credible risk.

### Dependencies

- **REQ-020** — Bump vulnerable transitive/direct deps to patched versions (cleared 21 of 25 CVEs).
- **REQ-021** — Document the 4 remaining CVEs as accepted with rationale (no fix available / not exploitable in our usage).

### Tooling Configuration

- **REQ-030** — Curate `qlty` plugins: drop `ripgrep` (NOTE/TODO/BUG comment keywords are not defects).
- **REQ-031** — Exclude vendored `homebrew-tap` from analysis.
- **REQ-032** — `install.sh` uses a `bash` shebang (it relies on `local`, a bashism); document `curl | bash`.

## Scope

### In scope

- `src/orchestrator/*` (57 files), `src/cli/*` (40), `src/lib/*` (31), `src/daemon/*` (11)
- `packages/factory-ui/*`, `docker/*`, `scripts/*`
- `.github/workflows/*` (8 files: `ci`, `e2e-full-run`, `publish-npm`, `release-binaries`, `release`, `system-tests`, `test-release-dry-run`, `update-homebrew-tap`)
- `.qlty/qlty.toml`, `eslint.config.js`, `package.json` / `package-lock.json`, `install.sh`, `README.md`

### Out of scope (non-goals)

- Any runtime behavior change, new feature, or API change.
- Refactoring module boundaries (covered by TRD-2026-024) or pipeline internals (TRD-2026-015).
- Test logic changes beyond type-safety repairs to fixtures and mocks.

## Verification

- `npx tsc --noEmit` — clean (no type regressions from `any`/`!` removal).
- `npm test` — full suite green; type-safety repairs to test fixtures/mocks verified.
- `npm run lint` (qlty/eslint) — clean against the curated plugin set.
- `zizmor` — only documented, accepted findings remain (see ADR-0004).
- Net diff ≈ 0 lines confirms behavior preservation.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Guard-for-`!` swaps change control flow | Guards chosen to preserve prior happy-path; covered by existing tests + `tsc` |
| Over-scoped → under-scoped `permissions:` breaks a CI job | Each workflow exercised via dry-run / existing CI before merge |
| Accepted CVEs become exploitable later | ADR-0004 records rationale; re-review on next `npm audit` drift |
| SHA-pinned actions go stale | Tracked by dependabot/renovate or periodic manual bump |

## Follow-ups

- Wire the curated `qlty` + `zizmor` checks into the CI gate so regressions fail fast (if not already enforced).
- Periodic re-audit of accepted CVEs and SHA-pinned actions.
- Consider extending the "no `any` / no `!`" rule to a pre-commit hook.
