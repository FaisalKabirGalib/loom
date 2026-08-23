import { describe, expect, it } from "vitest";
import type { ProjectProfile } from "@loom/core";

import { composeProfiles } from "./index.js";

const project = (overrides: Partial<ProjectProfile>): ProjectProfile => ({
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
});

describe("composeProfiles", () => {
  it("composes deterministic TypeScript and Next.js capabilities", () => {
    const result = composeProfiles(
      project({ languages: ["typescript"], frameworks: ["next.js", "react"] }),
    );

    expect(result.profiles).toEqual(["typescript", "nextjs-react"]);
    expect(result.requiredCapabilities).toEqual([]);
    expect(result.usefulCapabilities).toEqual([
      "CODE_CONTEXT.structural-search",
      "DOCS.framework-docs",
      "DOCS.package-docs",
      "UI.accessibility",
      "UI.browser-test",
      "UI.react-runtime",
    ]);
  });

  it("composes overlapping mobile profiles without duplicate capabilities", () => {
    const result = composeProfiles(
      project({
        languages: ["dart"],
        frameworks: ["dart", "flutter", "react-native", "expo"],
      }),
    );

    expect(result.profiles).toEqual(["flutter-dart", "react-native", "expo"]);
    expect(result.requiredCapabilities).toEqual(["MOBILE.framework-analysis"]);
    expect(
      result.usefulCapabilities.filter(
        (item) => item === "MOBILE.e2e-device-test",
      ),
    ).toHaveLength(1);
  });
});
