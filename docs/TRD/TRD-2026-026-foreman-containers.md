# TRD-2026-026: Containerizing Foreman

**Document ID:** TRD-2026-026
**Version:** 1.0
**Status:** In progress — Phases 1–3 complete; Phase 4 next
**Date:** 2026-07-28
**Author:** AI-assisted

---

## Why

Two capabilities of the kelos phase backend are blocked on the same thing: the
Foreman server is not reachable from the cluster.

- **Tool policy enforcement.** The gate is an HTTP endpoint
  (`/worker/v1/tool-policy`) and the PreToolUse hook that calls it already exists
  (`src/defaults/hooks/tool-policy-pretooluse.sh`), but an agent pod cannot reach
  the endpoint, so phases configuring a tool policy are refused outright.
- **Volume transport.** An agent writes to a PVC that Foreman, running on a
  laptop, cannot see. Patch transport works around this; sharing a filesystem
  would remove the round trip entirely.

Getting Foreman into the cluster resolves both. It also decouples pipeline runs
from one developer's machine being awake.

This is scoped as containerization only. Whether Foreman then *replaces* the
laptop or merely runs alongside it is a separate decision.

## What already exists, and why it does not serve this

`docker/pipeline.Dockerfile` on `origin/dev` (also on several feature branches)
builds a working one-shot container: it mounts a repo at `/repo`, runs the
`no-pr` workflow, and emits `CHANGES.patch` to `/output`. It embeds PostgreSQL,
bakes `dist/`, `bin/`, and `src/defaults/`, and has helper scripts
(`bootstrap.mjs`, `install-workflows.mjs`, `find-patch.mjs`, `poll-run.mjs`).

It is worth reading, and several layers are directly reusable. But it does not
serve this goal:

1. **It contains no Elixir server.** No Erlang/OTP runtime, no `mix`, no
   `foreman_server`. It drives the pre-Elixir CLI path directly.
2. **Its entrypoint is already broken against `main`.** It calls
   `foreman run task`, which now exits with: *"foreman run task operator use was
   removed after the Elixir backend cutover"* (`src/cli/commands/run-task.ts:579`).
3. It is one-shot and unreferenced — no CI, Makefile, or npm script builds it.
4. It carries experiment-specific defaults: `BASE_BRANCH=feature/darkfactory`,
   OpenRouter/Qwen models, a literal password in `DATABASE_URL`.

So this is not "extend the existing image". It is a new image that borrows the
system-package and asset-copying layers from the existing one.

## Constraints discovered

These shaped the plan and are worth stating before the phases.

- **`worker_launcher.ex` shells out to the `foreman` CLI**
  (`System.cmd(foreman, args, cd: project_path)`), on the same host. So the
  Elixir server and the Node CLI must be in the same image, or the launcher has
  to change. The former is far cheaper.
- **No `mix release` config exists.** `packages/foreman_server/mix.exs` has no
  `releases:` block. A release has to be added (standard, but it is work).
- **The cluster has no ReadWriteMany storage** — only `auto-ebs-gp3` (EBS, RWO).
  A single Foreman pod plus sequential phase pods can share an RWO volume only
  if they land on the same node. Concurrent access needs EFS, which was
  considered and declined.
- **`foreman init` is interactive** (prompts for issue tracker), so project
  registration needs a non-interactive path.
- **`~/.foreman/worktrees/` must persist**; logs and installed
  prompts/workflows can be ephemeral or baked.
- **The HTTP API already exists** on port 4766 with bearer-token auth and a
  `remote_auth_required?` guard, so the cockpits and CLI need no changes — they
  point at a Service.

## Phases

Each phase is independently verifiable. Stop after any of them and the result is
still coherent.

### Phase 1 — Elixir release — **DONE**

Add a `releases:` block to `packages/foreman_server/mix.exs` and confirm
`MIX_ENV=prod mix release` produces a runnable server locally.

*Done when:* the release boots against a local Postgres and `/api/v1/health`
answers.

*Risk:* low. Standard Elixir practice.

**Outcome.** `mix release` already assembled with mix defaults, so the
`releases:` block was cosmetic. The real gap was migrations: the release
crashes at boot with `failed to load foreman_events: table is missing`, and
migrations were only ever applied by `mix ecto.migrate` — and **a release
contains no Mix**. Added `ForemanServer.Release` (`migrate/0`, `rollback/2`)
for `bin/foreman_server eval`. Verified: migrations apply to an empty database
from the release, and the release then boots with `event_store: postgres`.

### Phase 2 — Image — **DONE**

Multi-stage build: Elixir builder produces the release, Node builder produces
`dist/`, runtime image carries both plus git and the CLI shim on `PATH`.

Reuse from `docker/pipeline.Dockerfile`: the system-package layer, the
`dist/`+`bin/`+`src/defaults/` copy pattern, and the migration-file pruning
(`node-pg-migrate` chokes on `.d.ts`/`.map`).

Do **not** reuse: the embedded PostgreSQL (use a real database), the hardcoded
models, the literal password, the one-shot entrypoint.

Build **amd64 only** — see the correction below. Push to ECR; note that ECR
access needs the break-glass profile, as the default Bedrock role is denied
`ecr:GetAuthorizationToken`.

*Done when:* the image runs the server locally via `docker run` with an external
`DATABASE_URL`, and `foreman --version` works inside it.

*Risk:* medium. Two toolchains in one image; expect iteration on what the
runtime layer actually needs.

**Outcome.** `docker/server.Dockerfile` (3 stages: Elixir builder → Node builder
→ runtime) plus `docker/server-entrypoint.sh` (`start` migrates then serves;
`migrate` migrates and exits; anything else execs verbatim, so
`docker run <image> foreman --version` works). 858MB, runs as uid 10001.

Three things the plan did not anticipate:

1. **`Http.Endpoint` hard-coded the bind to `127.0.0.1`** with no override, so
   no container port-publish or k8s Service could ever reach it. Added
   `FOREMAN_SERVER_HTTP_BIND` (defaults to loopback; the image sets `0.0.0.0`).
   The pre-existing fail-closed guard still holds — binding beyond loopback
   without `FOREMAN_SERVER_AUTH_TOKEN` exits 1, verified in the container.
2. **The Node build needs the `foreman-pi-extensions` workspace.**
   `build-atomic.js` runs `npm run build --workspace=…`, which fails if only the
   root manifest is copied.
3. **Set `LANG=C.UTF-8`** or the BEAM warns about latin1 name encoding.

Also needed `tsconfig.build.json` (not just `tsconfig.json`) and a
`.dockerignore` (none existed).

**Correction — multi-arch is not required.** This plan called for an
amd64+arm64 build because "the target cluster has Graviton nodes." Graviton
nodes exist, but they are not where this workload lands. On the
`software-engineering` cluster:

| Karpenter nodepool | Arch | Nodes |
| --- | --- | --- |
| `general-purpose` | amd64 only | 5 × c6a.large |
| `system` | amd64 + arm64 | 2 × c6g.large (arm64) |

Normal workloads schedule onto `general-purpose`, which is amd64-only, so an
amd64 image is sufficient. The Deployment pins it explicitly:

```yaml
nodeSelector:
  kubernetes.io/arch: amd64
```

An emulated arm64 build costs 40+ minutes on Elixir dependency compilation
under QEMU, to satisfy a constraint that does not currently bind. **The
tradeoff:** if `general-purpose` is ever moved to Graviton (a plausible ~20%
cost saving), the pod goes `Pending` and an arm64 build becomes necessary. That
failure is loud at deploy time, not silent.

*Verified:* `foreman --version` → 0.1.5 inside the image; server runs against an
external `DATABASE_URL` with `/api/v1/health` reachable from the host and all 7
`/api/v1/doctor` checks green; `migrate` is idempotent across restarts
(`Migrations already up`); `foreman`, `git`, and `foreman_server` all resolve on
`PATH` (the `worker_launcher.ex` `System.cmd` requirement).

### Phase 3 — Deploy — **DONE**

Postgres (managed RDS or an in-cluster instance), a Deployment for the server, a
Service on 4766, a PVC for `~/.foreman/worktrees/`, and Secrets for
`DATABASE_URL` / `FOREMAN_SERVER_AUTH_TOKEN` / model credentials.

The Deployment must set `nodeSelector: kubernetes.io/arch: amd64` (the image is
amd64-only — see the Phase 2 correction) and
`FOREMAN_SERVER_HTTP_BIND=0.0.0.0`, which the image already defaults to. Run
migrations as an init container (`args: ["migrate"]` on the same image) so a
multi-replica or restarting rollout does not race the schema.

Set `FOREMAN_SERVER_URL` so launched workers reach the server by Service DNS
rather than `127.0.0.1`.

Record it the way `deploy/pilot/` in the kelos fork records that deployment —
this cluster's state has already drifted once from being hand-applied.

*Done when:* `/api/v1/health` answers from inside the cluster and a cockpit can
attach through port-forward.

*Risk:* medium. Project registration (see Phase 4) is the likely snag.

**Outcome.** Live in `kelos-pilot` on the `software-engineering` cluster.
Manifests in `deploy/pilot/` (`postgres.yaml`, `foreman-server.yaml`, `README.md`),
hand-applied, mirroring the kelos fork's convention.

**Postgres: dedicated, not shared.** Six other Postgres instances run on this
cluster but each is owned by another app and four are under ArgoCD control —
reusing one would tie Foreman's schema lifecycle to an unrelated app's release
cadence. So `foreman-postgres` (postgres:16-alpine, 5Gi RWO) runs in
`kelos-pilot`. The event-store migrations need no extensions, so no pgvector.

Resolves the plan's *"Managed or in-cluster Postgres?"* open question: in-cluster,
dedicated.

Notable choices:
- **`Recreate`, not `RollingUpdate`, on both Deployments** — RWO EBS cannot
  attach to outgoing and incoming pods at once, so a rolling replacement
  deadlocks.
- **Migrations as an init container** (`args: ["migrate"]`, same image) so a
  restart cannot race the schema.
- **`foreman-home` PVC (10Gi) at `/home/foreman/.foreman`** — `FOREMAN_HOME`
  defaults to `~/.foreman` (`src/lib/foreman-paths.ts:16`), so worktrees *and*
  the term-backed project store persist there.
- **Image is `565715328522.dkr.ecr.us-east-1.amazonaws.com/foreman-server:0.1.5`**,
  ECR repo created with IMMUTABLE tags. Push needed break-glass
  (`TellihealthBreakGlassAdmin-565715328522`) plus `DOCKER_CONFIG=$(mktemp -d)`
  to bypass the WSL credential-store bug.

*Verified in-cluster:* migrate init container applied both migrations (7 tables);
`/api/v1/health` answers over Service DNS from a pod **and** through
port-forward; all 7 `/api/v1/doctor` checks green; runtime reports
`event_store: postgres` / `projection_store: postgres`, `mix_env: prod`;
unauthenticated `/api/v1/doctor` → **401**; both PVCs Bound, both pods Running
with 0 restarts.

### Phase 4 — Non-interactive project registration

`foreman init` prompts, so provide a path that does not: either a flag, or seed
projects through `POST /api/v1/projects`.

*Done when:* a project is registered in a fresh deployment with no terminal
interaction.

*Risk:* low, but it is the thing most likely to block Phase 3 from being useful.

### Phase 5 — Prove the two blocked capabilities

The point of the exercise.

1. **Tool policy:** install the existing hook into an agent pod (via
   `preCommands` or the agent image), point `FOREMAN_SERVER_URL` at the Service,
   and confirm a denied tool call actually blocks. Then remove the refusal in
   `kelos-phase-runner.ts`.
2. **Volume transport:** mount the same worktree PVC into the Foreman pod and a
   phase pod, and confirm `filesChanged` is populated without patch transport.

*Done when:* a real phase is blocked by policy, and a phase reports changed files
over a shared volume.

*Risk:* **high, and this is where the plan is most likely to break.**
- The hook adds a synchronous HTTP round trip to *every* tool call. Measure it
  before enabling; a slow or flaky endpoint is worse than none, because Claude
  Code hooks fail open on timeout (the script denies on failure, so a flaky
  endpoint blocks legitimate work instead).
- Volume transport still needs Foreman and the agent pod on the same node, given
  RWO storage. Node affinity would be required, and it does not compose with a
  `WorkerPool` of more than one replica.

## Explicitly out of scope

- Replacing the laptop workflow. Local development stays as it is.
- Moving the Node/Pi worker tier out of process. ADR-0001 deprecates TypeScript
  for orchestration, and this plan does not resolve that; the CLI stays in the
  image because `worker_launcher.ex` shells out to it.
- Horizontal scaling. One server replica, because the worktree PVC is RWO and
  the scheduler is not known to be safe to run concurrently.
- Provisioning EFS.

## Open questions

- ~~**Managed or in-cluster Postgres?**~~ **Decided in Phase 3:** in-cluster and
  dedicated (`foreman-postgres` in `kelos-pilot`), rather than RDS or sharing an
  existing instance. See the Phase 3 outcome.
- **Does the scheduler tolerate a pod restart mid-run?** Workers checkpoint to
  the server over HTTP, so in principle yes, but this is unverified and worth a
  deliberate test before trusting it.
- **Does the cockpit need ingress**, or is port-forward sufficient? Ingress means
  exposing the orchestrator's control plane, which deserves its own decision.
- **Single pod or split?** One pod with both runtimes is simplest and is what
  `worker_launcher.ex` assumes. Splitting would need the launcher to dispatch
  over HTTP instead of `System.cmd`.

## Estimate

Phases 1–4 are days-scale — call it 3–5 days for a working in-cluster server,
assuming no surprise in the two-toolchain image build.

Phase 5 is not estimable yet. It depends on the latency measurement and on
whether same-node scheduling is acceptable. It may conclude that patch transport
should remain the default and volume transport is not worth the constraint.
