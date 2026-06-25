# ADR-0001: qlty as the unified code-quality gate

- **Status:** Accepted
- **Date:** 2026-06-24
- **Related:** [TRD-2026-025](../TRD/TRD-2026-025-quality-and-security-hardening.md)

## Context

The repository accumulated static-analysis findings from multiple ad-hoc tools with no
single source of truth for "is this code clean?". Some tools (e.g. a `ripgrep`-based
keyword scanner) flagged `NOTE`/`TODO`/`BUG` comments as defects, generating noise that
buried real findings. We needed one orchestrator that runs the right linters/formatters
per language and lets us curate which plugins are authoritative.

## Decision

Adopt **`qlty`** as the unified code-quality gate, configured via `.qlty/qlty.toml`.

Plugin curation policy:

- **Drop the `ripgrep` plugin** — comment keywords (`NOTE`/`TODO`/`BUG`) are intentional
  developer annotations, not defects. Treating them as findings trains people to ignore
  the gate.
- **Exclude vendored code** from analysis (e.g. the `homebrew-tap` directory) — we do not
  own it and cannot fix findings there.
- Keep ESLint as the authoritative TypeScript linter (see ADR-0003); `qlty` orchestrates it.

## Consequences

**Positive**

- One command (`qlty check`) reflects the project's real quality bar.
- Signal-to-noise improved: removing keyword/vendored noise makes new findings visible.
- Plugin set is explicit and reviewable in `.qlty/qlty.toml`.

**Negative / trade-offs**

- A curated plugin set can hide a class of issues if a plugin is dropped too eagerly;
  drops must be justified (as the `ripgrep` drop is).
- `qlty --fix` is **not** safe to run blindly on this codebase — it has mangled TS source
  here. Use `npm run lint:fix` (eslint) plus a `tsc --noEmit` safety net instead.
