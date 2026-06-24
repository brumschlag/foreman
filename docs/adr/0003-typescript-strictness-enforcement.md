# ADR-0003: Enforce TypeScript strictness (no `any`, no non-null assertions)

- **Status:** Accepted
- **Date:** 2026-06-24
- **Related:** [TRD-2026-025](../TRD/TRD-2026-025-quality-and-security-hardening.md)

## Context

`CLAUDE.md` declares "TypeScript strict mode — no `any` escape hatches" as a development
rule, but the rule was not mechanically enforced. Over time the codebase accumulated:

- explicit `any` types,
- non-null assertions (`!`) that silently assume a value is present,
- inline `import()` type annotations instead of `import type`,
- `@ts-ignore` directives that keep suppressing even after the underlying error is gone.

These erode the guarantees strict mode is supposed to provide and hide real null/undefined
bugs.

## Decision

Enforce the strictness rules through **ESLint** (`eslint.config.js`), and bring the existing
code into compliance:

- **Ban `any`** — replace with precise types or `unknown` + explicit narrowing.
- **Ban non-null assertions (`!`)** — replace with guards that fail safe.
- **Require `import type`** for type-only imports (top-level, not inline `import()`).
- **Use `@ts-expect-error` instead of `@ts-ignore`** — it errors when the suppressed
  problem disappears, so suppressions self-clean.
- **Relaxed tooling scope:** `.mjs` and docker helper scripts get node globals and relaxed
  rules rather than blanket file-level disables; test files / CJS shims may opt out of
  `no-require-imports` where genuinely needed.

## Consequences

**Positive**

- Null/undefined bugs surface at compile time instead of runtime.
- Type-only imports are erasable, keeping the emitted module graph clean.
- Suppressions can no longer rot — `@ts-expect-error` forces removal once obsolete.

**Negative / trade-offs**

- Replacing `!` with guards adds code and, in a few spots, a defensible decision about the
  fail-safe path; covered by `tsc --noEmit` + existing tests.
- Stricter rules raise the bar for new contributions (intended).
