import { describe, expect, test } from "vitest";
import { createKubectlKelosApi, type KubectlRunner } from "../kelos-kubectl-api.js";

function recordingRunner(stdout = "{}"): {
  runner: KubectlRunner;
  calls: { args: string[]; stdin?: string }[];
} {
  const calls: { args: string[]; stdin?: string }[] = [];
  return {
    calls,
    runner: async (args, stdin) => {
      calls.push({ args, stdin });
      return stdout;
    },
  };
}

describe("kubectl kelos api", () => {
  test("creates a Task by piping its JSON to kubectl apply", async () => {
    const { runner, calls } = recordingRunner(
      JSON.stringify({ metadata: { name: "foreman-task-1-developer" } }),
    );
    const api = createKubectlKelosApi({ runner, namespace: "kelos", context: "k3d-spike" });

    const name = await api.createTask({
      apiVersion: "kelos.dev/v1alpha2",
      kind: "Task",
      metadata: { name: "foreman-task-1-developer" },
    });

    expect(name).toBe("foreman-task-1-developer");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      "--context",
      "k3d-spike",
      "--namespace",
      "kelos",
      "apply",
      "-o",
      "json",
      "-f",
      "-",
    ]);
    expect(JSON.parse(calls[0].stdin as string)).toMatchObject({ kind: "Task" });
  });

  test("reads Task status via kubectl get -o json", async () => {
    const { runner, calls } = recordingRunner(
      JSON.stringify({ status: { phase: "Succeeded", results: { branch: "kelos/x" } } }),
    );
    const api = createKubectlKelosApi({ runner, namespace: "kelos", context: "k3d-spike" });

    const task = await api.getTask("foreman-task-1-developer");

    expect(task.status?.phase).toBe("Succeeded");
    expect(task.status?.results?.branch).toBe("kelos/x");
    expect(calls[0].args).toEqual([
      "--context",
      "k3d-spike",
      "--namespace",
      "kelos",
      "get",
      "task.kelos.dev",
      "foreman-task-1-developer",
      "-o",
      "json",
    ]);
  });

  test("omits the context flag when no context is configured", async () => {
    const { runner, calls } = recordingRunner(JSON.stringify({ status: { phase: "Running" } }));
    const api = createKubectlKelosApi({ runner, namespace: "default" });

    await api.getTask("t");

    expect(calls[0].args).not.toContain("--context");
    expect(calls[0].args.slice(0, 2)).toEqual(["--namespace", "default"]);
  });

  test("rejects a task name that could inject extra kubectl arguments", async () => {
    const { runner } = recordingRunner();
    const api = createKubectlKelosApi({ runner, namespace: "kelos" });

    await expect(api.getTask("--all-namespaces")).rejects.toThrow(/invalid kelos task name/i);
  });
});
