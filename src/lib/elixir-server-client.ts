export type ForemanServerCommand = {
  command_id: string;
  command_type: string;
  schema_version?: number;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type ForemanServerOk = {
  ok: true;
  events: string[];
  projection_version: number;
  correlation_id: string;
};

export type ForemanServerError = {
  ok: false;
  error: {
    code: "VALIDATION_FAILED" | "CONFLICT" | "UNAUTHORIZED" | "UNSUPPORTED" | "INTERNAL";
    message: string;
    details: Record<string, unknown>;
    retryable: boolean;
    correlation_id?: string;
  };
};

export type ForemanServerResponse = ForemanServerOk | ForemanServerError;

export type ElixirProject = {
  project_id?: string;
  id?: string;
  name?: string;
  path: string;
  status?: string;
  default_branch?: string;
  config?: Record<string, unknown>;
  health?: Record<string, unknown>;
  updated_at?: string;
};

export type ElixirTask = {
  task_id?: string;
  id?: string;
  project_id?: string;
  title?: string;
  description?: string | null;
  task_type?: string;
  type?: string;
  priority?: number;
  status?: string;
  external_id?: string | null;
  updated_at?: string;
  created_at?: string;
  closed_at?: string | null;
  approved_at?: string | null;
  annotations?: Array<{ body: string; author?: string; created_at?: string }>;
  dependencies?: string[];
  run_id?: string | null;
  phase_id?: string | null;
};

export type ElixirRun = Record<string, unknown> & {
  run_id?: string;
  id?: string;
  project_id?: string;
  task_id?: string;
  status?: string;
  costUsd?: number;
  turns?: number;
  totalDurationMs?: number;
  costPerTurn?: number;
  timePerTurn?: number;
  phase_order?: unknown[];
};

export type ElixirInboxMessage = Record<string, unknown> & {
  message_id?: string;
  run_id?: string;
  task_id?: string;
  project_id?: string;
  unread?: boolean;
};

export type ElixirEvent = Record<string, unknown> & {
  event_id?: string;
  run_id?: string;
  project_id?: string;
  type?: string;
  event_type?: string;
};

export type LogEntry = {
  event_id: string;
  sequence: number;
  type: string;
  phase_id: string | null;
  worker_id: string | null;
  stream: string;
  message: string;
  occurred_at: string;
};

function isValidLogEntry(value: unknown): value is LogEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.event_id === "string" &&
    typeof entry.sequence === "number" &&
    typeof entry.type === "string" &&
    (entry.phase_id === null || typeof entry.phase_id === "string") &&
    (entry.worker_id === null || typeof entry.worker_id === "string") &&
    typeof entry.stream === "string" &&
    typeof entry.message === "string" &&
    typeof entry.occurred_at === "string"
  );
}

/**
 * Reads a response body as JSON, yielding `undefined` rather than throwing when
 * there is nothing to parse.
 *
 * The server intermittently answers with an empty body. Every call site here
 * used `await response.json()` unguarded, so the resulting SyntaxError escaped
 * the client and killed the worker at the finalize boundary with
 * `Fatal: Unexpected end of JSON input` — a transport detail presented as a
 * pipeline failure. Callers decide what an absent body means for them, which
 * differs by endpoint: for a 2xx it is a successful call with nothing to report,
 * for an error status it must surface the status instead of the parser's
 * complaint.
 */
async function parseJsonBody(response: Response): Promise<unknown | undefined> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** True when the body carries a structured `{ ok: false, error }` envelope. */
function isServerError(body: unknown): body is ForemanServerError {
  return typeof body === "object"
    && body !== null
    && (body as { ok?: unknown }).ok === false
    && typeof (body as { error?: unknown }).error === "object"
    && (body as { error?: unknown }).error !== null;
}

/**
 * The error to raise for a response that did not yield a usable body: the
 * server's own message when it sent one, otherwise the HTTP status.
 */
function responseError(response: Response, body: unknown): Error {
  if (isServerError(body)) return new Error(body.error.message);
  return new Error(`unexpected Foreman server status ${response.status}`);
}

export class ElixirServerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly authToken?: string,
  ) {}

  async sendCommand(command: ForemanServerCommand): Promise<ForemanServerResponse> {
    const response = await fetch(new URL("/api/v1/commands", this.baseUrl), {
      method: "POST",
      headers: this.headers(command),
      body: JSON.stringify({ schema_version: 1, payload: {}, metadata: {}, ...command }),
    });

    const parsed = await parseJsonBody(response);
    // An empty body on a success status is a successful command with nothing to
    // report; synthesise the envelope so callers checking `.ok` still work.
    const body = (parsed ?? (response.ok
      ? { ok: true, events: [], projection_version: 0, correlation_id: command.metadata?.correlation_id as string | undefined ?? command.command_id }
      : { ok: true })) as ForemanServerResponse;
    if (!body.ok || response.ok) return body;

    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `unexpected Foreman server status ${response.status}`,
        details: body,
        retryable: false,
        correlation_id: command.metadata?.correlation_id as string | undefined,
      },
    };
  }

  async listProjects(): Promise<ElixirProject[]> {
    const body = await this.getJson<{ ok: true; projects: ElixirProject[] }>("/api/v1/projects");
    return body.projects;
  }

  async listTasks(): Promise<ElixirTask[]> {
    const body = await this.getJson<{ ok: true; tasks: ElixirTask[] }>("/api/v1/tasks");
    return body.tasks;
  }

  async getGithubRepo(projectId: string, owner: string, repo: string): Promise<unknown | null> {
    const response = await fetch(new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, this.baseUrl), {
      method: "GET",
      headers: this.headers({ command_id: `github-repo-get-${projectId}-${owner}-${repo}`, command_type: "github.repo.get" }),
    });
    if (response.status === 404) return null;
    const body = await parseJsonBody(response);
    if (response.ok && !isServerError(body)) return (body as { repo?: unknown } | undefined)?.repo ?? null;
    throw responseError(response, body);
  }

  async upsertGithubRepo(input: Record<string, unknown>): Promise<unknown> {
    const response = await this.sendCommand({
      command_id: `github-repo-upsert-${input.project_id ?? input.projectId ?? "project"}-${Date.now()}`,
      command_type: "github.repo.upsert",
      payload: input,
    });
    if (!response.ok) throw new Error(response.error.message);
    return (response as ForemanServerOk & { data?: unknown }).data ?? input;
  }

  async listGithubSyncEvents(projectId: string, repoId?: string, limit?: number): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (repoId) params.set("repo_id", repoId);
    if (limit !== undefined) params.set("limit", String(limit));
    const query = params.toString();
    const body = await this.getJson<{ ok: true; events: unknown[] }>(`/api/v1/projects/${encodeURIComponent(projectId)}/github/sync-events${query ? `?${query}` : ""}`);
    return body.events;
  }

  async getTask(taskId: string): Promise<ElixirTask | null> {
    const response = await fetch(new URL(`/api/v1/tasks/${encodeURIComponent(taskId)}`, this.baseUrl), {
      method: "GET",
      headers: this.headers({ command_id: `task-get-${taskId}`, command_type: "task.get" }),
    });
    if (response.status === 404) return null;
    const body = await parseJsonBody(response);
    if (response.ok && !isServerError(body)) return (body as { task?: ElixirTask } | undefined)?.task ?? null;
    throw responseError(response, body);
  }

  async listRuns(opts: { projectId?: string } = {}): Promise<ElixirRun[]> {
    const params = new URLSearchParams();
    if (opts.projectId) params.set("project_id", opts.projectId);
    const query = params.toString();
    const body = await this.getJson<{ ok: true; runs: ElixirRun[] }>(`/api/v1/runs${query ? `?${query}` : ""}`);
    return body.runs;
  }

  async schedulerTick(): Promise<unknown> {
    const response = await fetch(new URL("/api/v1/scheduler/tick", this.baseUrl), {
      method: "POST",
      headers: this.headers({ command_id: "scheduler-tick", command_type: "scheduler.tick" }),
      body: JSON.stringify({}),
    });
    const body = await parseJsonBody(response);
    if (response.ok && !isServerError(body)) return (body as { scheduler?: unknown } | undefined)?.scheduler;
    throw responseError(response, body);
  }

  async sendWorkerEvent(payload: {
    run_id: string;
    phase_id: string;
    worker_id: string;
    type: string;
    sequence: number;
    project_id?: string;
    status?: string;
    message?: string;
    output?: string;
    exit_code?: number;
    artifact_paths?: string[];
    report_paths?: string[];
    tool_call_id?: string;
    tool_name?: string;
    details?: Record<string, unknown>;
  }): Promise<ForemanServerOk> {
    const response = await fetch(new URL("/worker/v1/events", this.baseUrl), {
      method: "POST",
      headers: this.headers({ command_id: `worker-event-${payload.run_id}-${payload.sequence}`, command_type: "worker.event" }),
      body: JSON.stringify(payload),
    });
    const body = await parseJsonBody(response);
    // The event was accepted; an empty body means the server had nothing to add,
    // not that the append failed. Throwing here is what killed the worker mid-run.
    if (response.ok && !isServerError(body)) {
      return (body as ForemanServerOk | undefined)
        ?? { ok: true, events: [], projection_version: 0, correlation_id: payload.run_id };
    }
    throw responseError(response, body);
  }

  async checkToolPolicy(payload: {
    run_id: string;
    task_id?: string;
    phase_id: string;
    worker_id?: string;
    sequence?: number;
    tool_call_id?: string;
    tool_name: string;
    args?: Record<string, unknown>;
  }): Promise<{ allowed: boolean; action: string; reason: string; message?: string | null }> {
    const response = await fetch(new URL("/worker/v1/tool-policy", this.baseUrl), {
      method: "POST",
      headers: this.headers({ command_id: `tool-policy-${payload.run_id}-${payload.tool_call_id ?? payload.tool_name}`, command_type: "worker.tool_policy" }),
      body: JSON.stringify(payload),
    });
    const body = await parseJsonBody(response);
    const decision = response.ok && !isServerError(body)
      ? (body as { decision?: { allowed: boolean; action: string; reason: string; message?: string | null } } | undefined)?.decision
      : undefined;
    // This is a safety gate, so it fails CLOSED: a missing decision must never
    // read as "allowed". Callers deny on a throw; degrading to a permissive
    // default here would silently unguard the phase.
    if (decision) return decision;
    throw responseError(response, body);
  }

  async listInbox(opts: { runId?: string; projectId?: string; limit?: number; unread?: boolean } = {}): Promise<ElixirInboxMessage[]> {
    const params = new URLSearchParams();
    if (opts.runId) params.set("run_id", opts.runId);
    if (opts.projectId) params.set("project_id", opts.projectId);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.unread !== undefined) params.set("unread", String(opts.unread));
    const query = params.toString();
    const body = await this.getJson<{ ok: true; inbox: ElixirInboxMessage[] }>(`/api/v1/inbox${query ? `?${query}` : ""}`);
    return body.inbox;
  }

  async listEvents(opts: { runId?: string; projectId?: string; limit?: number } = {}): Promise<ElixirEvent[]> {
    const params = new URLSearchParams();
    if (opts.runId) params.set("run_id", opts.runId);
    if (opts.projectId) params.set("project_id", opts.projectId);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const query = params.toString();
    const body = await this.getJson<{ ok: true; events: ElixirEvent[] }>(`/api/v1/events${query ? `?${query}` : ""}`);
    return body.events;
  }

  async getRunLogs(runId: string, view: "compact" | "raw" = "compact", limit?: number): Promise<LogEntry[]> {
    const params = new URLSearchParams({ view });
    if (limit !== undefined) params.set("limit", String(limit));
    const query = params.toString();
    const body = await this.getJson<{ ok: true; logs: { run_id: string; mode: string; entries: unknown[] } }>(`/api/v1/runs/${encodeURIComponent(runId)}/logs?${query}`);
    return body.logs.entries.filter(isValidLogEntry);
  }

  async getRunReport(runId: string): Promise<unknown> {
    const body = await this.getJson<{ ok: true; report: unknown }>(`/api/v1/runs/${encodeURIComponent(runId)}/report`);
    return body.report;
  }

  async getDebugTimeline(runId: string): Promise<unknown> {
    const body = await this.getJson<{ ok: true; debug: unknown }>(`/api/v1/runs/${encodeURIComponent(runId)}/debug`);
    return body.debug;
  }

  async getMetrics(): Promise<{
    total_cost?: number | string;
    total_turns?: number;
    cost_per_turn?: number | string;
    total_time_seconds?: number;
    time_per_turn_seconds?: number | string;
  }> {
    const body = await this.getJson<{
      ok: boolean;
      metrics: {
        total_cost?: number | string;
        total_turns?: number;
        cost_per_turn?: number | string;
        total_time_seconds?: number;
        time_per_turn_seconds?: number | string;
      };
    }>("/api/v1/metrics");
    return body.metrics ?? {};
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: "GET",
      headers: this.headers({ command_id: `read-${path}`, command_type: "read" }),
    });
    const body = await parseJsonBody(response);
    // Reads must not invent data: an absent body cannot satisfy a caller that is
    // about to destructure `.projects`/`.tasks`, so this still throws — but with
    // the status rather than a parser error.
    if (response.ok && body !== undefined && !isServerError(body)) return body as T;
    throw responseError(response, body);
  }

  private headers(command: ForemanServerCommand): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    const correlationId = command.metadata?.correlation_id;
    if (typeof correlationId === "string") headers["x-correlation-id"] = correlationId;
    if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;

    return headers;
  }
}
