import { describe, expect, test } from "vitest";
import {
  createKelosCrdClient,
  type KelosApi,
  type KelosCrdClientOptions,
  type KelosTaskObject,
} from "../kelos-client.js";

function api(overrides: Partial<KelosApi> = {}): KelosApi {
  return {
    createTask: async () => "task-generated",
    getTask: async () => ({ status: { phase: "Succeeded" } }) as KelosTaskObject,
    ...overrides,
  };
}

const request = {
  prompt: "implement the thing",
  systemPrompt: "you are the developer",
  model: "anthropic/claude-sonnet-4-6",
  phaseName: "developer",
  taskId: "task-1",
};

const CREDENTIALS = { type: "oauth", secretRef: { name: "claude-oauth-token" } };

function clientOptions(overrides: Partial<KelosCrdClientOptions> = {}): KelosCrdClientOptions {
  return {
    api: api(),
    workspace: "my-workspace",
    agentType: "claude-code",
    credentials: CREDENTIALS,
    pollIntervalMs: 0,
    ...overrides,
  };
}

describe("kelos CRD client", () => {
  test("creates a Task carrying the phase prompt, model, and workspace", async () => {
    let created: Record<string, unknown> | undefined;
    const client = createKelosCrdClient(
      clientOptions({
        api: api({
          createTask: async (task) => {
            created = task as unknown as Record<string, unknown>;
            return "kelos-task-1";
          },
        }),
      }),
    );

    await client.runTask(request);

    expect(created).toMatchObject({
      apiVersion: "kelos.dev/v1alpha2",
      kind: "Task",
      spec: {
        type: "claude-code",
        model: "anthropic/claude-sonnet-4-6",
        workspaceRef: { name: "my-workspace" },
      },
    });
    const spec = (created as { spec: { prompt: string } }).spec;
    expect(spec.prompt).toContain("implement the thing");
    expect(spec.prompt).toContain("you are the developer");
  });

  // The kelos Task CRD enforces "type with credentials is required" (verified by
  // server dry-run against tasks.kelos.dev v1alpha2); a Task without credentials
  // is rejected by the API server.
  test("includes credentials so the Task passes kelos CRD validation", async () => {
    let created: { spec?: Record<string, unknown> } | undefined;
    const client = createKelosCrdClient(
      clientOptions({
        api: api({
          createTask: async (task) => {
            created = task as { spec?: Record<string, unknown> };
            return "kelos-task-1";
          },
        }),
      }),
    );

    await client.runTask(request);

    expect(created?.spec).toMatchObject({
      credentials: { type: "oauth", secretRef: { name: "claude-oauth-token" } },
    });
  });

  // Bedrock-routed agents take credentials: {type: none} plus AWS env in
  // podOverrides (kelos examples/09-bedrock-credentials).
  test("passes podOverrides through so the agent can be routed via Bedrock", async () => {
    let created: { spec?: Record<string, unknown> } | undefined;
    const podOverrides = {
      env: [
        { name: "CLAUDE_CODE_USE_BEDROCK", value: "1" },
        { name: "AWS_REGION", value: "us-east-1" },
      ],
    };
    const client = createKelosCrdClient(
      clientOptions({
        api: api({
          createTask: async (task) => {
            created = task as { spec?: Record<string, unknown> };
            return "kelos-task-1";
          },
        }),
        podOverrides,
      }),
    );

    await client.runTask(request);

    expect(created?.spec).toMatchObject({ podOverrides });
  });

  test("polls until the Task reaches a terminal phase, then maps its results", async () => {
    const phases = ["Pending", "Running", "Succeeded"];
    let calls = 0;
    const client = createKelosCrdClient(clientOptions({
      api: api({
        getTask: async () => {
          const phase = phases[Math.min(calls++, phases.length - 1)];
          return {
            status: {
              phase,
              results:
                phase === "Succeeded"
                  ? {
                      branch: "kelos/task-1",
                      commit: "abc123",
                      "cost-usd": "0.25",
                      "input-tokens": "900",
                      "output-tokens": "150",
                    }
                  : undefined,
            },
          } as KelosTaskObject;
        },
      }),
    }));

    const result = await client.runTask(request);

    expect(calls).toBe(3);
    expect(result.succeeded).toBe(true);
    expect(result.branch).toBe("kelos/task-1");
    expect(result.commit).toBe("abc123");
    expect(result.costUsd).toBe(0.25);
    expect(result.inputTokens).toBe(900);
    expect(result.outputTokens).toBe(150);
  });

  test("reports a failed Task as unsuccessful with the status message", async () => {
    const client = createKelosCrdClient(
      clientOptions({
        api: api({
          getTask: async () =>
            ({ status: { phase: "Failed", message: "pod evicted" } }) as KelosTaskObject,
        }),
      }),
    );

    const result = await client.runTask(request);

    expect(result.succeeded).toBe(false);
    expect(result.errorMessage).toBe("pod evicted");
  });

  test("gives up after the configured timeout instead of polling forever", async () => {
    const client = createKelosCrdClient(
      clientOptions({
        api: api({ getTask: async () => ({ status: { phase: "Running" } }) as KelosTaskObject }),
        maxPolls: 3,
      }),
    );

    const result = await client.runTask(request);

    expect(result.succeeded).toBe(false);
    expect(result.errorMessage).toMatch(/did not reach a terminal phase/i);
  });

  describe("shared volume transport", () => {
    test("mounts the shared worktree PVC and runs the agent in it", async () => {
      let created: { spec?: Record<string, unknown> } | undefined;
      const client = createKelosCrdClient(
        clientOptions({
          api: api({
            createTask: async (task) => {
              created = task as { spec?: Record<string, unknown> };
              return "kelos-task-1";
            },
          }),
          sharedWorktree: { claimName: "foreman-task-1-worktree", mountPath: "/workspace/repo" },
        }),
      );

      await client.runTask(request);

      // Volumes live under podOverrides, NOT spec.volumes: the CRD rejects
      // spec.volumes/spec.volumeMounts as unknown fields (verified by server
      // dry-run against tasks.kelos.dev v1alpha2).
      expect(created?.spec).toMatchObject({
        podOverrides: {
          volumes: [
            {
              name: "foreman-worktree",
              persistentVolumeClaim: { claimName: "foreman-task-1-worktree" },
            },
          ],
          volumeMounts: [{ name: "foreman-worktree", mountPath: "/workspace/repo" }],
        },
      });
    });

    test("reports volume transport so the runner does not look for a branch", async () => {
      const client = createKelosCrdClient(
        clientOptions({
          sharedWorktree: { claimName: "pvc", mountPath: "/workspace/repo" },
          api: api({
            getTask: async () =>
              ({
                status: { phase: "Succeeded", results: { "cost-usd": "0.10" } },
              }) as KelosTaskObject,
          }),
        }),
      );

      const result = await client.runTask(request);

      expect(result.transport).toBe("volume");
      expect(result.branch).toBeUndefined();
    });

    test("omits workspaceRef when a shared worktree is used", async () => {
      let created: { spec?: Record<string, unknown> } | undefined;
      const client = createKelosCrdClient(
        clientOptions({
          sharedWorktree: { claimName: "pvc", mountPath: "/workspace/repo" },
          api: api({
            createTask: async (task) => {
              created = task as { spec?: Record<string, unknown> };
              return "n";
            },
          }),
        }),
      );

      await client.runTask(request);

      // The repo arrives on the volume, so kelos must not clone it.
      expect(created?.spec).not.toHaveProperty("workspaceRef");
    });
  });

  describe("worker pool dispatch", () => {
    // A pooled Task must carry ONLY workerPoolRef + prompt (+ model/effort/
    // envOverrides). The CRD rejects type, credentials, workspaceRef, image,
    // agentConfigRefs, dependsOn, branch, and podOverrides alongside
    // workerPoolRef (verified by server dry-run against tasks.kelos.dev).
    test("dispatches to a pool without the fields the CRD forbids", async () => {
      let created: { spec?: Record<string, unknown> } | undefined;
      const client = createKelosCrdClient(
        clientOptions({
          api: api({
            createTask: async (task) => {
              created = task as { spec?: Record<string, unknown> };
              return "n";
            },
          }),
          workerPool: "foreman-pool",
          podOverrides: { env: [{ name: "IGNORED", value: "1" }] },
        }),
      );

      await client.runTask(request);

      expect(created?.spec).toMatchObject({
        workerPoolRef: { name: "foreman-pool" },
        model: "anthropic/claude-sonnet-4-6",
      });
      for (const forbidden of [
        "type",
        "credentials",
        "workspaceRef",
        "podOverrides",
        "volumes",
        "volumeMounts",
      ]) {
        expect(created?.spec).not.toHaveProperty(forbidden);
      }
    });

    // envOverrides is the per-Task env channel for pooled Tasks (our kelos fork,
    // upstream #1566): podOverrides is unavailable, so per-phase provider routing
    // has to travel this way.
    test("routes per-phase env through envOverrides on a pooled task", async () => {
      let created: { spec?: Record<string, unknown> } | undefined;
      const client = createKelosCrdClient(
        clientOptions({
          api: api({
            createTask: async (task) => {
              created = task as { spec?: Record<string, unknown> };
              return "n";
            },
          }),
          workerPool: "foreman-pool",
          envOverrides: [
            { name: "CLAUDE_CODE_USE_BEDROCK", value: "1" },
            { name: "AWS_REGION", value: "us-east-1" },
          ],
        }),
      );

      await client.runTask(request);

      expect(created?.spec).toMatchObject({
        envOverrides: [
          { name: "CLAUDE_CODE_USE_BEDROCK", value: "1" },
          { name: "AWS_REGION", value: "us-east-1" },
        ],
      });
    });

    // The pool's worker owns the persistent workspace, so the work is already on
    // disk when the agent finishes: nothing is pushed.
    test("reports volume transport for pooled tasks", async () => {
      const client = createKelosCrdClient(clientOptions({ workerPool: "foreman-pool" }));

      const result = await client.runTask(request);

      expect(result.transport).toBe("volume");
    });
  });

  // The CRD requires secretRef.name to be non-empty when present, and forbids a
  // secretRef entirely for credentials.type=none. Emitting an empty name is
  // rejected by the API server (verified live on EKS).
  test("omits secretRef when credentials need none", async () => {
    let created: { spec?: { credentials?: Record<string, unknown> } } | undefined;
    const client = createKelosCrdClient(
      clientOptions({
        credentials: { type: "none" },
        api: api({
          createTask: async (task) => {
            created = task as { spec?: { credentials?: Record<string, unknown> } };
            return "n";
          },
        }),
      }),
    );

    await client.runTask(request);

    expect(created?.spec?.credentials).toEqual({ type: "none" });
  });

  describe("patch transport", () => {
    // The agent uploads its diff with a presigned URL, so the pod needs no AWS
    // credentials or SDK. postCommands runs the upload in the runtime after the
    // agent exits rather than asking the model to do it.
    test("passes the upload URL as env and the upload command as postCommands", async () => {
      let created: { spec?: Record<string, unknown> } | undefined;
      const client = createKelosCrdClient(
        clientOptions({
          workerPool: "pool",
          patchUpload: { url: "https://s3.example/put?sig=abc", envVar: "FOREMAN_PATCH_URL" },
          api: api({
            createTask: async (task) => {
              created = task as { spec?: Record<string, unknown> };
              return "n";
            },
          }),
        }),
      );

      await client.runTask(request);

      const spec = created?.spec as {
        envOverrides?: { name: string; value: string }[];
        postCommands?: string[][];
      };
      expect(spec.envOverrides).toEqual(
        expect.arrayContaining([
          { name: "FOREMAN_PATCH_URL", value: "https://s3.example/put?sig=abc" },
        ]),
      );
      expect(spec.postCommands?.length).toBe(1);
      const cmd = (spec.postCommands as string[][])[0].join(" ");
      expect(cmd).toContain("git");
      expect(cmd).toContain("$FOREMAN_PATCH_URL");
    });

    // A pooled worker's workspace carries changes from every task it has already
    // served, so diffing against HEAD would attribute those to this phase. The
    // baseline is captured by a preCommand before the agent runs, and the upload
    // diffs against it.
    test("captures a baseline before the agent and diffs against it", async () => {
      let created: { spec?: { preCommands?: string[][]; postCommands?: string[][] } } | undefined;
      const client = createKelosCrdClient(
        clientOptions({
          workerPool: "pool",
          patchUpload: { url: "https://s3.example/put", envVar: "FOREMAN_PATCH_URL" },
          api: api({
            createTask: async (task) => {
              created = task as { spec?: { preCommands?: string[][]; postCommands?: string[][] } };
              return "n";
            },
          }),
        }),
      );

      await client.runTask(request);

      const pre = (created?.spec?.preCommands as string[][])[0].join(" ");
      const post = (created?.spec?.postCommands as string[][])[0].join(" ");
      expect(pre).toContain("stash create");
      // Falls back to HEAD: stash create prints nothing on a clean worktree.
      expect(pre).toContain("rev-parse HEAD");
      expect(post).toContain("FOREMAN_BASELINE");
    });

    test("reports patch transport with the key so the runner fetches it", async () => {
      const client = createKelosCrdClient(
        clientOptions({
          patchUpload: {
            url: "https://s3.example/put",
            envVar: "FOREMAN_PATCH_URL",
            key: "foreman/run-1/developer.patch",
          },
        }),
      );

      const result = await client.runTask(request);

      expect(result.transport).toBe("patch");
      expect(result.patchKey).toBe("foreman/run-1/developer.patch");
    });
  });
});
