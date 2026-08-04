import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createForemanToolMcpServer } from "../foreman-tool-mcp-server.js";
import { createArtifactWriteTool, createNeedsRetryTool, type ForemanToolContext } from "../pi-sdk-tools.js";

/**
 * Foreman's workflow tools are Pi ToolDefinitions. An ACP agent runs out of process
 * and cannot see them, so they are re-exposed over MCP — which ACP passes through
 * via `session/new` mcpServers. These cover the adapter, not the tools themselves.
 */

function context(worktree: string, overrides: Partial<ForemanToolContext> = {}): ForemanToolContext {
  return {
    phase: "developer",
    runId: "run-1",
    taskId: "task-1",
    taskTitle: "Add greeting",
    worktreePath: worktree,
    reportDir: join(worktree, "reports"),
    ...overrides,
  };
}

describe("foreman tool MCP server", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), "foreman-tool-mcp-"));
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  test("advertises tool support and a protocol version on initialize", async () => {
    const server = createForemanToolMcpServer({ tools: [] });

    const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(response?.result).toMatchObject({
      capabilities: { tools: {} },
      serverInfo: { name: "foreman-tools" },
    });
    expect(response?.result).toHaveProperty("protocolVersion");
  });

  // Pi ToolDefinition.parameters is TypeBox, which IS JSON Schema, so the schema
  // transfers verbatim. Re-describing it by hand would let the two drift.
  test("lists tools with their Pi parameter schema as the MCP inputSchema", async () => {
    const tool = createArtifactWriteTool(context(worktree));
    const server = createForemanToolMcpServer({ tools: [tool] });

    const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (response?.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("artifact_write");
    expect(tools[0].inputSchema).toEqual(tool.parameters);
  });

  test("executes a tool call and returns its content blocks", async () => {
    const server = createForemanToolMcpServer({ tools: [createArtifactWriteTool(context(worktree))] });

    const response = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "artifact_write", arguments: { fileName: "DEVELOPER_REPORT.md", content: "# Done\n" } },
    });

    expect(readFileSync(join(worktree, "reports", "DEVELOPER_REPORT.md"), "utf-8")).toBe("# Done\n");
    expect(response?.result).toMatchObject({ content: [{ type: "text" }] });
    expect(response?.error).toBeUndefined();
  });

  // MCP reports tool failures as isError on the result, not a JSON-RPC error: a
  // protocol-level error reads as "the server broke" and can abort the session,
  // whereas the agent should see the message and correct course.
  test("reports a failing tool as isError rather than a JSON-RPC error", async () => {
    const server = createForemanToolMcpServer({ tools: [createArtifactWriteTool(context(worktree))] });

    const response = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      // Absolute path escapes the report directory and is rejected by the tool.
      params: { name: "artifact_write", arguments: { fileName: "/etc/passwd", content: "x" } },
    });

    expect(response?.error).toBeUndefined();
    expect(response?.result).toMatchObject({ isError: true });
  });

  test("returns a JSON-RPC error for an unknown tool", async () => {
    const server = createForemanToolMcpServer({ tools: [] });

    const response = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "no_such_tool", arguments: {} },
    });

    expect(response?.error?.message).toMatch(/no_such_tool/);
  });

  // abort_phase and needs_retry are control flow, not effects. Over MCP their
  // return value is just text to the agent, so the server has to surface the
  // controlOutcome out-of-band or the phase silently continues past an abort.
  test("captures a control outcome so the runner can act on it", async () => {
    const server = createForemanToolMcpServer({
      tools: [createNeedsRetryTool(null, context(worktree))],
    });

    await server.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "needs_retry", arguments: { reason: "flaky upstream" } },
    });

    expect(server.controlOutcome()).toMatchObject({ type: "NEEDS_RETRY", reason: "flaky upstream" });
  });

  test("has no control outcome before any control tool runs", () => {
    const server = createForemanToolMcpServer({ tools: [] });

    expect(server.controlOutcome()).toBeUndefined();
  });

  // The first control signal decides the phase; a later tool call must not
  // overwrite an abort with something weaker.
  test("keeps the first control outcome when a second control tool runs", async () => {
    const ctx = context(worktree);
    const server = createForemanToolMcpServer({
      tools: [createNeedsRetryTool(null, ctx)],
    });
    const call = (reason: string) =>
      server.handle({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "needs_retry", arguments: { reason } },
      });

    await call("first");
    await call("second");

    expect(server.controlOutcome()).toMatchObject({ reason: "first" });
  });

  test("ignores notifications, which carry no id and expect no reply", async () => {
    const server = createForemanToolMcpServer({ tools: [] });

    const response = await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });

    expect(response).toBeNull();
  });

  test("rejects an unknown method with method-not-found", async () => {
    const server = createForemanToolMcpServer({ tools: [] });

    const response = await server.handle({ jsonrpc: "2.0", id: 7, method: "resources/list" });

    expect(response?.error?.code).toBe(-32601);
  });
});

describe("foreman tool MCP server over HTTP", () => {
  let worktree: string;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), "foreman-tool-mcp-http-"));
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  // The Claude ACP adapter advertises mcpCapabilities {http, sse} but NOT stdio,
  // so the server has to be reachable over HTTP for session/new to pass it through.
  test("serves tools/call over HTTP on an ephemeral port", async () => {
    const server = createForemanToolMcpServer({
      tools: [createArtifactWriteTool(context(worktree))],
    });
    const listening = await server.listen("127.0.0.1", 0);

    try {
      const response = await fetch(`${listening.url}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "artifact_write", arguments: { fileName: "R.md", content: "ok\n" } },
        }),
      });
      const body = (await response.json()) as { result?: { isError?: boolean } };

      expect(response.status).toBe(200);
      expect(body.result?.isError).toBeUndefined();
      expect(readFileSync(join(worktree, "reports", "R.md"), "utf-8")).toBe("ok\n");
    } finally {
      await listening.close();
    }
  });

  // A port chosen up front can be taken by the time the server binds, and every
  // concurrent phase runs its own server — so the port must be assigned by the OS
  // and reported back, never guessed.
  test("reports the bound port so concurrent phases cannot collide", async () => {
    const a = createForemanToolMcpServer({ tools: [] });
    const b = createForemanToolMcpServer({ tools: [] });
    const first = await a.listen("127.0.0.1", 0);
    const second = await b.listen("127.0.0.1", 0);

    try {
      expect(first.port).toBeGreaterThan(0);
      expect(second.port).toBeGreaterThan(0);
      expect(first.port).not.toBe(second.port);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
