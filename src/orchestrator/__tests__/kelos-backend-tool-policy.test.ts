/**
 * The kelos backend must pass a phase's tool policy through to the client.
 *
 * Phase 5 built the install machinery (toolPolicyInstallCommands / hook env) and
 * made kelos-phase-runner's refusal conditional on
 * KelosClient.enforcesToolPolicy — but kelos-backend never populated the client's
 * `toolPolicy` option. So on the real backend the flag was always false and every
 * policy-gated phase was still refused. The first live kelos dispatch failed on
 * exactly this, one layer below where the wiring stopped.
 */

import { afterEach, describe, expect, it } from "vitest";
import { kelosBackendConfigFromEnv } from "../kelos-backend.js";

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

describe("kelosBackendConfigFromEnv tool policy", () => {
  it("derives a tool policy from the server URL and auth token", () => {
    process.env.KELOS_NAMESPACE = "kelos-pilot";
    process.env.FOREMAN_SERVER_URL = "http://foreman-server.kelos-pilot.svc.cluster.local:4766";
    process.env.FOREMAN_SERVER_AUTH_TOKEN = "server-token";

    const config = kelosBackendConfigFromEnv();

    expect(config.toolPolicyServerUrl).toBe(
      "http://foreman-server.kelos-pilot.svc.cluster.local:4766",
    );
    expect(config.toolPolicyAuthToken).toBe("server-token");
  });

  it("prefers the worker event token when present", () => {
    // The hook accepts either; the worker token is the narrower credential.
    process.env.KELOS_NAMESPACE = "kelos-pilot";
    process.env.FOREMAN_SERVER_URL = "http://foreman-server:4766";
    process.env.FOREMAN_SERVER_AUTH_TOKEN = "server-token";
    process.env.FOREMAN_WORKER_EVENT_TOKEN = "worker-token";

    expect(kelosBackendConfigFromEnv().toolPolicyAuthToken).toBe("worker-token");
  });

  it("leaves the policy endpoint undefined when the server URL is unset", () => {
    // Without a reachable server the hook would deny every tool call, so the
    // phase must still be refused rather than run unguarded.
    process.env.KELOS_NAMESPACE = "kelos-pilot";
    delete process.env.FOREMAN_SERVER_URL;

    expect(kelosBackendConfigFromEnv().toolPolicyServerUrl).toBeUndefined();
  });
});
