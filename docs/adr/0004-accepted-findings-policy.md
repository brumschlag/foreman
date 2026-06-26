# ADR-0004: Accepted-findings policy (no-fix CVEs and intentional lint ignores)

- **Status:** Accepted
- **Date:** 2026-06-24
- **Related:** [TRD-2026-025](../TRD/TRD-2026-025-quality-and-security-hardening.md),
  [ADR-0001](0001-qlty-as-quality-gate.md), [ADR-0002](0002-ci-supply-chain-hardening.md)

## Context

Not every finding from `npm audit`, `qlty`, or `zizmor` can or should be "fixed":

- Some CVEs have **no patched version available**, or are **not reachable** in how we use
  the dependency.
- Some static-analysis findings are **intentional** (e.g. running as root inside a
  container build, glob/`ls` usage in a controlled script, a `setup-node` cache, the
  homebrew-tap push using credentials by design, an OIDC pattern flagged generically).

Silently ignoring them is dangerous (the rationale is lost); fixing them spuriously is
churn. We need a documented, auditable middle path.

## Decision

Findings that are deliberately not fixed must be **explicitly suppressed *with a written
rationale* at the suppression site**, not silently filtered:

- **Dependency CVEs:** of 25 advisories, 21 were remediated by version bumps; the
  remaining 4 are recorded as accepted (no fix available / not exploitable in our usage).
- **`qlty` findings:** intentional patterns are annotated/ignored in `.qlty/qlty.toml` or
  inline (e.g. best-effort cleanup `catch` blocks in docker scripts, intentional
  root/glob/`ls` in the Dockerfile, the dropped `ripgrep` plugin per ADR-0001).
- **`zizmor` findings:** accepted ignores (`workflow_run` usage, `setup-node` cache, the
  homebrew-tap push credentials, the OIDC pattern) are documented where they are ignored.

Every accepted finding carries a one-line reason so a future reviewer understands *why*.

## Consequences

**Positive**

- A clean gate means a *real* clean gate — new findings aren't lost in a sea of
  un-actioned noise.
- Acceptance decisions are auditable and reversible; the rationale travels with the code.

**Negative / trade-offs**

- Accepted findings must be **re-reviewed periodically** (on `npm audit` drift, new CVE
  disclosure, or dependency upgrade) — an accepted-today finding can become exploitable
  tomorrow.
- Requires discipline: the policy only works if suppressions always carry a rationale.
