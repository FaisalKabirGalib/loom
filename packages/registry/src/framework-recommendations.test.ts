import type { ProjectProfile } from "@loom/core";
import { describe, expect, it } from "vitest";

import { frameworkRecommendations } from "./framework-recommendations.js";

function project(overrides: Partial<ProjectProfile>): ProjectProfile {
  return {
    root: "/project",
    lifecycle: "brownfield",
    languages: [],
    frameworks: [],
    packageManagers: [],
    dependencies: {},
    devDependencies: {},
    web: false,
    ui: false,
    mobile: false,
    api: false,
    database: false,
    monorepo: false,
    services: [],
    existingAgentConfigs: [],
    detectionSignals: [],
    ...overrides,
  };
}

describe("frameworkRecommendations", () => {
  it("returns deterministic Flutter defaults, audited OpenCode tools, and manual skill discovery", () => {
    const recommendations = frameworkRecommendations(
      project({ languages: ["dart"], frameworks: ["dart", "flutter"] }),
    );

    expect(recommendations.defaults.map((item) => item.id)).toEqual([
      "loom-dependency-research",
      "loom-project-setup",
      "loom-verification-loop",
    ]);
    expect(recommendations.installable.map((item) => item.id)).toEqual([
      "builtin:flutter-package-intelligence",
      "dart-mcp-server",
      "dart-pubdev-explorer",
    ]);
    expect(
      recommendations.installable.every((item) =>
        item.rationale.includes("OpenCode only"),
      ),
    ).toBe(true);
    expect(recommendations.suggested).toMatchObject([
      { id: "flutter-package-skills", status: "suggested" },
    ]);
  });

  it("combines Next and React web recommendations without duplicates", () => {
    const recommendations = frameworkRecommendations(
      project({
        languages: ["typescript"],
        frameworks: ["next.js", "react", "storybook", "shadcn"],
        web: true,
      }),
    );

    expect(recommendations.defaults.map((item) => item.id)).toEqual([
      "loom-dependency-research",
      "loom-design-director",
      "loom-project-setup",
      "loom-verification-loop",
    ]);
    expect(recommendations.suggested.map((item) => item.id)).toEqual([
      "builtin:chrome-devtools-mcp",
      "builtin:context7",
      "builtin:shadcn-mcp",
      "builtin:storybook-mcp",
    ]);
  });

  it("recommends web intelligence for generic TypeScript", () => {
    const recommendations = frameworkRecommendations(
      project({ languages: ["typescript"] }),
    );

    expect(recommendations.defaults.map((item) => item.id)).toEqual([
      "loom-dependency-research",
      "loom-design-director",
      "loom-project-setup",
      "loom-verification-loop",
    ]);
    expect(recommendations.installable).toMatchObject([
      { id: "builtin:web-agent-intelligence", status: "installable" },
    ]);
    expect(recommendations.installable[0]?.manualCommand).toBe(
      "AGENT_BROWSER_EXECUTABLE_PATH must point to a project-local verified executable; Loom will not download browser.",
    );
    expect(recommendations.suggested).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "builtin:context7",
          status: "suggested",
        }),
      ]),
    );
  });
});
