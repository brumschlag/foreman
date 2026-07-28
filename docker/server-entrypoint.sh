#!/usr/bin/env bash
# Entrypoint for the Foreman in-cluster server image (TRD-2026-026).
#
#   start   run event-store migrations (Postgres only), then run the server
#   migrate run migrations and exit
#   <other> exec verbatim, so `docker run <image> foreman --version` works
set -euo pipefail

RELEASE_BIN=/app/server/bin/foreman_server

migrate() {
  # The term event store keeps no schema, so there is nothing to migrate.
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "[entrypoint] DATABASE_URL unset — skipping migrations" >&2
    return 0
  fi

  echo "[entrypoint] running event-store migrations" >&2
  "$RELEASE_BIN" eval 'ForemanServer.Release.migrate()'
}

case "${1:-start}" in
  start)
    migrate
    echo "[entrypoint] starting foreman_server" >&2
    exec "$RELEASE_BIN" start
    ;;
  migrate)
    migrate
    ;;
  *)
    exec "$@"
    ;;
esac
