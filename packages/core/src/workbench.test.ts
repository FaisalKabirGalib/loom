import { describe, expect, it } from "vitest";
import type {
  CapabilityCandidate,
  Policy,
  ProjectProfile,
  ScoredCapability,
  TaskProfile,
} from "./domain.js";
import {
  createCapabilityLock,
  parseCapabilityLock,
  serializeCapabilityLock,
} from "./lock.js";
import { evaluatePolicy, parsePolicyToml } from "./policy.js";
import { resolveCapabilities } from "./resolver.js";
import { SCORE_WEIGHTS, scoreCapability } from "./scoring.js";
import { classifyTask } from "./task.js";

const project: ProjectProfile = {
  root: "/project",
  lifecycle: "brownfield",
  languages: ["typescript"],
  frameworks: ["react"],
  packageManagers: ["pnpm"],
  dependencies: {},
  devDependencies: {},
  web: true,
  ui: true,
  mobile: false,
  api: false,
  database: false,
  monorepo: false,
  services: [],
  existingAgentConfigs: [],
  detectionSignals: [],
};

const policy: Policy = {
  mcp: { allowRemote: false, allowShell: false },
  database: { maxAccess: "read" },
  skills: { requireReviewForScripts: true },
  capabilities: { minScore: 0, minTrustTier: "community" },
};

function candidate(
  id: string,
  provides: string[],
  overrides: Partial<CapabilityCandidate> = {},
): CapabilityCandidate {
  return {
    id,
    name: id,
    kind: "mcp",
    source: {
      registry: "test",
      repository: `https://example.test/${id}`,
      package: id,
    },
    version: "1.2.3",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ecosystems: ["typescript"],
    provides,
    tags: [],
    transport: "stdio",
    runtime: { kind: "node", command: "node server.js" },
    permissions: {
      filesystem: "read",
      shell: false,
      network: false,
      secrets: [],
      database: "none",
      device: false,
    },
    provenance: {
      official: true,
      namespaceVerified: true,
      knownMaintainer: true,
      repositoryVerified: true,
      packageRepositoryMatch: true,
    },
    metrics: { toolCount: 5 },
    overlapGroups: ["code"],
    recommendedScope: "project",
    trustTier: "official",
    taskTriggers: [],
    contextCost: 10,
    portability: 100,
    notes: [],
    ...overrides,
  };
}

function scored(
  value: CapabilityCandidate,
  coverage = value.provides,
  score = 80,
): ScoredCapability {
  return {
    candidate: value,
    score,
    reasons: [`covers ${coverage.join(", ")}`],
    penalties: [],
    coverage,
    breakdown: {
      taskFit: 20,
      projectFit: 15,
      coverage: 10,
      maintenance: 10,
      provenance: 10,
      security: 8,
      contextEfficiency: 4,
      portability: 5,
      penalties: -2,
    },
  };
}

describe("task classification", () => {
  it("classifies intent, risk, and deterministic capabilities", () => {
    const result = classifyTask(
      "Deploy a React database migration to production",
      project,
      { requiredCapabilities: ["OPS.deployment"] },
    );
    expect(result.risk).toBe("high");
    expect(result.intents).toEqual(["database", "deploy", "ui"]);
    expect(result.requiredCapabilities).toEqual(["OPS.deployment"]);
    expect(result.usefulCapabilities).toContain("DATA.schema-inspection");
  });
});

describe("policy", () => {
  it("parses snake-case TOML and applies explicit approval and block rules", () => {
    const parsed = parsePolicyToml(
      "[mcp]\nallow_remote = true\nallow_shell = false\n[database]\nmax_access = 'read'\n[capabilities]\nmin_score = 60\nmin_trust_tier = 'community'\n",
    );
    expect(parsed.capabilities.minScore).toBe(60);
    const secretCandidate = candidate("secret", ["deployment"], {
      permissions: {
        filesystem: "read",
        shell: false,
        network: true,
        secrets: ["CLOUD_TOKEN"],
        database: "none",
        device: false,
      },
    });
    expect(evaluatePolicy(secretCandidate, parsed).decision).toBe(
      "approval-required",
    );
    const mismatch = candidate("bad", ["deployment"], {
      provenance: {
        official: false,
        namespaceVerified: true,
        knownMaintainer: false,
        repositoryVerified: true,
        packageRepositoryMatch: false,
      },
    });
    expect(evaluatePolicy(mismatch, parsed)).toMatchObject({
      decision: "blocked",
      reasons: ["package and repository provenance mismatch"],
    });
  });
});

describe("explainable scoring", () => {
  it("uses documented 100-point weights and explicit permission/context penalties", () => {
    expect(
      Object.values(SCORE_WEIGHTS).reduce((sum, value) => sum + value, 0),
    ).toBe(100);
    const task: TaskProfile = {
      intents: ["refactor"],
      requiredCapabilities: ["semantic-search"],
      usefulCapabilities: [],
      risk: "low",
    };
    const result = scoreCapability(
      candidate("writer", ["semantic-search"], {
        permissions: {
          filesystem: "write",
          shell: true,
          network: true,
          secrets: ["TOKEN"],
          database: "write",
          device: false,
        },
        contextCost: 90,
        metrics: { toolCount: 60 },
      }),
      project,
      task,
      { now: new Date("2026-08-23T00:00:00.000Z") },
    );
    expect(result.penalties).toEqual(
      expect.arrayContaining([
        "-6 filesystem write capability",
        "-8 shell execution capability",
        "-8 secrets unrelated to task",
        "-10 database write access",
        "-8 huge always-loaded tool surface",
      ]),
    );
    expect(result.breakdown.contextEfficiency).toBe(0.5);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});

describe("minimum-set resolver", () => {
  it("selects one covering tool and explains deterministic overlap rejection", () => {
    const task: TaskProfile = {
      intents: ["refactor"],
      requiredCapabilities: [
        "call-graph",
        "semantic-search",
        "symbol-navigation",
      ],
      usefulCapabilities: [],
      risk: "low",
    };
    const all = scored(
      candidate("codanna", task.requiredCapabilities),
      task.requiredCapabilities,
      75,
    );
    const search = scored(
      candidate("serena", ["semantic-search", "symbol-navigation"], {
        permissions: {
          filesystem: "write",
          shell: false,
          network: false,
          secrets: [],
          database: "none",
          device: false,
        },
      }),
      ["semantic-search", "symbol-navigation"],
      95,
    );
    const graph = scored(
      candidate("graph", ["call-graph"]),
      ["call-graph"],
      95,
    );
    const plan = resolveCapabilities(
      project,
      task,
      [search, graph, all],
      policy,
    );
    expect(plan.selected.map((item) => item.candidate.id)).toEqual(["codanna"]);
    expect(plan.uncovered).toEqual([]);
    expect(
      plan.rejected.find((item) => item.capability.candidate.id === "serena")
        ?.reason,
    ).toContain("codanna already covers semantic-search, symbol-navigation");
    expect(plan.rejected.map((item) => item.capability.candidate.id)).toEqual([
      "graph",
      "serena",
    ]);
    const greedy = resolveCapabilities(
      project,
      task,
      [graph, search, all],
      policy,
      {
        exactCandidateLimit: 0,
      },
    );
    expect(greedy.selected.map((item) => item.candidate.id)).toEqual([
      "codanna",
    ]);
  });
});

describe("capability lock", () => {
  it("sorts entries, rejects latest, and redacts serialized command secrets", () => {
    const first = scored(
      candidate("zeta", ["a"], {
        runtime: { kind: "node", command: "node x --token=abc" },
      }),
    );
    const second = scored(candidate("alpha", ["b"]));
    const plan = resolveCapabilities(
      project,
      {
        intents: [],
        requiredCapabilities: ["a", "b"],
        usefulCapabilities: [],
        risk: "low",
      },
      [first, second],
      policy,
    );
    const lock = createCapabilityLock(plan, {
      generatedAt: new Date("2026-08-23T00:00:00.000Z"),
    });
    expect(lock.entries.map((entry) => entry.id)).toEqual(["alpha", "zeta"]);
    const serialized = serializeCapabilityLock(lock);
    expect(serialized).not.toContain("abc");
    expect(
      parseCapabilityLock(serialized).entries[1]?.runtime?.command,
    ).toContain("[REDACTED]");
    expect(() =>
      createCapabilityLock({
        ...plan,
        selected: [scored(candidate("latest", ["a"], { version: "latest" }))],
      }),
    ).toThrow("lock version must be exact");
    expect(() =>
      createCapabilityLock({
        ...plan,
        selected: [scored(candidate("range", ["a"], { version: "^1.2.3" }))],
      }),
    ).toThrow("lock version must be exact");
  });
});
