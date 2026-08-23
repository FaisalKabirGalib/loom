import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CapabilityPlan } from "@loom/core";
import { parse } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeHarnessAdapter } from "./index.js";

const roots: string[] = [];
const capabilityPlan = {} as CapabilityPlan;

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function fixture(): Promise<{
  root: string;
  skills: string;
  adapter: ClaudeHarnessAdapter;
}> {
  const root = await mkdtemp(join(tmpdir(), "loom-claude-project-"));
  const skills = await mkdtemp(join(tmpdir(), "loom-claude-skills-"));
  roots.push(root, skills);
  await write(
    join(skills, "loom-project-start", "SKILL.md"),
    "---\nname: loom-project-start\n---\n\n# Start\n",
  );
  await write(
    join(skills, "loom-verification-loop", "SKILL.md"),
    "---\nname: loom-verification-loop\n---\n\n# Verify\n",
  );
  return {
    root,
    skills,
    adapter: new ClaudeHarnessAdapter({ skillsSource: skills }),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ClaudeHarnessAdapter", () => {
  it("copies only canonical skill files and structurally merges mcpServers.loom", async () => {
    const { root, skills, adapter } = await fixture();
    await write(join(skills, "loom-project-start", "ignored.md"), "ignored\n");
    const original = `{
  // preserve this byte range
  "mcpServers": {
    "other": { "type": "http", "url": "https://example.test" },
  },
  "permissions": { "allow": ["Read"] },
}
`;
    await write(join(root, ".mcp.json"), original);

    const result = await adapter.apply(
      await adapter.planInstall(root, capabilityPlan),
    );
    const config = await readFile(join(root, ".mcp.json"), "utf8");
    const value = parse(config) as {
      mcpServers: Record<string, unknown>;
      permissions: unknown;
    };
    const ownership = JSON.parse(
      await readFile(join(root, ".loom/ownership.json"), "utf8"),
    ) as {
      harnesses: {
        claude: {
          files: Record<string, string>;
          pointers: Record<string, { path: string; value: unknown }>;
        };
      };
    };

    expect(result.diagnostics).toEqual([]);
    expect(config).toContain("// preserve this byte range");
    expect(config).toContain('"permissions": { "allow": ["Read"] }');
    expect(value.mcpServers.other).toEqual({
      type: "http",
      url: "https://example.test",
    });
    expect(value.mcpServers.loom).toEqual({
      type: "stdio",
      command: "loom",
      args: ["mcp"],
    });
    expect(
      await readFile(
        join(root, ".claude/skills/loom-project-start/SKILL.md"),
        "utf8",
      ),
    ).toContain("# Start");
    await expect(
      readFile(
        join(root, ".claude/skills/loom-project-start/ignored.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(ownership.harnesses.claude.pointers["mcpServers.loom"]).toEqual({
      path: ".mcp.json",
      value: { type: "stdio", command: "loom", args: ["mcp"] },
    });
    for (const [path, expectedHash] of Object.entries(
      ownership.harnesses.claude.files,
    )) {
      expect(expectedHash).toBe(
        createHash("sha256")
          .update(await readFile(join(root, path), "utf8"))
          .digest("hex"),
      );
    }
    expect(await adapter.verify(root)).toEqual([]);
  });

  it("supports injected command, args, and skills source", async () => {
    const { root, skills } = await fixture();
    const adapter = new ClaudeHarnessAdapter({
      command: "node",
      args: ["./loom.mjs", "mcp"],
      skillsSource: skills,
    });
    await adapter.apply(await adapter.planInstall(root, capabilityPlan));
    const value = JSON.parse(
      await readFile(join(root, ".mcp.json"), "utf8"),
    ) as {
      mcpServers: { loom: unknown };
    };
    expect(value.mcpServers.loom).toEqual({
      type: "stdio",
      command: "node",
      args: ["./loom.mjs", "mcp"],
    });
  });

  it("is dry-run safe and idempotent", async () => {
    const { root, adapter } = await fixture();
    const plan = await adapter.planInstall(root, capabilityPlan);
    expect((await adapter.apply(plan, true)).changed.length).toBeGreaterThan(0);
    await expect(
      readFile(join(root, ".mcp.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await adapter.apply(plan)).changed.length).toBeGreaterThan(0);
    expect((await adapter.apply(plan)).changed).toEqual([]);
    expect((await adapter.planInstall(root, capabilityPlan)).mutations).toEqual(
      [],
    );
  });

  it("rolls back partial apply failures", async () => {
    const { root, skills } = await fixture();
    await write(join(root, "notes.txt"), "untouched\n");
    let writes = 0;
    const adapter = new ClaudeHarnessAdapter({
      skillsSource: skills,
      fileOperations: {
        async write(path, content) {
          writes += 1;
          if (writes === 2) throw new Error("injected failure");
          await write(path, content);
        },
        async remove(path) {
          await rm(path);
        },
      },
    });

    const result = await adapter.apply(
      await adapter.planInstall(root, capabilityPlan),
    );
    expect(result.changed).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "claude.apply-failed",
        message: expect.stringContaining(
          "all earlier mutations were rolled back",
        ),
      }),
    );
    await expect(
      readFile(
        join(root, ".claude/skills/loom-project-start/SKILL.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("untouched\n");
  });

  it("refuses unowned collisions and modified owned resources", async () => {
    const { root, adapter } = await fixture();
    await write(
      join(root, ".mcp.json"),
      '{"mcpServers":{"loom":{"type":"stdio","command":"other","args":[]}}}\n',
    );
    let planned = await adapter.planInstall(root, capabilityPlan);
    expect(planned.mutations).toEqual([]);
    expect(planned.diagnostics.map((item) => item.code)).toContain(
      "claude.mcp-collision",
    );

    await rm(join(root, ".mcp.json"));
    await adapter.apply(await adapter.planInstall(root, capabilityPlan));
    const skill = join(root, ".claude/skills/loom-project-start/SKILL.md");
    await writeFile(skill, "user change\n");
    const config = join(root, ".mcp.json");
    const changedConfig = JSON.parse(await readFile(config, "utf8")) as {
      mcpServers: { loom: unknown };
    };
    changedConfig.mcpServers.loom = {
      type: "stdio",
      command: "other",
      args: [],
    };
    await writeFile(config, `${JSON.stringify(changedConfig, null, 2)}\n`);
    planned = await adapter.planInstall(root, capabilityPlan);
    expect(planned.mutations).toEqual([]);
    expect(planned.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "claude.modified-owned-file",
        "claude.modified-owned-pointer",
      ]),
    );
    const uninstall = await adapter.uninstallOwned(root);
    expect(uninstall.skipped).toEqual(expect.arrayContaining([skill, config]));
    expect(await readFile(skill, "utf8")).toBe("user change\n");
  });

  it("safely uninstalls exact owned resources while preserving shared files and JSONC", async () => {
    const { root, adapter } = await fixture();
    await write(
      join(root, ".mcp.json"),
      `{
  // retained
  "mcpServers": { "other": { "command": "other" } },
  "setting": true
}
`,
    );
    await adapter.apply(await adapter.planInstall(root, capabilityPlan));
    const ownershipPath = join(root, ".loom/ownership.json");
    const ownership = JSON.parse(await readFile(ownershipPath, "utf8")) as {
      harnesses: Record<string, unknown> & {
        claude: { files: Record<string, string> };
      };
    };
    const sharedPath = ".claude/skills/loom-project-start/SKILL.md";
    ownership.harnesses.other = {
      files: { [sharedPath]: ownership.harnesses.claude.files[sharedPath] },
    };
    await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);

    const result = await adapter.uninstallOwned(root);
    const config = await readFile(join(root, ".mcp.json"), "utf8");
    const value = parse(config) as {
      mcpServers: Record<string, unknown>;
      setting: boolean;
    };
    expect(result.diagnostics).toEqual([]);
    expect(config).toContain("// retained");
    expect(value.mcpServers.other).toEqual({ command: "other" });
    expect(value.mcpServers.loom).toBeUndefined();
    expect(value.setting).toBe(true);
    expect(await readFile(join(root, sharedPath), "utf8")).toContain("# Start");
    await expect(
      readFile(
        join(root, ".claude/skills/loom-verification-loop/SKILL.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(ownershipPath, "utf8")).toContain('"other"');
    expect(await readFile(ownershipPath, "utf8")).not.toContain('"claude"');
  });

  it("rejects traversal, absolute, and non-canonical ownership paths", async () => {
    const { skills } = await fixture();
    const container = await mkdtemp(join(tmpdir(), "loom-claude-forged-"));
    roots.push(container);
    const root = join(container, "project", "nested");
    await mkdir(root, { recursive: true });
    const adapter = new ClaudeHarnessAdapter({ skillsSource: skills });
    for (const ownedPath of [
      "../../victim",
      join(container, "absolute-victim"),
      ".claude/skills/loom-safe/extra/SKILL.md",
    ]) {
      const victim = join(container, "victim");
      await write(victim, "safe\n");
      await write(
        join(root, ".loom/ownership.json"),
        `${JSON.stringify({
          version: 1,
          harnesses: {
            claude: {
              files: { [ownedPath]: "forged" },
              pointers: {
                "mcpServers.loom": { path: ".mcp.json", value: {} },
              },
            },
          },
        })}\n`,
      );
      expect(
        (await adapter.uninstallOwned(root)).diagnostics.map(
          (item) => item.code,
        ),
      ).toContain("claude.invalid-ownership");
      expect(await readFile(victim, "utf8")).toBe("safe\n");
    }
  });

  it("rejects symlinked managed components and source skills", async () => {
    const { root, skills, adapter } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "loom-claude-outside-"));
    roots.push(outside);
    await write(join(outside, "victim"), "safe\n");
    await symlink(outside, join(root, ".claude"), "dir");
    await symlink(outside, join(root, ".loom"), "dir");
    const result = await adapter.apply(
      await adapter.planInstall(root, capabilityPlan),
    );
    expect(result.changed).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "claude.unsafe-path",
    );
    expect(await readFile(join(outside, "victim"), "utf8")).toBe("safe\n");

    await rm(join(skills, "loom-project-start"), { recursive: true });
    await symlink(outside, join(skills, "loom-project-start"), "dir");
    const cleanRoot = await mkdtemp(join(tmpdir(), "loom-claude-clean-"));
    roots.push(cleanRoot);
    const sourcePlan = await new ClaudeHarnessAdapter({
      skillsSource: skills,
    }).planInstall(cleanRoot, capabilityPlan);
    expect(sourcePlan.mutations).toEqual([]);
    expect(sourcePlan.diagnostics.map((item) => item.code)).toContain(
      "claude.skills-source",
    );
  });

  it("rejects forged, cloned, and foreign plans and detects concurrency", async () => {
    const { root, skills, adapter } = await fixture();
    const victim = join(root, ".mcp.json");
    await write(victim, "{}\n");
    const forged = await adapter.apply({
      harness: "claude",
      root,
      diagnostics: [],
      mutations: [
        {
          kind: "update-file",
          path: victim,
          description: "forged",
          content: '{"bad":true}\n',
          expectedHash: createHash("sha256").update("{}\n").digest("hex"),
        },
      ],
    });
    expect(forged.changed).toEqual([]);
    expect(forged.diagnostics.map((item) => item.code)).toContain(
      "claude.invalid-mutation",
    );

    const issued = await adapter.planInstall(root, capabilityPlan);
    expect((await adapter.apply(structuredClone(issued))).changed).toEqual([]);
    expect(
      (await new ClaudeHarnessAdapter({ skillsSource: skills }).apply(issued))
        .changed,
    ).toEqual([]);
    await writeFile(victim, '{"changed":true}\n');
    const concurrent = await adapter.apply(issued);
    expect(concurrent.changed).toEqual([]);
    expect(concurrent.diagnostics.map((item) => item.code)).toContain(
      "claude.concurrent-change",
    );
    expect(await readFile(victim, "utf8")).toBe('{"changed":true}\n');
  });
});
