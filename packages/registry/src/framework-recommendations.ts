import type { ProjectProfile } from "@loom/core";

export type FrameworkRecommendationKind = "skill" | "mcp" | "tool";
export type FrameworkRecommendationStatus =
  "default" | "installable" | "suggested";

export interface FrameworkRecommendation {
  framework: string;
  id: string;
  name: string;
  kind: FrameworkRecommendationKind;
  status: FrameworkRecommendationStatus;
  rationale: string;
  manualCommand?: string;
}

export interface FrameworkRecommendations {
  defaults: FrameworkRecommendation[];
  installable: FrameworkRecommendation[];
  suggested: FrameworkRecommendation[];
}

export function isWebAgentIntelligenceEligible(
  project: ProjectProfile,
): boolean {
  return (
    project.languages.includes("typescript") ||
    project.frameworks.some((name) =>
      ["react", "next.js", "vite", "astro"].includes(name),
    )
  );
}

const defaults = {
  project: {
    id: "loom-project-setup",
    name: "Loom project setup",
    rationale: "Provides Loom's project workflow guidance.",
  },
  dependency: {
    id: "loom-dependency-research",
    name: "Loom dependency research",
    rationale: "Keeps dependency decisions evidence-based.",
  },
  design: {
    id: "loom-design-director",
    name: "Loom design director",
    rationale: "Guides accessible, consistent interface work.",
  },
  verification: {
    id: "loom-verification-loop",
    name: "Loom verification loop",
    rationale: "Requires targeted validation before completion.",
  },
} as const;

function recommendation(
  framework: string,
  value: Omit<FrameworkRecommendation, "framework">,
): FrameworkRecommendation {
  return { framework, ...value };
}

function loomDefault(
  framework: string,
  value: (typeof defaults)[keyof typeof defaults],
): FrameworkRecommendation {
  return recommendation(framework, {
    ...value,
    kind: "skill",
    status: "default",
  });
}

function sortedUnique(
  values: readonly FrameworkRecommendation[],
): FrameworkRecommendation[] {
  return [
    ...new Map(
      values.map((value) => [`${value.framework}:${value.id}`, value]),
    ),
  ]
    .map(([, value]) => value)
    .sort(
      (left, right) =>
        left.framework.localeCompare(right.framework) ||
        left.id.localeCompare(right.id),
    );
}

export function frameworkRecommendations(
  project: ProjectProfile,
): FrameworkRecommendations {
  const defaultsForProject: FrameworkRecommendation[] = [];
  const installable: FrameworkRecommendation[] = [];
  const suggested: FrameworkRecommendation[] = [];
  const flutter =
    project.languages.includes("dart") ||
    project.frameworks.includes("dart") ||
    project.frameworks.includes("flutter");
  const web = isWebAgentIntelligenceEligible(project);
  const typescript = project.languages.includes("typescript");

  if (flutter) {
    const framework = project.frameworks.includes("flutter")
      ? "flutter"
      : "dart";
    defaultsForProject.push(
      loomDefault(framework, defaults.project),
      loomDefault(framework, defaults.dependency),
      loomDefault(framework, defaults.verification),
    );
    installable.push(
      recommendation(framework, {
        id: "builtin:flutter-package-intelligence",
        name: "Flutter package intelligence",
        kind: "tool",
        status: "installable",
        rationale:
          "Audited pinned Flutter/Dart recipe; setup is verified on OpenCode only.",
        manualCommand: "loom setup --intent <reviewed-intent> (OpenCode only)",
      }),
      recommendation(framework, {
        id: "dart-mcp-server",
        name: "Dart MCP server",
        kind: "mcp",
        status: "installable",
        rationale:
          "Installed by the audited Flutter recipe for Dart SDK analysis; OpenCode only.",
      }),
      recommendation(framework, {
        id: "dart-pubdev-explorer",
        name: "dart-pubdev explorer",
        kind: "mcp",
        status: "installable",
        rationale:
          "Installed by the audited Flutter recipe for package intelligence; OpenCode only.",
      }),
    );
    suggested.push(
      recommendation(framework, {
        id: "flutter-package-skills",
        name: "Task-relevant package skills",
        kind: "skill",
        status: "suggested",
        rationale:
          "Let the agent select exact locked package or immutable registry skills for the task; no fixed bundle is applied.",
        manualCommand:
          "Use loom_skill_search, then provide reviewed exact selections to loom_setup_recommend.",
      }),
    );
  }

  if (web) {
    const framework = project.frameworks.includes("next.js")
      ? "next.js"
      : project.frameworks.includes("react")
        ? "react"
        : project.languages.includes("typescript")
          ? "typescript"
          : "web";
    defaultsForProject.push(
      loomDefault(framework, defaults.project),
      loomDefault(framework, defaults.dependency),
      loomDefault(framework, defaults.design),
      loomDefault(framework, defaults.verification),
    );
    installable.push(
      recommendation(framework, {
        id: "builtin:web-agent-intelligence",
        name: "Web agent intelligence",
        kind: "tool",
        status: "installable",
        rationale:
          "Audited pinned agent-browser MCP and opensrc skill recipe for supported harnesses.",
        manualCommand:
          "AGENT_BROWSER_EXECUTABLE_PATH must point to a project-local verified executable; Loom will not download browser.",
      }),
    );
    suggested.push(
      recommendation(framework, {
        id: "builtin:context7",
        name: "Context7",
        kind: "mcp",
        status: "suggested",
        rationale:
          "Use current framework and package documentation when needed.",
        manualCommand: "loom discover mcp context7",
      }),
      recommendation(framework, {
        id: "builtin:chrome-devtools-mcp",
        name: "Chrome DevTools MCP",
        kind: "mcp",
        status: "suggested",
        rationale: "Consider for browser performance and runtime debugging.",
        manualCommand: "loom discover mcp chrome-devtools-mcp",
      }),
    );
    if (project.frameworks.includes("storybook"))
      suggested.push(
        recommendation("storybook", {
          id: "builtin:storybook-mcp",
          name: "Storybook MCP",
          kind: "mcp",
          status: "suggested",
          rationale: "Consider for component catalog and story inspection.",
          manualCommand: "loom discover mcp storybook-mcp",
        }),
      );
    if (project.frameworks.includes("shadcn"))
      suggested.push(
        recommendation("shadcn", {
          id: "builtin:shadcn-mcp",
          name: "shadcn MCP",
          kind: "mcp",
          status: "suggested",
          rationale: "Consider for component registry and design-system work.",
          manualCommand: "loom discover mcp shadcn-mcp",
        }),
      );
  }

  if (typescript && !web)
    defaultsForProject.push(
      loomDefault("typescript", defaults.project),
      loomDefault("typescript", defaults.dependency),
      loomDefault("typescript", defaults.verification),
    );

  return {
    defaults: sortedUnique(defaultsForProject),
    installable: sortedUnique(installable),
    suggested: sortedUnique(suggested),
  };
}
