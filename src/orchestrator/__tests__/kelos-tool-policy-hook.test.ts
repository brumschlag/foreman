/**
 * Tests for the PreToolUse hook that enforces Foreman's tool policy inside a
 * kelos agent pod.
 *
 * Claude Code hooks fail OPEN: any exit code other than 2 lets the tool run, and
 * that includes a hook crash, a timeout, or an unreachable endpoint. For a safety
 * gate that inverts the failure mode, so these tests pin the fail-closed
 * behaviour — an unreachable or malformed policy response must deny.
 *
 * The script is exercised as a real process with a stub server, because the
 * behaviour under test is its exit code, not its logic.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { toolPolicyHookPath } from "../kelos-tool-policy-hook.js";

let stub: ChildProcess | undefined;

afterEach(() => {
  stub?.kill("SIGKILL");
  stub = undefined;
});

/**
 * Runs the stub policy server in a SEPARATE PROCESS. The hook is invoked with
 * execFileSync, which blocks this process's event loop — an in-process server would
 * never get to answer and every case would look like an unreachable endpoint.
 */
async function stubPolicyServer(status: number, body: unknown): Promise<string> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const script = `
import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length', 0)))
        data = ${JSON.stringify(payload)}.encode()
        self.send_response(${status})
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *a): pass
srv = http.server.HTTPServer(('127.0.0.1', 0), H)
print(srv.server_port, flush=True)
srv.serve_forever()
`;
  stub = spawn("python3", ["-c", script], { stdio: ["ignore", "pipe", "ignore"] });
  const port = await new Promise<string>((resolve, reject) => {
    stub!.stdout!.once("data", (d) => resolve(String(d).trim()));
    stub!.once("error", reject);
  });
  return `http://127.0.0.1:${port}`;
}

const HOOK_INPUT = JSON.stringify({
  hook_event_name: "PreToolUse",
  tool_use_id: "toolu_01ABC",
  tool_name: "Bash",
  tool_input: { command: "rm -rf /" },
  session_id: "sess-1",
});

/** Runs the hook, returning its exit code and stderr. */
function runHook(env: Record<string, string>): { status: number; stderr: string } {
  try {
    execFileSync("sh", [toolPolicyHookPath()], {
      input: HOOK_INPUT,
      env: { ...process.env, ...env },
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? -1, stderr: e.stderr ?? "" };
  }
}

describe("tool policy PreToolUse hook", () => {
  test("allows the tool when the policy permits it", async () => {
    const url = await stubPolicyServer(200, {
      ok: true,
      decision: { allowed: true, action: "allow", reason: "fine" },
    });

    const { status } = runHook({ FOREMAN_SERVER_URL: url, FOREMAN_WORKER_EVENT_TOKEN: "t" });

    expect(status).toBe(0);
  });

  // Exit 2 is the only code Claude Code treats as blocking.
  test("blocks with exit 2 when the policy denies", async () => {
    const url = await stubPolicyServer(200, {
      ok: true,
      decision: { allowed: false, action: "deny", reason: "destructive command" },
    });

    const { status, stderr } = runHook({
      FOREMAN_SERVER_URL: url,
      FOREMAN_WORKER_EVENT_TOKEN: "t",
    });

    expect(status).toBe(2);
    // stderr is what the model is shown, so the reason has to reach it.
    expect(stderr).toContain("destructive command");
  });

  // The failure that matters: Foreman is unreachable from the pod. Claude Code
  // would let the tool run, so the hook must deny instead.
  test("denies when the policy endpoint is unreachable", () => {
    const { status, stderr } = runHook({
      // Nothing is listening on this port.
      FOREMAN_SERVER_URL: "http://127.0.0.1:1",
      FOREMAN_WORKER_EVENT_TOKEN: "t",
    });

    expect(status).toBe(2);
    expect(stderr).toMatch(/unavailable|unreachable|could not/i);
  });

  test("denies when the endpoint returns an error status", async () => {
    const url = await stubPolicyServer(500, undefined);

    const { status } = runHook({ FOREMAN_SERVER_URL: url, FOREMAN_WORKER_EVENT_TOKEN: "t" });

    expect(status).toBe(2);
  });

  // A response the hook cannot parse must not be read as permission.
  test("denies when the response is not a recognisable decision", async () => {
    const url = await stubPolicyServer(200, { unexpected: true });

    const { status } = runHook({ FOREMAN_SERVER_URL: url, FOREMAN_WORKER_EVENT_TOKEN: "t" });

    expect(status).toBe(2);
  });

  // Without configuration the hook cannot consult the authority at all, so it
  // must not quietly become a no-op.
  test("denies when no server URL is configured", () => {
    const { status } = runHook({ FOREMAN_SERVER_URL: "", FOREMAN_WORKER_EVENT_TOKEN: "" });

    expect(status).toBe(2);
  });
});
