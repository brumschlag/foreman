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
  "KELOS_WORKTREE_PVC",
  "KELOS_WORKTREE_MOUNT",
  "KELOS_AGENT_ENV",
  "KELOS_AGENT_ENV_FROM_SECRET",
  "KELOS_LOCAL_WORKTREE",
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

  // Sequential Job-per-phase over Foreman's own EBS PVC: phases run one at a
  // time, so ReadWriteOnce is sufficient and no RWX/EFS storage is needed. The
  // agent works directly in Foreman's worktree, so nothing is pushed.
  test("mounts Foreman's worktree PVC when one is configured", () => {
    process.env.KELOS_NAMESPACE = "kelos-pilot";
    process.env.KELOS_WORKTREE_PVC = "foreman-worktree-pvc";

    const cfg = kelosBackendConfigFromEnv();

    // Mounts at /workspace, not /workspace/repo: kelos only sets the agent's
    // WorkingDir when the Task has a workspaceRef, and a shared-worktree Task
    // deliberately omits one so kelos does not clone. Without that, the agent
    // starts in /workspace, so anything mounted deeper is missed entirely.
    expect(cfg.sharedWorktree).toEqual({
      claimName: "foreman-worktree-pvc",
      mountPath: "/workspace",
    });
  });

  test("allows overriding the worktree mount path", () => {
    process.env.KELOS_NAMESPACE = "kelos-pilot";
    process.env.KELOS_WORKTREE_PVC = "pvc";
    process.env.KELOS_WORKTREE_MOUNT = "/src";

    expect(kelosBackendConfigFromEnv().sharedWorktree?.mountPath).toBe("/src");
  });

  // A pooled worker owns its own workspace, so mounting Foreman's worktree into
  // it would be two conflicting sources of truth for the same files.
  test("rejects combining a worker pool with a shared worktree PVC", () => {
    process.env.KELOS_NAMESPACE = "kelos-pilot";
    process.env.KELOS_WORKER_POOL = "some-pool";
    process.env.KELOS_WORKTREE_PVC = "pvc";

    expect(() => kelosBackendConfigFromEnv()).toThrow(/KELOS_WORKER_POOL.*KELOS_WORKTREE_PVC|mutually exclusive/i);
  });

  test("has no shared worktree when the PVC is unset", () => {
    process.env.KELOS_NAMESPACE = "kelos-pilot";

    expect(kelosBackendConfigFromEnv().sharedWorktree).toBeUndefined();
  });

  // A non-pooled Task creates its own Job and inherits nothing, so gateway auth
  // has to be supplied per-Task. Unlike a pooled Task, it CAN use podOverrides.
  describe("agent environment for the non-pooled path", () => {
    test("passes literal env vars through podOverrides", () => {
      process.env.KELOS_NAMESPACE = "kelos-pilot";
      process.env.KELOS_AGENT_ENV =
        "ANTHROPIC_BASE_URL=http://bedrock-gateway.honcho.svc.cluster.local,MAX_THINKING_TOKENS=0";

      const cfg = kelosBackendConfigFromEnv();

      expect(cfg.podOverrides).toEqual({
        env: [
          { name: "ANTHROPIC_BASE_URL", value: "http://bedrock-gateway.honcho.svc.cluster.local" },
          { name: "MAX_THINKING_TOKENS", value: "0" },
        ],
      });
    });

    // The gateway key must arrive as a secret reference, never a literal, so the
    // token is not baked into the Task object where anyone with read access
    // to the namespace could see it.
    test("references secrets rather than inlining their values", () => {
      process.env.KELOS_NAMESPACE = "kelos-pilot";
      process.env.KELOS_AGENT_ENV_FROM_SECRET =
        "ANTHROPIC_AUTH_TOKEN=honcho-gateway-key:gateway-api-key";

      const cfg = kelosBackendConfigFromEnv();

      expect(cfg.podOverrides).toEqual({
        env: [
          {
            name: "ANTHROPIC_AUTH_TOKEN",
            valueFrom: { secretKeyRef: { name: "honcho-gateway-key", key: "gateway-api-key" } },
          },
        ],
      });
    });

    test("has no podOverrides when no agent env is configured", () => {
      process.env.KELOS_NAMESPACE = "kelos-pilot";

      expect(kelosBackendConfigFromEnv().podOverrides).toBeUndefined();
    });

    // podOverrides is rejected alongside workerPoolRef, so configuring both is a
    // misconfiguration that would fail at the API server.
    test("rejects agent env on the pooled path", () => {
      process.env.KELOS_NAMESPACE = "kelos-pilot";
      process.env.KELOS_WORKER_POOL = "some-pool";
      process.env.KELOS_AGENT_ENV = "FOO=bar";

      expect(() => kelosBackendConfigFromEnv()).toThrow(/KELOS_AGENT_ENV|pooled/i);
    });
  });

  // With a shared worktree, the agent's cwd is a pod mount path that does not
  // exist on Foreman's machine, so git must run against Foreman's own path.
  test("reads Foreman's local worktree path for the volume transport", () => {
    process.env.KELOS_NAMESPACE = "kelos-pilot";
    process.env.KELOS_WORKTREE_PVC = "pvc";
    process.env.KELOS_LOCAL_WORKTREE = "/home/me/worktrees/task-1";

    expect(kelosBackendConfigFromEnv().localWorktreePath).toBe("/home/me/worktrees/task-1");
  });

  test("has no local worktree override when unset", () => {
    process.env.KELOS_NAMESPACE = "kelos-pilot";

    expect(kelosBackendConfigFromEnv().localWorktreePath).toBeUndefined();
  });
});
