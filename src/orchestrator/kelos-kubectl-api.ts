import { execFile } from "node:child_process";
import type { KelosApi, KelosTaskObject } from "./kelos-client.js";

/** Runs kubectl with an argv array, optionally piping stdin, and returns stdout. */
export type KubectlRunner = (args: string[], stdin?: string) => Promise<string>;

export interface KubectlKelosApiOptions {
  runner?: KubectlRunner;
  namespace: string;
  context?: string;
  kubectlPath?: string;
}

const TASK_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

function assertTaskName(name: string): void {
  if (!TASK_NAME.test(name)) {
    throw new Error(`invalid kelos task name: ${name}`);
  }
}

function execRunner(kubectlPath: string): KubectlRunner {
  return (args, stdin) =>
    new Promise((resolve, reject) => {
      const child = execFile(kubectlPath, args, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`kubectl ${args.join(" ")} failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      });
      if (stdin !== undefined) {
        child.stdin?.end(stdin);
      }
    });
}

export function createKubectlKelosApi(options: KubectlKelosApiOptions): KelosApi {
  const runner = options.runner ?? execRunner(options.kubectlPath ?? "kubectl");
  const prefix = [
    ...(options.context ? ["--context", options.context] : []),
    "--namespace",
    options.namespace,
  ];

  return {
    async createTask(task: unknown): Promise<string> {
      const stdout = await runner(
        [...prefix, "apply", "-o", "json", "-f", "-"],
        JSON.stringify(task),
      );
      const applied = JSON.parse(stdout) as KelosTaskObject;
      const name = applied.metadata?.name;
      if (!name) {
        throw new Error("kubectl apply returned a Task without metadata.name");
      }
      return name;
    },

    async getTask(name: string): Promise<KelosTaskObject> {
      assertTaskName(name);
      const stdout = await runner([...prefix, "get", "task.kelos.dev", name, "-o", "json"]);
      return JSON.parse(stdout) as KelosTaskObject;
    },
  };
}
