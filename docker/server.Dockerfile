# Foreman in-cluster server (TRD-2026-026 Phase 2)
#
# One image, two runtimes: the Elixir release serves the HTTP API on 4766 and
# ForemanServer.WorkerLauncher shells out to the `foreman` Node CLI on the same
# host, so both must ship together.
#
# amd64 only. The software-engineering cluster's `general-purpose` nodepool is
# amd64-only (the arm64 nodes are in `system`), and the Deployment pins
# `nodeSelector: kubernetes.io/arch: amd64`. If that nodepool ever moves to
# Graviton the pod goes Pending, and this needs an arm64 build:
#   docker buildx build --platform linux/amd64,linux/arm64 ...
#
# Build:
#   docker build -f docker/server.Dockerfile \
#     -t <registry>/foreman-server:<tag> .
#
# Run:
#   docker run --rm -p 4766:4766 \
#     -e DATABASE_URL=postgresql://user:pw@host:5432/foreman \
#     -e FOREMAN_SERVER_AUTH_TOKEN=... \
#     <image>

# ─── Elixir builder ────────────────────────────────────────────────────────────
# Pinned to the OTP major the release is built against: a release bundles ERTS,
# so the runtime stage's shared libraries must match this Debian release.
FROM hexpm/elixir:1.18.4-erlang-25.3.2.21-debian-bookworm-20250630-slim AS elixir-builder

ENV MIX_ENV=prod

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN mix local.hex --force && mix local.rebar --force

WORKDIR /build

COPY packages/foreman_server/mix.exs packages/foreman_server/mix.lock ./
RUN mix deps.get --only prod && mix deps.compile

COPY packages/foreman_server/config ./config
COPY packages/foreman_server/lib ./lib
COPY packages/foreman_server/priv ./priv

RUN mix compile && mix release --overwrite

# ─── Node builder ──────────────────────────────────────────────────────────────
FROM node:22-slim AS node-builder

WORKDIR /build

# --ignore-scripts skips the `prepare` hook, which would build before sources exist.
# The pi-extensions workspace manifest must be present or `npm ci` resolves no
# workspaces and build-atomic.js fails on its workspace build step.
COPY package.json package-lock.json ./
COPY packages/foreman-pi-extensions/package.json ./packages/foreman-pi-extensions/
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
COPY packages/foreman-pi-extensions/ ./packages/foreman-pi-extensions/
RUN npm run build

# node-pg-migrate reads every file in the migrations directory and chokes on
# the emitted .d.ts/.map siblings.
RUN find dist/lib/db/migrations -type f -not -name '*.js' -delete

# ─── Runtime ───────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# libncurses/openssl are the release's ERTS runtime dependencies; git is required
# for worktree operations.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    libncurses6 \
    openssh-client \
    openssl \
    && rm -rf /var/lib/apt/lists/* \
    && git config --global user.email "foreman@container" \
    && git config --global user.name "Foreman Agent" \
    && git config --global safe.directory '*'

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/foreman-pi-extensions/package.json ./packages/foreman-pi-extensions/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=node-builder /build/dist/ ./dist/
COPY scripts/run-pg-migrate.mjs ./scripts/
COPY src/defaults/ ./src/defaults/
COPY bin/ ./bin/

COPY --from=elixir-builder /build/_build/prod/rel/foreman_server/ /app/server/

COPY docker/server-entrypoint.sh /app/docker/
RUN chmod +x /app/docker/server-entrypoint.sh /app/bin/foreman \
    && useradd -m -s /bin/bash -u 10001 foreman \
    && mkdir -p /home/foreman/.foreman/worktrees \
    && chown -R foreman:foreman /app /home/foreman

# The BEAM warns and can mis-handle non-ASCII filenames under latin1 encoding.
ENV LANG="C.UTF-8" \
    LC_ALL="C.UTF-8" \
    PATH="/app/bin:/app/server/bin:${PATH}" \
    NODE_PATH="/app/node_modules" \
    HOME="/home/foreman" \
    MIX_ENV="prod" \
    RELEASE_TMP="/tmp" \
    FOREMAN_SERVER_HTTP_ENABLED="true" \
    FOREMAN_SERVER_HTTP_PORT="4766" \
    FOREMAN_SERVER_HTTP_BIND="0.0.0.0" \
    FOREMAN_SERVER_PROJECT_STORE="/home/foreman/.foreman/projects.term"

USER foreman

EXPOSE 4766

VOLUME ["/home/foreman/.foreman/worktrees"]

ENTRYPOINT ["/app/docker/server-entrypoint.sh"]
CMD ["start"]
