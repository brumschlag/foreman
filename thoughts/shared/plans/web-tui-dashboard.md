# Plan: Web Dashboard for `foreman watch` (TUI-on-the-web)

## Goal
Expose the `foreman watch` live dashboard in a browser. Two delivery options,
fastest-first. "Done" = the dashboard's agents/board/inbox/events are viewable
remotely in a browser, refreshing on the same cadence as the TUI.

## Background (grounded in current code)
- TUI lives in `src/cli/commands/watch/` — raw ANSI + `chalk` + Unicode
  box-drawing (`┌─┐`), **no external TUI library**.
  - Entry: `src/cli/commands/watch/index.ts` (poll loop, `setTimeout(refreshMs)`,
    default 5000ms; keyboard handler wakes early).
  - Render: `watch/render.ts` → `WatchLayout.ts`; state in `watch/WatchState.ts`.
- **All data already flows through tRPC** over a Unix socket to a `ForemanDaemon`
  (`src/lib/trpc-client.ts:436`). This is the key enabler — the data layer is
  already a proper API, so a web rebuild reuses it wholesale.
- Data-access calls the web layer can reuse verbatim:
  - `fetchDaemonDashboardState(projectPath, projectId?)` (`watch/dashboard-state.ts:74`)
    → `{ activeRuns: Map<string,Run[]>, progresses, metrics, events }`
  - `client.projects.stats()` — task counts
  - `client.runs.listMessages({ runId })` — inbox
  - `client.runs.listEvents({ runId })` — pipeline events
- Render data shapes (`watch/WatchState.ts`):
  - `AgentEntry { run: Run, progress: RunProgress | null }`
  - `Run`: `id, seed_id, status, agent_type, project_id, pr_url, pr_state, ...`
    (`src/lib/store.ts:86`)
  - `RunProgress`: `costUsd, tokensIn/Out, toolCalls, turns, currentPhase,
    lastActivity, costByPhase, agentByPhase` (`src/lib/store.ts:182`)
  - `BoardSummary`, `InboxEntry`, `PipelineEventEntry` (same file)

## Option A — Stream the real TUI (≈1 hour, zero rebuild)
`foreman watch` reads stdin keys (Tab, 1-9, j/k, a, r, q) and writes ANSI to
stdout — exactly what a pty bridge wants.

```bash
ttyd --port 7681 --writable foreman watch --refresh 2000
```

- ttyd ships its own xterm.js client → usually zero frontend code.
- To embed in our own page: xterm.js + `@xterm/addon-attach` (bidirectional WS),
  + `@xterm/addon-fit`.

**Trade-offs:** one shared pty per process; no deep links / click-through; it's a
picture of the terminal. Must sit behind auth; `--writable` forwards keystrokes
to a live process. Good for "glance at it remotely."

## Option B — Web-native rebuild on the tRPC API (the real target → `foreman serve`)
Reuse the exact tRPC calls `WatchState.ts` makes. Add only (1) an HTTP/WS
transport in front of the daemon, (2) a WebTUI frontend.

1. **Transport** — serve the existing `appRouter` over HTTP + WS (today it's
   bound to a Unix socket):
   - `@trpc/server/adapters/standalone` (`createHTTPServer`)
   - `@trpc/server/adapters/ws` (`applyWSSHandler`) for live subscriptions
   - New file: `src/web/server.ts`; new CLI command `foreman serve`.
2. **Frontend** — WebTUI CSS (`@webtui/css`) for terminal aesthetic on real DOM.
   - One `<div box-="round">` per run = the box-drawing cards, but clickable.
   - `createTRPCProxyClient` → query `dashboard.state`, render `AgentEntry`
     fields (status, seed_id, currentPhase, costUsd).
   - TUI keyboard actions (`a` approve, `r` retry, `1-9` expand) become
     buttons/links firing the matching tRPC mutations.
   - Refresh: mirror 2s poll, or upgrade to a tRPC subscription over WS.

**Trade-offs:** more upfront work, but yields deep links (`/run/<id>`), real
click-through to logs, multi-user, and stays in-codebase as a first-class
command.

## Recommended sequence
1. Ship **A** for immediate remote visibility.
2. Build **B** as `foreman serve` — daemon does ~90% already; B is a thin HTTP
   adapter + WebTUI view over the same `AgentEntry`/`BoardSummary`/`InboxEntry`
   shapes.

## Open questions (resolve before B)
- UNCONFIRMED: Is the tRPC `appRouter` cleanly importable, or welded to the
  Unix-socket adapter? Determines how much `src/web/server.ts` has to refactor.
- UNCONFIRMED: Auth model for the web surface (LAN-only? token? reverse proxy?).
- UNCONFIRMED: Per-connection vs shared session for Option A.

## Working set
- Read: `src/cli/commands/watch/{index,render,WatchLayout,WatchState,dashboard-state}.ts`,
  `src/lib/trpc-client.ts`, `src/lib/store.ts`, the tRPC router module.
- New: `src/web/server.ts`, `src/cli/commands/serve/`, WebTUI frontend assets.
- Deps (B): `@trpc/server` adapters, `ws`, `@webtui/css`, `@trpc/client`.
- Deps (A): `ttyd` (system binary), optionally `@xterm/*` for embedding.
