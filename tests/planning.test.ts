import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { planProject } from "../packages/registry/src/index.js";

const fixtures = join(import.meta.dirname, "..", "fixtures");

describe("fixture capability plans", () => {
  for (const [name, selected] of [
    ["nextjs", []],
    ["flutter", ["builtin:flutter-agent-plugins"]],
    ["react-native", ["builtin:callstack-rn-skills"]],
    ["expo", ["builtin:expo-skills"]],
    ["go", ["builtin:gopls-mcp"]],
    ["laravel", ["builtin:laravel-agent-skills"]],
  ] as const) {
    it(`covers required ${name} capabilities with project-fit tools`, async () => {
      const { plan } = await planProject(join(fixtures, name), {
        now: new Date("2026-08-23T00:00:00Z"),
      });

      expect(plan.uncovered).toEqual([]);
      expect(plan.selected.map((item) => item.candidate.id)).toEqual(selected);
    });
  }
});
