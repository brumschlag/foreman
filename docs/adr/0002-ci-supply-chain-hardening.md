# ADR-0002: CI supply-chain hardening posture

- **Status:** Accepted
- **Date:** 2026-06-24
- **Related:** [TRD-2026-025](../TRD/TRD-2026-025-quality-and-security-hardening.md)

## Context

`zizmor` (a GitHub Actions static analyzer) flagged several classes of supply-chain risk
across our 8 workflows (`ci`, `e2e-full-run`, `publish-npm`, `release-binaries`, `release`,
`system-tests`, `test-release-dry-run`, `update-homebrew-tap`):

- **Template injection** — attacker-controllable values (`github.ref_name`, PR titles,
  release outputs) interpolated as `${{ ... }}` directly inside `run:` blocks, allowing
  shell injection.
- **Over-privileged tokens** — workflows inheriting broad default `GITHUB_TOKEN`
  permissions.
- **Credential persistence** — `actions/checkout` leaving credentials on disk for jobs
  that don't need to push.
- **Unpinned actions** — third-party actions referenced by mutable tag (e.g.
  `release-please@v4`) rather than an immutable commit.
- **Cache poisoning surface** — publish/release jobs sharing build caches.

## Decision

Adopt a least-privilege, injection-safe posture for all GitHub Actions workflows:

1. **Declare `permissions:` explicitly per job**, scoped to the minimum required.
2. **Pass untrusted inputs via `env:`**, then reference `"$VAR"` in `run:` — never
   interpolate `${{ }}` of untrusted data directly into a shell command.
3. **Pin third-party actions to a full commit SHA.**
4. **Set `persist-credentials: false`** on checkout unless the job genuinely reuses the token.
5. **Drop publish/release build caches** where cache poisoning is a credible risk.

## Consequences

**Positive**

- Removes the template-injection attack class from release/publish/tap workflows that
  handle credentials.
- Blast radius of a compromised step is bounded by per-job permissions.
- SHA-pinned actions can't be silently re-pointed at malicious code.

**Negative / trade-offs**

- SHA pins go stale and need periodic bumps (dependabot/renovate or manual).
- Dropping caches slightly slows the affected jobs.
- Per-job `permissions:` blocks add boilerplate and must be maintained as workflows evolve.

See ADR-0004 for the handful of `zizmor` findings we accept-and-ignore with rationale.
