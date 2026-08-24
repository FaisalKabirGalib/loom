import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { GitHubSkillResolver } from "./github-skill.js";
import { SkillsCliRegistry } from "./skills-cli.js";

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("GitHubSkillResolver", () => {
  it("pins HEAD, resolves the actual skill path, and hashes every blob", async () => {
    const skill =
      "---\nname: repo-skill\ndescription: Exact registry skill.\n---\n";
    const reference = "Pinned reference.\n";
    const commit = "a".repeat(40);
    const skillBlob = "b".repeat(40);
    const referenceBlob = "c".repeat(40);
    const registry = new SkillsCliRegistry({
      runner: {
        run: async () => ({
          exitCode: 0,
          stdout: "owner/repo@repo-skill\n",
          stderr: "",
        }),
      },
    });
    const candidate = (await registry.search({ text: "repo-skill" }))[0]!;
    const resolver = new GitHubSkillResolver({
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/commits/HEAD")) return json({ sha: commit });
        if (path.includes("/git/trees/"))
          return json({
            truncated: false,
            tree: [
              {
                path: "catalog/repo-skill/SKILL.md",
                mode: "100644",
                type: "blob",
                sha: skillBlob,
              },
              {
                path: "catalog/repo-skill/references",
                mode: "040000",
                type: "tree",
                sha: "d".repeat(40),
              },
              {
                path: "catalog/repo-skill/references/api.md",
                mode: "100644",
                type: "blob",
                sha: referenceBlob,
              },
            ],
          });
        if (path.endsWith(skillBlob))
          return json({
            encoding: "base64",
            content: Buffer.from(skill).toString("base64"),
          });
        if (path.endsWith(referenceBlob))
          return json({
            encoding: "base64",
            content: Buffer.from(reference).toString("base64"),
          });
        return json({}, 404);
      },
    });
    const digest = (value: string) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`;

    const resolved = await resolver.resolve(candidate);

    expect(resolved).toEqual({
      repository: "https://github.com/owner/repo",
      commit,
      path: "catalog/repo-skill",
      contentHash: digest(
        [
          `SKILL.md\0${digest(skill)}`,
          `references/api.md\0${digest(reference)}`,
        ].join("\n"),
      ),
      description: "Exact registry skill.",
    });
  });

  it("rejects symlink entries", async () => {
    const registry = new SkillsCliRegistry({
      runner: {
        run: async () => ({
          exitCode: 0,
          stdout: "owner/repo@repo-skill\n",
          stderr: "",
        }),
      },
    });
    const candidate = (await registry.search({ text: "repo-skill" }))[0]!;
    const resolver = new GitHubSkillResolver({
      fetch: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/commits/HEAD"))
          return json({ sha: "a".repeat(40) });
        return json({
          truncated: false,
          tree: [
            {
              path: "repo-skill/SKILL.md",
              mode: "120000",
              type: "blob",
              sha: "b".repeat(40),
            },
          ],
        });
      },
    });

    await expect(resolver.resolve(candidate)).rejects.toThrow(
      "unsupported entries",
    );
  });
});
