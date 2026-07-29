import { afterEach, describe, expect, it, vi } from "vitest";

import { ElixirServerClient, type ForemanServerCommand } from "../elixir-server-client.js";

const originalFetch = globalThis.fetch;
const fetchMock = vi.fn();

function mockJsonResponse(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

afterEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = originalFetch;
});

describe("ElixirServerClient", () => {
  it("sends commands with auth, default envelopes, and correlation headers", async () => {
    globalThis.fetch = fetchMock;
    mockJsonResponse(200, { ok: true, events: ["evt-1"], projection_version: 3, correlation_id: "corr-1" });
    const client = new ElixirServerClient("http://server.test", "token-1");
    const command: ForemanServerCommand = {
      command_id: "cmd-1",
      command_type: "task.create",
      payload: { title: "Do it" },
      metadata: { correlation_id: "corr-1" },
    };

    await expect(client.sendCommand(command)).resolves.toMatchObject({ ok: true, events: ["evt-1"] });

    expect(fetchMock).toHaveBeenCalledWith(new URL("/api/v1/commands", "http://server.test"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer token-1",
        "x-correlation-id": "corr-1",
      },
      body: JSON.stringify({ schema_version: 1, payload: { title: "Do it" }, metadata: { correlation_id: "corr-1" }, ...command }),
    });
  });

  it("keeps structured command errors and wraps unexpected HTTP statuses", async () => {
    globalThis.fetch = fetchMock;
    const command = { command_id: "cmd-2", command_type: "task.close", metadata: { correlation_id: "corr-2" } };
    const structuredError = {
      ok: false,
      error: { code: "VALIDATION_FAILED", message: "bad task", details: {}, retryable: false, correlation_id: "corr-2" },
    } as const;
    mockJsonResponse(400, structuredError);
    mockJsonResponse(500, { ok: true, events: [], projection_version: 0, correlation_id: "corr-2" });
    const client = new ElixirServerClient("http://server.test");

    await expect(client.sendCommand(command)).resolves.toEqual(structuredError);
    await expect(client.sendCommand(command)).resolves.toMatchObject({
      ok: false,
      error: { code: "INTERNAL", message: "unexpected Foreman server status 500", correlation_id: "corr-2" },
    });
  });

  it("sends worker protocol events", async () => {
    globalThis.fetch = fetchMock;
    mockJsonResponse(202, { ok: true, events: ["evt-worker"], projection_version: 4, correlation_id: "run-1" });
    const client = new ElixirServerClient("http://server.test", "token-1");

    await expect(client.sendWorkerEvent({
      run_id: "run-1",
      project_id: "proj-1",
      phase_id: "developer",
      worker_id: "node-pipeline:task-1",
      type: "phase_started",
      sequence: 1,
      details: { task_id: "task-1" },
    })).resolves.toMatchObject({ ok: true, events: ["evt-worker"] });

    expect(fetchMock).toHaveBeenCalledWith(new URL("/worker/v1/events", "http://server.test"), expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer token-1" }),
    }));
  });

  it("reads project, task, run, inbox, event, log, report, debug, and scheduler projections", async () => {
    globalThis.fetch = fetchMock;
    mockJsonResponse(200, { ok: true, projects: [{ id: "proj-1", path: "/repo" }] });
    mockJsonResponse(200, { ok: true, tasks: [{ id: "task-1", title: "Task" }] });
    mockJsonResponse(200, { ok: true, task: { id: "task-1" } });
    mockJsonResponse(200, { ok: true, runs: [{ id: "run-1" }] });
    mockJsonResponse(200, { ok: true, scheduler: { launched: 1 } });
    mockJsonResponse(200, { ok: true, inbox: [{ message_id: "msg-1" }] });
    mockJsonResponse(200, { ok: true, events: [{ event_id: "evt-1" }] });
    mockJsonResponse(200, { ok: true, logs: {run_id: "run-1", mode: "raw", entries: [{event_id: "e1", sequence: 1, type: "tool", phase_id: "dev", worker_id: "w1", stream: "stdout", message: "hello", occurred_at: "2024-01-01T00:00:00Z"}]} });
    mockJsonResponse(200, { ok: true, report: { verdict: "PASS" } });
    mockJsonResponse(200, { ok: true, debug: { phases: [] } });
    const client = new ElixirServerClient("http://server.test");

    await expect(client.listProjects()).resolves.toEqual([{ id: "proj-1", path: "/repo" }]);
    await expect(client.listTasks()).resolves.toEqual([{ id: "task-1", title: "Task" }]);
    await expect(client.getTask("task/1")).resolves.toEqual({ id: "task-1" });
    await expect(client.listRuns({ projectId: "proj-1" })).resolves.toEqual([{ id: "run-1" }]);
    await expect(client.schedulerTick()).resolves.toEqual({ launched: 1 });
    await expect(client.listInbox({ runId: "run-1", projectId: "proj-1", limit: 5, unread: true })).resolves.toEqual([{ message_id: "msg-1" }]);
    await expect(client.listEvents({ runId: "run-1", projectId: "proj-1", limit: 10 })).resolves.toEqual([{ event_id: "evt-1" }]);
    await expect(client.getRunLogs("run/1", "raw")).resolves.toEqual([{ event_id: "e1", sequence: 1, type: "tool", phase_id: "dev", worker_id: "w1", stream: "stdout", message: "hello", occurred_at: "2024-01-01T00:00:00Z" }]);
    await expect(client.getRunReport("run/1")).resolves.toEqual({ verdict: "PASS" });
    await expect(client.getDebugTimeline("run/1")).resolves.toEqual({ phases: [] });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain("http://server.test/api/v1/tasks/task%2F1");
    expect(urls).toContain("http://server.test/api/v1/runs?project_id=proj-1");
    expect(urls).toContain("http://server.test/api/v1/inbox?run_id=run-1&project_id=proj-1&limit=5&unread=true");
    expect(urls).toContain("http://server.test/api/v1/runs/run%2F1/logs?view=raw");
  });

  it("returns null for missing tasks and throws server error messages for failed reads", async () => {
    globalThis.fetch = fetchMock;
    const errorBody = { ok: false, error: { code: "INTERNAL", message: "boom", details: {}, retryable: false } };
    mockJsonResponse(404, errorBody);
    mockJsonResponse(500, errorBody);
    mockJsonResponse(500, errorBody);
    const client = new ElixirServerClient("http://server.test");

    await expect(client.getTask("missing")).resolves.toBeNull();
    await expect(client.getTask("bad")).rejects.toThrow("boom");
    await expect(client.listProjects()).rejects.toThrow("boom");
  });

  describe("empty and unparseable response bodies", () => {
    // The server intermittently answers with an empty body. Every parse site used
    // `await response.json()` unguarded, so the SyntaxError propagated out of the
    // client and killed the worker at the finalize boundary with
    // `Fatal: Unexpected end of JSON input`. A success status with no body is a
    // successful call, and a failure status with no body must report the status
    // rather than the parser's complaint.
    function mockEmptyBody(status: number): void {
      fetchMock.mockResolvedValueOnce({
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
          throw new SyntaxError("Unexpected end of JSON input");
        },
      } as unknown as Response);
    }

    it("treats an empty 202 from the worker event endpoint as success", async () => {
      globalThis.fetch = fetchMock;
      mockEmptyBody(202);
      const client = new ElixirServerClient("http://server.test", "token-1");

      await expect(client.sendWorkerEvent({
        run_id: "run-1",
        phase_id: "finalize",
        worker_id: "node-pipeline:task-1",
        type: "phase_completed",
        sequence: 9,
      })).resolves.toMatchObject({ ok: true });
    });

    it("never surfaces a JSON parse error to the caller", async () => {
      globalThis.fetch = fetchMock;
      // One empty body per parse site, so a single unguarded site fails this test.
      for (let i = 0; i < 8; i += 1) mockEmptyBody(200);
      const client = new ElixirServerClient("http://server.test");

      const calls: Array<[string, Promise<unknown>]> = [
        ["sendCommand", client.sendCommand({ command_id: "c1", command_type: "task.create" })],
        ["sendWorkerEvent", client.sendWorkerEvent({ run_id: "r", phase_id: "p", worker_id: "w", type: "t", sequence: 1 })],
        ["getTask", client.getTask("task-1")],
        ["listProjects", client.listProjects()],
        ["schedulerTick", client.schedulerTick()],
        ["checkToolPolicy", client.checkToolPolicy({ run_id: "r", phase_id: "p", tool_name: "Bash" })],
        ["getGithubRepo", client.getGithubRepo("proj", "owner", "repo")],
        ["getRunReport", client.getRunReport("run-1")],
      ];

      for (const [name, call] of calls) {
        const outcome = await call.then(
          (value) => ({ ok: true as const, value }),
          (err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) }),
        );
        if (!outcome.ok) {
          expect(outcome.message, `${name} leaked a parse error`).not.toContain("Unexpected end of JSON input");
          expect(outcome.message, `${name} leaked a parse error`).not.toContain("not valid JSON");
        }
      }
    });

    it("reports the HTTP status when an error response has no parseable body", async () => {
      globalThis.fetch = fetchMock;
      mockEmptyBody(500);
      mockEmptyBody(503);
      const client = new ElixirServerClient("http://server.test");

      await expect(client.sendCommand({ command_id: "c1", command_type: "task.create" })).resolves.toMatchObject({
        ok: false,
        error: { code: "INTERNAL", message: "unexpected Foreman server status 500" },
      });
      await expect(client.listProjects()).rejects.toThrow("unexpected Foreman server status 503");
    });

    // The tool policy is a safety gate, so it is the one endpoint that must NOT
    // degrade to a usable value. Callers deny on a throw; returning a permissive
    // default would leave the phase silently unguarded — indistinguishable from a
    // working gate, which is how the kelos tool-policy hook shipped doing nothing.
    // Without this test, "fix" the empty body by allowing the call and all the
    // other assertions here still pass.
    it("fails closed when the tool policy returns no decision", async () => {
      globalThis.fetch = fetchMock;
      mockEmptyBody(200);
      mockJsonResponse(200, { ok: true });
      const client = new ElixirServerClient("http://server.test");

      await expect(client.checkToolPolicy({ run_id: "r", phase_id: "p", tool_name: "Bash" }))
        .rejects.toThrow("unexpected Foreman server status 200");
      // A well-formed body that simply omits the decision must fail closed too.
      await expect(client.checkToolPolicy({ run_id: "r", phase_id: "p", tool_name: "Bash" }))
        .rejects.toThrow();
    });

    it("still returns null for a 404 with an empty body", async () => {
      globalThis.fetch = fetchMock;
      mockEmptyBody(404);
      const client = new ElixirServerClient("http://server.test");

      await expect(client.getTask("missing")).resolves.toBeNull();
    });
  });

  it("filters malformed log entries and returns only valid LogEntry records", async () => {
    globalThis.fetch = fetchMock;
    const validEntry = { event_id: "e1", sequence: 1, type: "tool", phase_id: "dev", worker_id: "w1", stream: "stdout", message: "valid", occurred_at: "2024-01-01T00:00:00Z" };
    const malformedEntries = [
      { event_id: "e2" }, // missing required fields
      { sequence: 2, type: "x" }, // missing event_id
      { event_id: "e3", sequence: 3, type: "tool", stream: 123, message: "bad stream type" }, // stream not string
      { event_id: "e4", sequence: 4, type: "tool", stream: "stderr", message: null }, // message is null
      validEntry,
    ];
    mockJsonResponse(200, { ok: true, logs: { run_id: "run-1", mode: "compact", entries: malformedEntries } });
    const client = new ElixirServerClient("http://server.test");

    const result = await client.getRunLogs("run-1", "compact");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(validEntry);
  });
});
