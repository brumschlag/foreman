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
#     -e TASK_TITLE="Add dark mode toggle" \
#     -e TASK_DESCRIPTION="..." \
#     -e OPENROUTER_API_KEY=sk-... \
#     foreman-pipeline

FROM node:22-slim

# System deps: git (required), gh (optional — not used in no-pr workflow)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Configure git so worktree operations work inside the container
RUN git config --global user.email "foreman@container" && \
    git config --global user.name "Foreman Agent" && \
    git config --global safe.directory '*'

WORKDIR /app

# Install production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built dist
COPY dist/ ./dist/

# Copy default prompts/workflows bundled with foreman
COPY src/defaults/ ./src/defaults/

# Copy the bin shim so `foreman` is on PATH
COPY bin/ ./bin/

# Copy container helpers
COPY docker/ ./docker/

# Make entrypoint executable
RUN chmod +x /app/docker/entrypoint.sh

# Create a non-root user with a home dir for ~/.foreman state
RUN useradd -m -s /bin/bash foreman && \
    chown -R foreman:foreman /app

USER foreman

ENV PATH="/app/bin:${PATH}"
ENV NODE_PATH="/app/node_modules"

VOLUME ["/repo", "/output"]

ENTRYPOINT ["/app/docker/entrypoint.sh"]
