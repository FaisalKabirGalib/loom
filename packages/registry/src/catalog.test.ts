import { ALL_CAPABILITIES } from "@loom/core";
import { describe, expect, it } from "vitest";

import { BUILTIN_CATALOG } from "./catalog.js";

describe("BUILTIN_CATALOG", () => {
  it("contains the specification and framework-profile seeds with canonical capabilities", () => {
    const names = new Set(BUILTIN_CATALOG.map((candidate) => candidate.name));
    for (const name of [
      "Codanna",
      "CodeGraphy",
      "Serena",
      "rag-rat",
      "TeaRAGs",
      "srag",
      "ast-grep",
      "pluck",
      "Repomix",
      "Context7",
      "GitMCP",
      "DeepWiki",
      "opensrc",
      "agent-browser",
      "Chrome DevTools MCP",
      "Storybook MCP",
      "shadcn MCP",
      "Widgetbook",
      "agent-react-devtools",
      "Figma MCP",
      "UI UX Pro Max",
      "Awesome DESIGN.md",
      "21st MCP",
      "axe accessibility",
      "Lighthouse",
      "Flutter Agent Plugins",
      "Dart / Flutter MCP",
      "Patrol MCP",
      "Marionette MCP",
      "Dusk",
      "Maestro MCP",
      "Mobile MCP",
      "Appium MCP",
      "device-mcp",
      "Expo skills",
      "Expo MCP",
      "Callstack React Native agent skills",
      "Vercel React Native skills",
      "Postman MCP",
      "Mockoon MCP",
      "WireMock",
      "Apollo MCP",
      "Socket MCP",
      "Semgrep",
      "SonarQube MCP",
      "SQL safety candidate",
      "DBHub",
      "Supabase MCP",
      "Neon MCP",
      "GitHub MCP",
      "Vercel MCP",
      "Cloudflare MCP",
      "Sentry MCP",
      "Grafana MCP",
      "Datadog MCP",
      "Kubernetes MCP",
      "Terraform MCP",
      "Docker MCP Gateway",
      "Laravel Boost",
      "Laravel Agent Skills",
      "Nightwatch MCP",
      "Laravel Cloud skill/tooling",
      "Laravel MCP framework",
      "Laravel AI SDK",
      "gopls MCP",
    ])
      expect(names.has(name), name).toBe(true);
    const canonical = new Set<string>(ALL_CAPABILITIES);
    expect(
      BUILTIN_CATALOG.every((candidate) =>
        candidate.provides.every((capability) => canonical.has(capability)),
      ),
    ).toBe(true);
    for (const candidate of BUILTIN_CATALOG.filter(
      (item) => item.kind === "mcp" && item.runtime?.kind === "remote",
    )) {
      expect(candidate.transport, candidate.id).toBe("http");
      expect(candidate.permissions.network, candidate.id).toBe(true);
    }
  });
});
