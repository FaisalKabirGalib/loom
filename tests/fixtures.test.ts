import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { detectProject } from "../packages/core/src/detection.js";
import { composeProfiles } from "../packages/profiles/src/index.js";

interface FixtureExpectation {
  name: string;
  lifecycle: "greenfield" | "brownfield";
  frameworks: string[];
  services: string[];
  agentConfigs: string[];
  packageManagers: string[];
  versions: Record<string, string>;
  profiles: string[];
  monorepo?: boolean;
  signalEvidence?: string[];
}

const fixturesRoot = fileURLToPath(new URL("../fixtures", import.meta.url));

const cases: FixtureExpectation[] = [
  {
    name: "empty",
    lifecycle: "greenfield",
    frameworks: [],
    services: [],
    agentConfigs: [],
    packageManagers: [],
    versions: {},
    profiles: [],
  },
  {
    name: "typescript",
    lifecycle: "brownfield",
    frameworks: [],
    services: [],
    agentConfigs: [],
    packageManagers: ["npm"],
    versions: { typescript: "5.7.3" },
    profiles: ["typescript"],
    signalEvidence: ["packageManager npm@10.8.2"],
  },
  {
    name: "nextjs",
    lifecycle: "brownfield",
    frameworks: ["next.js", "react"],
    services: [],
    agentConfigs: [],
    packageManagers: ["pnpm"],
    versions: { next: "15.1.6", react: "19.0.0", typescript: "5.7.3" },
    profiles: ["typescript", "nextjs-react"],
    signalEvidence: ["packageManager pnpm@9.15.4", "next 15.1.6"],
  },
  {
    name: "nextjs-storybook",
    lifecycle: "brownfield",
    frameworks: ["next.js", "react", "storybook"],
    services: [],
    agentConfigs: [],
    packageManagers: ["pnpm"],
    versions: {
      "@storybook/nextjs": "8.5.3",
      next: "15.1.6",
      typescript: "5.7.3",
    },
    profiles: ["typescript", "nextjs-react"],
    signalEvidence: ["@storybook/nextjs 8.5.3"],
  },
  {
    name: "nextjs-shadcn",
    lifecycle: "brownfield",
    frameworks: ["next.js", "react", "shadcn"],
    services: [],
    agentConfigs: [],
    packageManagers: ["pnpm"],
    versions: { next: "15.1.6", typescript: "5.7.3" },
    profiles: ["typescript", "nextjs-react"],
  },
  {
    name: "nextjs-postgres",
    lifecycle: "brownfield",
    frameworks: ["next.js", "react"],
    services: ["postgresql"],
    agentConfigs: [],
    packageManagers: ["pnpm"],
    versions: { "@prisma/client": "6.3.1", pg: "8.13.1" },
    profiles: ["typescript", "nextjs-react"],
    signalEvidence: ["pg 8.13.1"],
  },
  {
    name: "flutter",
    lifecycle: "brownfield",
    frameworks: ["dart", "flutter"],
    services: [],
    agentConfigs: [],
    packageManagers: ["pub"],
    versions: { flutter: "manifest", flutter_lints: "^5.0.0" },
    profiles: ["flutter-dart"],
  },
  {
    name: "flutter-widgetbook",
    lifecycle: "brownfield",
    frameworks: ["dart", "flutter", "widgetbook"],
    services: [],
    agentConfigs: [],
    packageManagers: ["pub"],
    versions: { widgetbook: "^3.10.0" },
    profiles: ["flutter-dart"],
    signalEvidence: ["widgetbook ^3.10.0"],
  },
  {
    name: "flutter-patrol",
    lifecycle: "brownfield",
    frameworks: ["dart", "flutter", "patrol"],
    services: [],
    agentConfigs: [],
    packageManagers: ["pub"],
    versions: { patrol: "^3.13.0" },
    profiles: ["flutter-dart"],
    signalEvidence: ["patrol ^3.13.0"],
  },
  {
    name: "react-native",
    lifecycle: "brownfield",
    frameworks: ["react", "react-native"],
    services: [],
    agentConfigs: [],
    packageManagers: ["yarn"],
    versions: { "react-native": "0.76.6", typescript: "5.7.3" },
    profiles: ["typescript", "react-native"],
    signalEvidence: ["packageManager yarn@4.6.0", "react-native 0.76.6"],
  },
  {
    name: "expo",
    lifecycle: "brownfield",
    frameworks: ["expo", "react", "react-native"],
    services: [],
    agentConfigs: [],
    packageManagers: ["npm"],
    versions: { expo: "52.0.28", "react-native": "0.76.6" },
    profiles: ["typescript", "react-native", "expo"],
    signalEvidence: ["expo 52.0.28"],
  },
  {
    name: "go",
    lifecycle: "brownfield",
    frameworks: ["go"],
    services: [],
    agentConfigs: [],
    packageManagers: ["go"],
    versions: {},
    profiles: ["go"],
  },
  {
    name: "laravel",
    lifecycle: "brownfield",
    frameworks: ["laravel"],
    services: [],
    agentConfigs: [],
    packageManagers: ["composer"],
    versions: { "laravel/framework": "^12.0" },
    profiles: ["laravel-php"],
    signalEvidence: ["laravel/framework ^12.0"],
  },
  {
    name: "laravel-inertia-react",
    lifecycle: "brownfield",
    frameworks: ["laravel", "react"],
    services: [],
    agentConfigs: [],
    packageManagers: ["composer", "npm"],
    versions: {
      "@inertiajs/react": "2.0.3",
      "inertiajs/inertia-laravel": "^2.0",
      "laravel/framework": "^12.0",
      typescript: "5.7.3",
    },
    profiles: ["typescript", "nextjs-react", "laravel-php"],
    signalEvidence: ["react 19.0.0", "laravel/framework ^12.0"],
  },
  {
    name: "laravel-nightwatch",
    lifecycle: "brownfield",
    frameworks: ["laravel"],
    services: [],
    agentConfigs: [],
    packageManagers: ["composer"],
    versions: {
      "laravel/framework": "^12.0",
      "laravel/nightwatch": "^1.8",
    },
    profiles: ["laravel-php"],
  },
  {
    name: "monorepo",
    lifecycle: "brownfield",
    frameworks: [],
    services: [],
    agentConfigs: [],
    packageManagers: ["pnpm"],
    versions: { typescript: "5.7.3" },
    profiles: ["typescript"],
    monorepo: true,
    signalEvidence: ["packageManager pnpm@9.15.4"],
  },
  {
    name: "existing-agent-configs",
    lifecycle: "greenfield",
    frameworks: [],
    services: [],
    agentConfigs: [
      ".claude",
      ".cursor",
      ".github/copilot-instructions.md",
      ".mcp.json",
      ".opencode",
      "AGENTS.md",
      "CLAUDE.md",
      "opencode.json",
    ],
    packageManagers: [],
    versions: {},
    profiles: [],
  },
];

describe("project fixtures", () => {
  it.each(cases)("detects and composes $name", (fixture) => {
    const project = detectProject(`${fixturesRoot}/${fixture.name}`);
    const composed = composeProfiles(project);
    const versions = { ...project.devDependencies, ...project.dependencies };

    expect(project.lifecycle).toBe(fixture.lifecycle);
    expect(project.frameworks).toEqual(fixture.frameworks);
    expect(project.services).toEqual(fixture.services);
    expect(project.existingAgentConfigs).toEqual(fixture.agentConfigs);
    expect(project.packageManagers).toEqual(fixture.packageManagers);
    expect(project.monorepo).toBe(fixture.monorepo ?? false);
    expect(versions).toMatchObject(fixture.versions);
    expect(composed.profiles).toEqual(fixture.profiles);
    expect(new Set(composed.requiredCapabilities).size).toBe(
      composed.requiredCapabilities.length,
    );
    expect(new Set(composed.usefulCapabilities).size).toBe(
      composed.usefulCapabilities.length,
    );
    for (const evidence of fixture.signalEvidence ?? []) {
      expect(
        project.detectionSignals.some((signal) =>
          signal.evidence?.includes(evidence),
        ),
      ).toBe(true);
    }
  });
});
