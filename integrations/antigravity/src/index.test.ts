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
import { dirname, join, resolve } from "node:path";
import type { CapabilityPlan } from "@loom/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_CLI_VERSION,
  ANTIGRAVITY_VERSION,
  AntigravityHarnessAdapter,
} from "./index.js";

const roots: string[] = [];
const capabilityPlan = {} as CapabilityPlan;
const skillContent =
  "---\nname: loom-project-start\ndescription: Start.\n---\n";

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function fixture(): Promise<{
  root: string;
  source: string;
  adapter: AntigravityHarnessAdapter;
}> {
  const root = await mkdtemp(join(tmpdir(), "loom-antigravity-project-"));
  const source = await mkdtemp(join(tmpdir(), "loom-antigravity-skills-"));
  roots.push(root, source);
  await write(join(source, "loom-project-start/SKILL.md"), skillContent);
  return {
    root,
    source,
    adapter: new AntigravityHarnessAdapter({ source }),
  };
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("AntigravityHarnessAdapter", () => {
  it("targets Antigravity 2.9.1 and CLI 1.1.17", () => {
    expect(ANTIGRAVITY_VERSION).toBe("2.9.1");
    expect(ANTIGRAVITY_CLI_VERSION).toBe("1.1.17");
  });

  it("installs only canonical skills and structurally merges mcpServers.loom", async () => {
    const { root, source, adapter } = await fixture();
    await write(
      join(source, "loom-project-start/reference.md"),
      "not installed\n",
    );
    await write(
      join(root, ".agents/mcp_config.json"),
      `${JSON.stringify({
        mcpServers: { other: { command: "other", args: [] } },
        setting: { retained: true },
      })}\n`,
    );

    const result = await adapter.apply(
      await adapter.planInstall(root, capabilityPlan),
    );
    const config = JSON.parse(
      await readFile(join(root, ".agents/mcp_config.json"), "utf8"),
    );

    expect(result.diagnostics).toEqual([]);
    expect(config).toEqual({
      mcpServers: {
        other: { command: "other", args: [] },
        loom: { command: "loom", args: ["mcp"] },
      },
      setting: { retained: true },
    });
    expect(
      await readFile(
        join(root, ".agents/skills/loom-project-start/SKILL.md"),
        "utf8",
      ),
    ).toBe(skillContent);
    await expect(
      readFile(
        join(root, ".agents/skills/loom-project-start/reference.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports injected command, args, and source", async () => {
    const { root, source } = await fixture();
    const adapter = new AntigravityHarnessAdapter({
      command: "node",
      args: ["loom.mjs", "mcp"],
      source,
    });
    await adapter.apply(await adapter.planInstall(root, capabilityPlan));
    const config = JSON.parse(
      await readFile(join(root, ".agents/mcp_config.json"), "utf8"),
    );

    expect(config.mcpServers.loom).toEqual({
      command: "node",
      args: ["loom.mjs", "mcp"],
    });
  });

  it("is dry-run safe and idempotent", async () => {
    const { root, adapter } = await fixture();
    const plan = await adapter.planInstall(root, capabilityPlan);
    expect((await adapter.apply(plan, true)).changed.length).toBeGreaterThan(0);
    await expect(
      readFile(join(root, ".agents/mcp_config.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect((await adapter.apply(plan)).changed.length).toBeGreaterThan(0);
    expect((await adapter.apply(plan)).changed).toEqual([]);
    expect((await adapter.planInstall(root, capabilityPlan)).mutations).toEqual(
      [],
    );
    expect(await adapter.verify(root)).toEqual([]);
  });

  it("rolls back all writes after an injected apply failure", async () => {
    const { root, source } = await fixture();
    let writes = 0;
    const adapter = new AntigravityHarnessAdapter({
      source,
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
        code: "antigravity.apply-failed",
        message: expect.stringContaining(
          "all earlier mutations were rolled back",
        ),
      }),
    );
    await expect(
      readFile(
        join(root, ".agents/skills/loom-project-start/SKILL.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(root, ".loom/ownership.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects MCP and unowned skill collisions", async () => {
    const { root, adapter } = await fixture();
    await write(
      join(root, ".agents/skills/loom-project-start/SKILL.md"),
      "user skill\n",
    );
    await write(
      join(root, ".agents/mcp_config.json"),
      '{"mcpServers":{"loom":{"command":"other","args":[]}}}\n',
    );

    const plan = await adapter.planInstall(root, capabilityPlan);

    expect(plan.mutations).toEqual([]);
    expect(plan.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "antigravity.skill-collision",
        "antigravity.mcp-collision",
      ]),
    );
  });

  it.each([
    [
      "OpenCode map",
      {
        files: {
          ".agents/skills/loom-project-start/SKILL.md": hash(skillContent),
        },
      },
    ],
    [
      "Codex array",
      {
        files: [
          {
            path: ".agents/skills/loom-project-start/SKILL.md",
            sha256: hash(skillContent),
          },
        ],
      },
    ],
  ])(
    "shares identical skills owned in the %s format and preserves them on uninstall",
    async (_name, other) => {
      const { root, adapter } = await fixture();
      await write(
        join(root, ".agents/skills/loom-project-start/SKILL.md"),
        skillContent,
      );
      await write(
        join(root, ".loom/ownership.json"),
        `${JSON.stringify({ version: 1, harnesses: { other } }, null, 2)}\n`,
      );

      expect(
        (await adapter.apply(await adapter.planInstall(root, capabilityPlan)))
          .diagnostics,
      ).toEqual([]);
      expect((await adapter.uninstallOwned(root)).diagnostics).toEqual([]);
      expect(
        await readFile(
          join(root, ".agents/skills/loom-project-start/SKILL.md"),
          "utf8",
        ),
      ).toBe(skillContent);
      const ownership = JSON.parse(
        await readFile(join(root, ".loom/ownership.json"), "utf8"),
      );
      expect(ownership.harnesses).toEqual({ other });
    },
  );

  it("rejects shared skill version skew", async () => {
    const { root, adapter } = await fixture();
    const old = "old shared version\n";
    const path = ".agents/skills/loom-project-start/SKILL.md";
    await write(join(root, path), old);
    await write(
      join(root, ".loom/ownership.json"),
      `${JSON.stringify({
        version: 1,
        harnesses: { codex: { files: [{ path, sha256: hash(old) }] } },
      })}\n`,
    );

    const plan = await adapter.planInstall(root, capabilityPlan);

    expect(plan.mutations).toEqual([]);
    expect(plan.diagnostics.map((item) => item.code)).toContain(
      "antigravity.shared-version-collision",
    );
    expect(await readFile(join(root, path), "utf8")).toBe(old);
  });

  it("uninstalls only owned resources and retains unrelated settings", async () => {
    const { root, adapter } = await fixture();
    await write(
      join(root, ".agents/mcp_config.json"),
      `${JSON.stringify({
        mcpServers: { other: { command: "other", args: [] } },
        retained: true,
      })}\n`,
    );
    await adapter.apply(await adapter.planInstall(root, capabilityPlan));

    const dryRun = await adapter.uninstallOwned(root, true);
    expect(dryRun.changed.length).toBeGreaterThan(0);
    expect(await adapter.verify(root)).toEqual([]);
    expect((await adapter.uninstallOwned(root)).diagnostics).toEqual([]);
    const config = JSON.parse(
      await readFile(join(root, ".agents/mcp_config.json"), "utf8"),
    );
    expect(config).toEqual({
      mcpServers: { other: { command: "other", args: [] } },
      retained: true,
    });
    await expect(
      readFile(join(root, ".loom/ownership.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses modified owned files and pointers during update and uninstall", async () => {
    const { root, adapter } = await fixture();
    await adapter.apply(await adapter.planInstall(root, capabilityPlan));
    const skill = join(root, ".agents/skills/loom-project-start/SKILL.md");
    await write(skill, "modified\n");

    expect(
      (await adapter.planInstall(root, capabilityPlan)).diagnostics.map(
        (item) => item.code,
      ),
    ).toContain("antigravity.owned-file-modified");
    expect(
      (await adapter.uninstallOwned(root)).diagnostics.map((item) => item.code),
    ).toContain("antigravity.owned-file-modified");
    expect(await readFile(skill, "utf8")).toBe("modified\n");
  });

  it("rejects ownership version skew and traversal paths", async () => {
    const { root, adapter } = await fixture();
    const victim = resolve(root, "../victim");
    await write(victim, "safe\n");
    roots.push(victim);
    await write(
      join(root, ".loom/ownership.json"),
      `${JSON.stringify({ version: 2, harnesses: { antigravity: { files: { "../../victim": hash("safe\n") }, pointers: {} } } })}\n`,
    );

    expect(
      (await adapter.uninstallOwned(root)).diagnostics.map((item) => item.code),
    ).toContain("antigravity.ownership-invalid");
    expect(await readFile(victim, "utf8")).toBe("safe\n");
  });

  it("rejects symlinked managed parents and symlinked skill sources", async () => {
    const { root, source } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "loom-antigravity-outside-"));
    roots.push(outside);
    await rm(join(root, ".agents"), { recursive: true, force: true });
    await symlink(outside, join(root, ".agents"), "dir");
    const adapter = new AntigravityHarnessAdapter({ source });

    const result = await adapter.apply(
      await adapter.planInstall(root, capabilityPlan),
    );

    expect(result.changed).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "antigravity.unsafe-path",
    );
    await expect(
      readFile(join(outside, "mcp_config.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const linkedSource = join(root, "linked-source");
    await symlink(source, linkedSource, "dir");
    const linkedProject = await mkdtemp(
      join(tmpdir(), "loom-antigravity-linked-project-"),
    );
    roots.push(linkedProject);
    expect(
      (
        await new AntigravityHarnessAdapter({
          source: linkedSource,
        }).planInstall(linkedProject, capabilityPlan)
      ).diagnostics.map((item) => item.code),
    ).toContain("antigravity.skills-source");
  });

  it("applies only immutable plans issued by the same adapter instance", async () => {
    const { root, source, adapter } = await fixture();
    const config = join(root, ".agents/mcp_config.json");
    const forged = await adapter.apply({
      harness: "antigravity",
      root,
      diagnostics: [],
      mutations: [
        {
          kind: "create-file",
          path: config,
          description: "forged",
          content: '{"forged":true}\n',
        },
      ],
    });
    expect(forged.diagnostics.map((item) => item.code)).toContain(
      "antigravity.invalid-mutation",
    );
    const issued = await adapter.planInstall(root, capabilityPlan);
    expect(
      (await adapter.apply(structuredClone(issued))).diagnostics.map(
        (item) => item.code,
      ),
    ).toContain("antigravity.invalid-mutation");
    expect(
      (
        await new AntigravityHarnessAdapter({ source }).apply(issued)
      ).diagnostics.map((item) => item.code),
    ).toContain("antigravity.invalid-mutation");
    expect(Object.isFrozen(issued)).toBe(true);
    expect((await adapter.apply(issued)).diagnostics).toEqual([]);
  });
});
