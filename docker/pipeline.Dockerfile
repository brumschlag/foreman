# Foreman Pipeline Container
# Runs the no-pr workflow against a mounted repo and outputs CHANGES.patch.
#
# Build:
#   docker build -f docker/pipeline.Dockerfile -t foreman-pipeline .
#
# Run:
#   docker run --rm \
#     -v /path/to/repo:/repo \
#     -v /path/to/output:/output \
#     -v ~/.pi:/home/foreman/.pi:ro \
#     -e TASK_TITLE="Add dark mode toggle" \
#     -e OPENROUTER_API_KEY=*** \
#     foreman-pipeline

FROM node:22-slim

# Install system packages, configure git for worktree operations, and prepare
# the postgres runtime directory (single layer).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    gosu \
    openssh-client \
    postgresql \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && git config --global user.email "foreman@container" \
    && git config --global user.name "Foreman Agent" \
    && git config --global safe.directory '*' \
    && mkdir -p /var/run/postgresql \
    && chown postgres:postgres /var/run/postgresql

# Init postgres cluster as postgres user.
USER postgres
# The glob is intentional: it resolves the installed PostgreSQL version's bin
# directory (version-agnostic across base-image updates).
# hadolint ignore=SC2211
RUN /usr/lib/postgresql/*/bin/initdb -D /var/lib/postgresql/data --auth-local=trust --auth-host=trust -U postgres
# Intentional: this ephemeral pipeline sandbox runs as root so the entrypoint
# can manage the embedded PostgreSQL cluster and agent worktrees.
# hadolint ignore=DL3002
USER root

WORKDIR /app

# Install production deps (ignore scripts — dist is pre-built)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy built dist
COPY dist/ ./dist/

# Copy migration files (only .js — node-pg-migrate chokes on .d.ts/.map)
COPY dist/lib/db/migrations/ ./dist/lib/db/migrations/
RUN find /app/dist/lib/db/migrations -not -name "*.js" -type f -delete

# Copy scripts needed for db:migrate
COPY scripts/run-pg-migrate.mjs ./scripts/

# Copy default prompts/workflows
COPY src/defaults/ ./src/defaults/

# Copy the bin shim
COPY bin/ ./bin/

# Copy container helpers, then create the foreman user (available, though the
# container runs as root for postgres access) and fix ownership/permissions.
COPY docker/ ./docker/
RUN chmod +x /app/docker/entrypoint.sh && \
    useradd -m -s /bin/bash foreman && \
    chown -R foreman:foreman /app && \
    chown -R postgres:postgres /var/lib/postgresql/data && \
    chmod 777 /var/run/postgresql

ENV PATH="/app/bin:${PATH}"
ENV NODE_PATH="/app/node_modules"
ENV DATABASE_URL="postgresql://postgres:***@localhost:5432/foreman"
ENV FOREMAN_DEFAULT_MODEL="openrouter/qwen/qwen3-coder-next"
ENV FOREMAN_EXPLORER_MODEL="openrouter/qwen/qwen3-coder-next"
ENV FOREMAN_DEVELOPER_MODEL="openrouter/qwen/qwen3-coder-next"
ENV FOREMAN_QA_MODEL="openrouter/qwen/qwen3-coder-next"
ENV FOREMAN_REVIEWER_MODEL="openrouter/qwen/qwen3-coder-next"

VOLUME ["/repo", "/output"]

ENTRYPOINT ["/app/docker/entrypoint.sh"]
