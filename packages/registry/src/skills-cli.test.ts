import { describe, expect, it, vi } from "vitest";

import { SkillsCliRegistry, parseSkillsOutput } from "./skills-cli.js";
import type { ProcessRunner } from "./types.js";

describe("SkillsCliRegistry", () => {
  it("parses JSON list output and uses only discovery commands", async () => {
    const run = vi.fn<ProcessRunner["run"]>().mockResolvedValue({
      stdout: JSON.stringify({
        skills: [
          { source: "expo/skills@expo-router", installs: 1200 },
          {
            repository: "https://github.com/laravel/agent-skills",
            name: "upgrades",
          },
        ],
      }),
      stderr: "",
      exitCode: 0,
    });
    const registry = new SkillsCliRegistry({ runner: { run } });

    const candidates = await registry.list();

    expect(run).toHaveBeenCalledWith("npx", [
      "--yes",
      "skills@1.5.23",
      "list",
      "--json",
    ]);
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      "skill:expo/skills@expo-router",
      "skill:laravel/agent-skills@upgrades",
    ]);
    expect(candidates[0]?.metrics?.installs).toBe(1200);
    await expect(registry.search({ kinds: ["mcp"] })).resolves.toEqual([]);
  });

  it("conservatively parses ANSI search output", () => {
    const parsed = parseSkillsOutput(
      "\u001B[32mexpo/skills@expo-router 1.2k installs\u001B[0m\nnoise owner/repo@unsafe\n└ laravel/agent-skills@upgrades\n",
    );

    expect(parsed.map((item) => item.reference)).toEqual([
      "expo/skills@expo-router",
      "laravel/agent-skills@upgrades",
    ]);
    expect(parsed[0]?.installs).toBe(1200);
  });

  it("returns no candidates for malformed or failed output", async () => {
    expect(parseSkillsOutput('{"skills":"not-an-array"}')).toEqual([]);
    expect(
      parseSkillsOutput("installed owner/repo@skill successfully"),
    ).toEqual([]);
    const runner: ProcessRunner = {
      run: vi.fn().mockResolvedValue({
        stdout: "owner/repo@skill",
        stderr: "failed",
        exitCode: 1,
      }),
    };
    const registry = new SkillsCliRegistry({ runner });
    await expect(registry.search({ text: "skill" })).resolves.toEqual([]);
  });
});
