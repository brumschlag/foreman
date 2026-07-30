/**
 * Per-project kelos workspace resolution.
 *
 * KELOS_WORKSPACE is one deployment-wide env var, so foreman could only ever
 * target one repo: pointing it at a second project meant patching the Deployment
 * and restarting, which repointed every other project's runs too.
 *
 * kelos itself was never the constraint — `tasks.kelos.dev` accepts
 * `spec.workspaceRef` per Task, and the `self == oldSelf` CEL rule freezes the
 * spec only AFTER creation. So a project may name its own workspace and the env
 * var stays the default for everything that doesn't.
 */

import { describe, expect, test } from "vitest";
import { projectWorkspaceFromConfig, resolveKelosWorkspace } from "../kelos-workspace.js";

describe("projectWorkspaceFromConfig", () => {
  test("reads the declared workspace", () => {
    expect(projectWorkspaceFromConfig({ name: "inpulse", kelosWorkspace: "inpulse" })).toBe(
      "inpulse",
    );
  });

  test("returns undefined for a project that declares none", () => {
    // The live inpulse project was registered with exactly this config.
    expect(projectWorkspaceFromConfig({ name: "inpulse" })).toBeUndefined();
    expect(projectWorkspaceFromConfig({})).toBeUndefined();
    expect(projectWorkspaceFromConfig(undefined)).toBeUndefined();
  });

  test("ignores a non-string value instead of coercing it", () => {
    // config is untyped off the wire. String(42) would name a workspace that
    // cannot exist and fail deep inside kelos instead of here.
    expect(projectWorkspaceFromConfig({ kelosWorkspace: 42 })).toBeUndefined();
    expect(projectWorkspaceFromConfig({ kelosWorkspace: null })).toBeUndefined();
    expect(projectWorkspaceFromConfig({ kelosWorkspace: { name: "x" } })).toBeUndefined();
  });
});

describe("resolveKelosWorkspace", () => {
  test("prefers the project's declared workspace over the env default", () => {
    const workspace = resolveKelosWorkspace({
      projectWorkspace: "inpulse",
      envWorkspace: "packer-pipeline-test",
    });

    expect(workspace).toBe("inpulse");
  });

  test("falls back to the env default when the project declares none", () => {
    // The whole point of the fallback: an existing deployment that only sets
    // KELOS_WORKSPACE must behave exactly as it did before.
    const workspace = resolveKelosWorkspace({
      projectWorkspace: undefined,
      envWorkspace: "packer-pipeline-test",
    });

    expect(workspace).toBe("packer-pipeline-test");
  });

  test("treats a blank project value as undeclared rather than as an override", () => {
    // A YAML/JSON round-trip readily yields "" or "  ". Honouring that as an
    // override would send an empty workspaceRef.name, which the API server
    // rejects — a confusing failure far from its cause.
    for (const blank of ["", "   ", "\t"]) {
      expect(
        resolveKelosWorkspace({ projectWorkspace: blank, envWorkspace: "fallback" }),
      ).toBe("fallback");
    }
  });

  test("trims a declared workspace so a stray newline cannot break the ref", () => {
    expect(
      resolveKelosWorkspace({ projectWorkspace: " inpulse\n", envWorkspace: "fallback" }),
    ).toBe("inpulse");
  });

  test("throws rather than dispatching against the wrong repo when the lookup failed", () => {
    // The dangerous case. If the project's config could not be READ, silently
    // using the env default runs an agent against a DIFFERENT repository than
    // the task was filed for — a wrong-repo write is far worse than a failed
    // phase, so this fails closed instead.
    expect(() =>
      resolveKelosWorkspace({
        projectWorkspace: undefined,
        envWorkspace: "packer-pipeline-test",
        lookupFailed: true,
      }),
    ).toThrow(/could not be resolved/i);
  });

  test("does not fail closed when the lookup succeeded and found nothing", () => {
    // Distinct from the case above: "this project declares no workspace" is a
    // legitimate answer, not a failure, and must still fall back.
    expect(
      resolveKelosWorkspace({
        projectWorkspace: undefined,
        envWorkspace: "packer-pipeline-test",
        lookupFailed: false,
      }),
    ).toBe("packer-pipeline-test");
  });

  test("throws when neither source yields a workspace", () => {
    // Previously this surfaced as workspaceRef: {name: ""} rejected by the API
    // server. Naming both sources is a far better error.
    expect(() =>
      resolveKelosWorkspace({ projectWorkspace: undefined, envWorkspace: "" }),
    ).toThrow(/KELOS_WORKSPACE/);
  });
});
