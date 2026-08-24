import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { detectProject } from "@loom/core";
import { afterEach, describe, expect, it } from "vitest";

import { discoverFlutterSkills } from "./flutter-skills.js";
import { SkillsCliRegistry } from "./skills-cli.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("discoverFlutterSkills", () => {
  it("records the locked raw archive hash for hosted skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-hosted-skill-"));
    roots.push(root);
    const packageRoot = join(root, "cache/example_pkg-1.2.3");
    await mkdir(join(packageRoot, "skills/example_pkg-help"), {
      recursive: true,
    });
    await mkdir(join(root, ".dart_tool"));
    await writeFile(
      join(packageRoot, "skills/example_pkg-help/SKILL.md"),
      "---\nname: example_pkg-help\ndescription: Help.\n---\n",
    );
    await writeFile(
      join(root, "pubspec.lock"),
      `packages:\n  example_pkg:\n    description:\n      sha256: ${"a".repeat(64)}\n    source: hosted\n    version: "1.2.3"\n`,
    );
    await writeFile(
      join(root, ".dart_tool/package_config.json"),
      JSON.stringify({
        configVersion: 2,
        packages: [
          { name: "example_pkg", rootUri: pathToFileURL(packageRoot).href },
        ],
      }),
    );
    const result = await discoverFlutterSkills(
      root,
      detectProject(root),
      {
        intents: [],
        requiredCapabilities: [],
        usefulCapabilities: [],
        risk: "low",
      },
      new SkillsCliRegistry({
        runner: {
          run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        },
      }),
    );

    expect(result.candidates[0]).toMatchObject({
      id: "pub:example_pkg@1.2.3/example_pkg-help",
      archiveHash: `sha256:${"a".repeat(64)}`,
      packageContentHash: `sha256:${"a".repeat(64)}`,
    });
  });

  it("turns immutable resolution failures into warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-skill-search-"));
    roots.push(root);
    const project = detectProject(root);
    const result = await discoverFlutterSkills(
      root,
      project,
      {
        summary: "Use repo skill",
        intents: ["repo-skill"],
        requiredCapabilities: [],
        usefulCapabilities: [],
        risk: "low",
      },
      new SkillsCliRegistry({
        runner: {
          run: async () => ({
            exitCode: 0,
            stdout: "owner/repo@repo-skill\n",
            stderr: "",
          }),
        },
      }),
      {
        resolve: async () => {
          throw new Error("network unavailable");
        },
      },
    );

    expect(result.candidates).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("network unavailable"),
        expect.stringContaining("package skills"),
      ]),
    );
  });
});
