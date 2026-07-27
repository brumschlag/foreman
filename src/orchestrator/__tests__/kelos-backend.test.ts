import { afterEach, describe, expect, test } from "vitest";
import { kelosBackendConfigFromEnv } from "../kelos-backend.js";

const VARS = [
  "KELOS_NAMESPACE",
  "KELOS_CONTEXT",
  "KELOS_WORKER_POOL",
  "KELOS_WORKSPACE",
  "KELOS_AGENT_TYPE",
  "KELOS_MODEL_ENV",
  "KELOS_POLL_INTERVAL_MS",
];

afterEach(() => {
  for (const v of VARS) delete process.env[v];
});

describe("kelos backend config", () => {
  test("reads pool dispatch settings from the environment", () => {
    process.env.KELOS_NAMESPACE = "kelos-pilot";
    process.env.KELOS_CONTEXT = "my-eks";
    process.env.KELOS_WORKER_POOL = "envoverrides-pool";

    const cfg = kelosBackendConfigFromEnv();

    expect(cfg.namespace).toBe("kelos-pilot");
    expect(cfg.context).toBe("my-eks");
    expect(cfg.workerPool).toBe("envoverrides-pool");
  });

  test("requires a namespace rather than silently defaulting", () => {
    expect(() => kelosBackendConfigFromEnv()).toThrow(/KELOS_NAMESPACE/);
  });

  // The phase's model must reach a pooled task through envOverrides, since the
  // CRD forbids podOverrides alongside workerPoolRef. KELOS_MODEL_ENV names the
  // variable the agent image reads (ANTHROPIC_MODEL for the gateway path).
  test("maps the phase model onto the configured model env var", () => {
    process.env.KELOS_NAMESPACE = "kelos-pilot";
    process.env.KELOS_WORKER_POOL = "envoverrides-pool";
    process.env.KELOS_MODEL_ENV = "ANTHROPIC_MODEL";

    const cfg = kelosBackendConfigFromEnv();

    expect(cfg.envOverridesFor("claude-haiku")).toEqual([
      { name: "ANTHROPIC_MODEL", value: "claude-haiku" },
    ]);
  });

  test("sends no env overrides when no model env var is configured", () => {
    process.env.KELOS_NAMESPACE = "kelos-pilot";

    const cfg = kelosBackendConfigFromEnv();

    expect(cfg.envOverridesFor("claude-haiku")).toEqual([]);
  });
});
