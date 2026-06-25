# Architecture Decision Records

This directory holds Architecture Decision Records (ADRs) — short documents capturing a
single significant decision: its context, the choice made, and the consequences.

## Format

Lightweight [MADR](https://adr.github.io/madr/)-style. Each ADR has:

- **Status** — `Proposed` | `Accepted` | `Superseded by ADR-XXXX` | `Deprecated`
- **Context** — the forces at play, what problem prompted the decision
- **Decision** — what we chose to do
- **Consequences** — the resulting trade-offs (good and bad)

## Conventions

- Filename: `NNNN-kebab-case-title.md` (zero-padded sequential number).
- ADRs are immutable once `Accepted` — to change a decision, write a new ADR that
  supersedes the old one and update the old one's status.
- Link ADRs from the TRD/PRD that motivated them.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-qlty-as-quality-gate.md) | qlty as the unified code-quality gate | Accepted |
| [0002](0002-ci-supply-chain-hardening.md) | CI supply-chain hardening posture | Accepted |
| [0003](0003-typescript-strictness-enforcement.md) | Enforce TypeScript strictness (no `any`, no `!`) | Accepted |
| [0004](0004-accepted-findings-policy.md) | Accepted-findings policy (no-fix CVEs, lint ignores) | Accepted |
| [0005](0005-pixel-factory-floor-visualization.md) | Pixel-art "factory floor" visualization (LPC spritesheets) | Accepted |
