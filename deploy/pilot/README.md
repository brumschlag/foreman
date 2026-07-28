# Foreman server deployment (software-engineering EKS)

Records the in-cluster Foreman server on the `software-engineering` cluster
(account 565715328522, us-east-1), namespace `kelos-pilot`. Implements
TRD-2026-026 Phase 3.

Like the kelos fork's `deploy/pilot/`, these files exist so the cluster can be
reproduced or audited. They are **hand-applied — not wired to a GitOps
controller.** This cluster's state has drifted from hand-application before, so
if you change something live, change it here too.

## Why a dedicated Postgres

Six other Postgres instances run on this cluster (`buzz`, `honcho-postgres`,
`apicurio`, `backstage`, `kpi`, `keycloak`), but each is owned by another app and
four are under ArgoCD control. Reusing one would tie Foreman's schema lifecycle
to an unrelated app's release cadence and share its connection limits, so
Foreman gets its own instance in its own namespace.

The Elixir event-store migrations need no extensions, so `postgres:16-alpine`
(matching the other instances here) is sufficient — pgvector is not required.

## Why `kelos-pilot`

The `foreman-worktree` PVC from the kelos phase-runner work already lives there,
and Phase 5's volume-transport test needs the server and phase pods co-scheduled
on one node — a separate namespace would make that cross-namespace for no gain.

## Prerequisites

Secrets are not in these manifests. Create them first:

```bash
PGPASS="$(openssl rand -base64 24 | tr -d /=+ | cut -c1-32)"

kubectl create secret generic foreman-postgres -n kelos-pilot \
  --from-literal=password="$PGPASS"

# The server reads one DATABASE_URL rather than assembling parts.
kubectl create secret generic foreman-database-url -n kelos-pilot \
  --from-literal=url="postgresql://foreman:${PGPASS}@foreman-postgres.kelos-pilot.svc.cluster.local:5432/foreman"

kubectl create secret generic foreman-server -n kelos-pilot \
  --from-literal=auth-token="$(openssl rand -hex 32)"
```

`FOREMAN_SERVER_AUTH_TOKEN` is mandatory, not optional: the server refuses to
start (exit 1) when bound beyond loopback without it.

## Image

amd64-only. The `general-purpose` nodepool is amd64 (the arm64 nodes are in
`system`), and both workloads pin `nodeSelector: kubernetes.io/arch: amd64`. See
the TRD Phase 2 correction for why multi-arch was dropped.

```bash
docker build -f docker/server.Dockerfile -t foreman-server:0.1.5 .
docker tag foreman-server:0.1.5 \
  565715328522.dkr.ecr.us-east-1.amazonaws.com/foreman-server:0.1.5
docker push 565715328522.dkr.ecr.us-east-1.amazonaws.com/foreman-server:0.1.5
```

ECR access needs the break-glass profile; the default Bedrock role is denied
`ecr:GetAuthorizationToken`. ECR tags are immutable by default — bump the tag
rather than re-pushing.

## Apply

```bash
kubectl apply -f deploy/pilot/postgres.yaml
kubectl rollout status -n kelos-pilot deploy/foreman-postgres

kubectl apply -f deploy/pilot/foreman-server.yaml
kubectl rollout status -n kelos-pilot deploy/foreman-server
```

## Verify

```bash
kubectl port-forward -n kelos-pilot svc/foreman-server 4766:4766
curl -s localhost:4766/api/v1/health
curl -s -H "Authorization: Bearer $TOKEN" localhost:4766/api/v1/doctor
```

`/api/v1/health` answers unauthenticated; a token adds the runtime detail block.
`/api/v1/doctor` requires the token.

## Notes and constraints

- **`Recreate`, not `RollingUpdate`, on both Deployments.** Their volumes are
  RWO EBS, which cannot attach to the outgoing and incoming pod simultaneously —
  a rolling replacement deadlocks.
- **One server replica.** The home PVC is RWO and the scheduler is not known to
  be concurrency-safe.
- **Migrations run as an init container** so a restart cannot race the schema.
  They are idempotent (`Migrations already up`, exit 0).
- **Node memory is tight** — the amd64 nodes were at 78–89% memory when this was
  written, so Karpenter may need to scale out to place the server's 512Mi
  request.
