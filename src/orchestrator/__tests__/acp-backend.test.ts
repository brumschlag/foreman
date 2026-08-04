import { describe, expect, test } from "vitest";
import { acpBackendConfigFromEnv, createAcpBackend, resolveAcpModel } from "../acp-backend.js";

/**
 * Workflow YAML names models with Foreman's own shorthands, resolved to Pi-style
 * ids like "anthropic/claude-haiku-4-5". A provider reached through the ACP adapter
 * may name the same model differently — Bedrock rejects that id outright and wants
 * "us.anthropic.claude-haiku-4-5-20251001-v1:0" — so the backend needs a mapping
 * layer. Mirrors kelos's KELOS_MODEL_MAP / gatewayModel.
 */

describe("resolveAcpModel", () => {
  test("passes a model through untouched when no map is configured", () => {
    expect(resolveAcpModel("anthropic/claude-haiku-4-5", new Map())).toBe(
      "anthropic/claude-haiku-4-5",
    );
  });

  test("translates a mapped model to its provider id", () => {
    const map = new Map([
      ["anthropic/claude-haiku-4-5", "us.anthropic.claude-haiku-4-5-20251001-v1:0"],
    ]);

    expect(resolveAcpModel("anthropic/claude-haiku-4-5", map)).toBe(
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
  });

  // Substituting a different model would silently change the cost and quality the
  // workflow asked for — a P0 phase configured for opus quietly running on haiku is
  // worse than a phase that refuses to start.
  test("refuses an unmapped model once a map is configured", () => {
    const map = new Map([["anthropic/claude-opus-4-6", "us.anthropic.claude-opus-4-6"]]);

    expect(() => resolveAcpModel("anthropic/claude-haiku-4-5", map)).toThrow(
      /anthropic\/claude-haiku-4-5.*FOREMAN_ACP_MODEL_MAP/s,
    );
  });

  // The Bedrock rejection this exists to prevent is a 400 mid-phase, after the
  // agent has spawned and the run has been charged for the attempt.
  test("names the failing model so the error is actionable", () => {
    expect(() => resolveAcpModel("sonnet-typo", new Map([["a", "b"]]))).toThrow(/sonnet-typo/);
  });
});

describe("acpBackendConfigFromEnv model map", () => {
  test("has no map by default, so models pass through", () => {
    const config = acpBackendConfigFromEnv({});

    expect(config.modelMap.size).toBe(0);
  });

  test("parses comma-separated from=to pairs", () => {
    const config = acpBackendConfigFromEnv({
      FOREMAN_ACP_MODEL_MAP:
        "anthropic/claude-haiku-4-5=us.anthropic.claude-haiku-4-5-20251001-v1:0,anthropic/claude-sonnet-4-6=us.anthropic.claude-sonnet-4-6",
    });

    expect(config.modelMap.get("anthropic/claude-haiku-4-5")).toBe(
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
    expect(config.modelMap.get("anthropic/claude-sonnet-4-6")).toBe(
      "us.anthropic.claude-sonnet-4-6",
    );
  });

  // Bedrock ids contain a colon (":0"), and provider ids contain slashes and dots,
  // so only the FIRST "=" may separate the pair.
  test("keeps a target id that itself contains separators", () => {
    const config = acpBackendConfigFromEnv({
      FOREMAN_ACP_MODEL_MAP: "haiku=us.anthropic.claude-haiku-4-5-20251001-v1:0",
    });

    expect(config.modelMap.get("haiku")).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
  });

  test("ignores blank entries and surrounding whitespace", () => {
    const config = acpBackendConfigFromEnv({
      FOREMAN_ACP_MODEL_MAP: " haiku=bedrock-haiku , , sonnet=bedrock-sonnet ,",
    });

    expect(config.modelMap.get("haiku")).toBe("bedrock-haiku");
    expect(config.modelMap.get("sonnet")).toBe("bedrock-sonnet");
    expect(config.modelMap.size).toBe(2);
  });

  // A half-written entry means the operator intended a mapping that will not apply,
  // and the resulting failure would surface as a provider 400 mid-phase instead.
  test("rejects an entry with no target", () => {
    expect(() => acpBackendConfigFromEnv({ FOREMAN_ACP_MODEL_MAP: "haiku=" })).toThrow(
      /FOREMAN_ACP_MODEL_MAP/,
    );
  });

  test("rejects an entry with no separator", () => {
    expect(() => acpBackendConfigFromEnv({ FOREMAN_ACP_MODEL_MAP: "haiku" })).toThrow(
      /FOREMAN_ACP_MODEL_MAP/,
    );
  });
});

describe("createAcpBackend model translation", () => {
  const options = () => ({
    prompt: "p",
    systemPrompt: "s",
    cwd: "/tmp",
    model: "anthropic/claude-haiku-4-5",
    context: {
      phaseName: "explorer",
      taskId: "t1",
      taskTitle: "T",
      worktreePath: "/tmp",
    },
  });

  test("sends the provider id to the agent, not the workflow id", async () => {
    const seen: string[] = [];
    const backend = createAcpBackend({
      command: "unused",
      args: [],
      modelMap: new Map([["anthropic/claude-haiku-4-5", "us.anthropic.claude-haiku-4-5-20251001-v1:0"]]),
      createClient: () => ({
        prompt: async (request) => {
          seen.push(request.model);
          return {
            stopReason: "end_turn" as const,
            costUsd: 0,
            tokensIn: 1,
            tokensOut: 1,
            turns: 1,
            toolCalls: 0,
            toolBreakdown: {},
          };
        },
      }),
    });

    await backend(options() as never);

    expect(seen).toEqual(["us.anthropic.claude-haiku-4-5-20251001-v1:0"]);
  });

  // A translation failure must fail the PHASE, not throw out of the runner: the
  // pipeline handles agent-error, whereas an exception escaping the backend takes
  // down the worker and loses the run's bookkeeping.
  test("fails the phase as agent-error when the model is unmapped", async () => {
    const backend = createAcpBackend({
      command: "unused",
      args: [],
      modelMap: new Map([["anthropic/claude-opus-4-6", "us.anthropic.claude-opus-4-6"]]),
      createClient: () => {
        throw new Error("client must not be built for an unmapped model");
      },
    });

    const result = await backend(options() as never);

    expect(result.success).toBe(false);
    expect(result.errorMessage).toMatch(/^agent-error:/);
    expect(result.errorMessage).toMatch(/FOREMAN_ACP_MODEL_MAP/);
  });
});
