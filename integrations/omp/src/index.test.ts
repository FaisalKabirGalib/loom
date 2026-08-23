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
import { dirname, resolve } from "node:path";
import type { CapabilityPlan } from "@loom/core";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessAdapter, OmpHarnessAdapter } from "./index.js";

const roots: string[] = [];
const capabilityPlan = {} as CapabilityPlan;

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function fixture(): Promise<{
  root: string;
  skills: string;
  adapter: OmpHarnessAdapter;
}> {
  const root = await mkdtemp(resolve(tmpdir(), "loom-omp-project-"));
  const skills = await mkdtemp(resolve(tmpdir(), "loom-omp-skills-"));
  roots.push(root, skills);
  await write(
    resolve(skills, "loom-project-start/SKILL.md"),
    "---\nname: loom-project-start\n---\n\n# Start\n",
  );
  await write(
    resolve(skills, "loom-verification-loop/SKILL.md"),
    "---\nname: loom-verification-loop\n---\n\n# Verify\n",
  );
  await write(resolve(skills, "loom-project-start/reference.md"), "ignored\n");
  await write(resolve(skills, "other/SKILL.md"), "ignored\n");
  return {
    root,
    skills,
    adapter: new OmpHarnessAdapter({ skillsSource: skills }),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("OmpHarnessAdapter for Oh My Pi v18.0.3", () => {
  it("exports HarnessAdapter and installs only canonical OMP project paths", async () => {
    const { root, adapter } = await fixture();
    expect(adapter).toBeInstanceOf(HarnessAdapter);

    const result = await adapter.apply(
      await adapter.planInstall(root, capabilityPlan),
    );
    const config = JSON.parse(
      await readFile(resolve(root, ".omp/mcp.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(result.diagnostics).toEqual([]);
    expect(config).toEqual({
      mcpServers: {
        loom: { type: "stdio", command: "loom", args: ["mcp"] },
      },
    });
    expect(
      await readFile(
        resolve(root, ".omp/skills/loom-project-start/SKILL.md"),
        "utf8",
      ),
    ).toContain("# Start");
    await expect(
      readFile(
        resolve(root, ".omp/skills/loom-project-start/reference.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(resolve(root, ".omp/skills/other/SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await adapter.verify(root)).toEqual([]);
  });

  it("structurally preserves every unrelated JSON value", async () => {
    const { root, adapter } = await fixture();
    const existing = {
      $schema: "https://example.test/schema.json",
      mcpServers: {
        other: {
          type: "http",
          url: "https://example.test/mcp",
          headers: { Authorization: "unchanged" },
        },
      },
      disabledServers: ["disabled"],
      nested: { null: null, number: 3, boolean: false, array: [1, "two"] },
    };
    await write(
      resolve(root, ".omp/mcp.json"),
      `${JSON.stringify(existing, null, 4)}\n`,
    );

    await adapter.apply(await adapter.planInstall(root, capabilityPlan));
    const installed = JSON.parse(
      await readFile(resolve(root, ".omp/mcp.json"), "utf8"),
    ) as typeof existing & { mcpServers: Record<string, unknown> };

    expect(installed).toMatchObject(existing);
    expect(installed.mcpServers.loom).toEqual({
      type: "stdio",
      command: "loom",
      args: ["mcp"],
    });
  });

  it("supports injected command, args, and skills source", async () => {
    const { root, skills } = await fixture();
    const adapter = new OmpHarnessAdapter({
      command: "node",
      args: ["/opt/loom.mjs", "mcp", "--stdio"],
      skillsSource: skills,
    });
    await adapter.apply(await adapter.planInstall(root, capabilityPlan));
    const config = JSON.parse(
      await readFile(resolve(root, ".omp/mcp.json"), "utf8"),
    ) as { mcpServers: { loom: unknown } };
    expect(config.mcpServers.loom).toEqual({
      type: "stdio",
      command: "node",
      args: ["/opt/loom.mjs", "mcp", "--stdio"],
    });
  });

  it("is dry-run safe and idempotent across repeated plans and applies", async () => {
    const { root, adapter } = await fixture();
    const plan = await adapter.planInstall(root, capabilityPlan);
    expect((await adapter.apply(plan, true)).changed.length).toBeGreaterThan(0);
    await expect(
      readFile(resolve(root, ".omp/mcp.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect((await adapter.apply(plan)).changed.length).toBeGreaterThan(0);
    expect((await adapter.apply(plan)).changed).toEqual([]);
    expect((await adapter.planInstall(root, capabilityPlan)).mutations).toEqual(
      [],
    );
  });

  it("rolls back a partially failed apply", async () => {
    const { root, skills } = await fixture();
    let writes = 0;
    const adapter = new OmpHarnessAdapter({
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
        code: "omp.apply-failed",
        message: expect.stringContaining(
          "all earlier mutations were rolled back",
        ),
      }),
    );
    await expect(
      readFile(
        resolve(root, ".omp/skills/loom-project-start/SKILL.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(resolve(root, ".loom/ownership.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses collisions and modified owned resources", async () => {
    const { root, adapter } = await fixture();
    await write(
      resolve(root, ".omp/mcp.json"),
      '{"mcpServers":{"loom":{"command":"other"}}}\n',
    );
    await write(
      resolve(root, ".omp/skills/loom-project-start/SKILL.md"),
      "user skill\n",
    );
    const collision = await adapter.planInstall(root, capabilityPlan);
    expect(collision.mutations).toEqual([]);
    expect(collision.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["omp.mcp-collision", "omp.file-collision"]),
    );

    await rm(resolve(root, ".omp"), { recursive: true });
    await adapter.apply(await adapter.planInstall(root, capabilityPlan));
    const skill = resolve(root, ".omp/skills/loom-project-start/SKILL.md");
    await writeFile(skill, "changed\n");
    const reinstall = await adapter.planInstall(root, capabilityPlan);
    const uninstall = await adapter.uninstallOwned(root);
    expect(reinstall.mutations).toEqual([]);
    expect(reinstall.diagnostics.map((item) => item.code)).toContain(
      "omp.modified-owned-file",
    );
    expect(uninstall.diagnostics.map((item) => item.code)).toContain(
      "omp.modified-owned-file",
    );
    expect(await readFile(skill, "utf8")).toBe("changed\n");
  });

  it("surgically uninstalls owned values and preserves other harness ownership", async () => {
    const { root, adapter } = await fixture();
    await write(
      resolve(root, ".omp/mcp.json"),
      JSON.stringify({
        mcpServers: { other: { command: "other", args: [] } },
        disabledServers: ["x"],
      }),
    );
    await adapter.apply(await adapter.planInstall(root, capabilityPlan));
    const ownershipPath = resolve(root, ".loom/ownership.json");
    const ownership = JSON.parse(await readFile(ownershipPath, "utf8")) as {
      harnesses: Record<string, unknown>;
    };
    ownership.harnesses.other = {
      files: {},
      pointers: { keep: { path: "other.json", value: true } },
    };
    await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);

    const dryRun = await adapter.uninstallOwned(root, true);
    expect(dryRun.changed).toContain(resolve(root, ".omp/mcp.json"));
    expect(
      (
        JSON.parse(await readFile(resolve(root, ".omp/mcp.json"), "utf8")) as {
          mcpServers: Record<string, unknown>;
        }
      ).mcpServers.loom,
    ).toBeDefined();

    const result = await adapter.uninstallOwned(root);
    const config = JSON.parse(
      await readFile(resolve(root, ".omp/mcp.json"), "utf8"),
    ) as {
      mcpServers: Record<string, unknown>;
      disabledServers: string[];
    };
    const nextOwnership = JSON.parse(await readFile(ownershipPath, "utf8")) as {
      harnesses: Record<string, unknown>;
    };
    expect(result.diagnostics).toEqual([]);
    expect(config).toEqual({
      mcpServers: { other: { command: "other", args: [] } },
      disabledServers: ["x"],
    });
    expect(nextOwnership.harnesses.omp).toBeUndefined();
    expect(nextOwnership.harnesses.other).toEqual(ownership.harnesses.other);
  });

  it("rejects traversal, absolute, non-SKILL, and invalid-hash ownership", async () => {
    const { skills } = await fixture();
    const container = await mkdtemp(resolve(tmpdir(), "loom-omp-forged-"));
    roots.push(container);
    const root = resolve(container, "project/nested");
    await mkdir(root, { recursive: true });
    const adapter = new OmpHarnessAdapter({ skillsSource: skills });
    const victim = resolve(container, "victim");
    await write(victim, "safe\n");
    for (const path of [
      "../../victim",
      victim,
      ".omp/skills/loom-x/extra.txt",
      ".omp/skills/loom-x/SKILL.md",
    ]) {
      await write(
        resolve(root, ".loom/ownership.json"),
        `${JSON.stringify({
          version: 1,
          harnesses: {
            omp: {
              files: { [path]: "forged" },
              pointers: {
                "mcpServers.loom": {
                  path: ".omp/mcp.json",
                  value: { type: "stdio", command: "loom", args: ["mcp"] },
                },
              },
            },
          },
        })}\n`,
      );
      const result = await adapter.uninstallOwned(root);
      expect(result.diagnostics.map((item) => item.code)).toContain(
        "omp.invalid-ownership",
      );
      expect(await readFile(victim, "utf8")).toBe("safe\n");
    }
  });

  it("rejects symlinked managed components without touching outside files", async () => {
    const { root, adapter } = await fixture();
    const outside = await mkdtemp(resolve(tmpdir(), "loom-omp-outside-"));
    roots.push(outside);
    await write(resolve(outside, "victim"), "safe\n");
    await symlink(outside, resolve(root, ".omp"), "dir");
    await symlink(outside, resolve(root, ".loom"), "dir");

    const result = await adapter.apply(
      await adapter.planInstall(root, capabilityPlan),
    );
    expect(result.changed).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "omp.unsafe-path",
    );
    expect(await readFile(resolve(outside, "victim"), "utf8")).toBe("safe\n");
    await expect(
      readFile(resolve(outside, "skills/loom-project-start/SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlinked canonical skill sources", async () => {
    const { root, skills, adapter } = await fixture();
    const outside = await mkdtemp(
      resolve(tmpdir(), "loom-omp-source-outside-"),
    );
    roots.push(outside);
    await write(resolve(outside, "SKILL.md"), "outside\n");
    await symlink(outside, resolve(skills, "loom-linked"), "dir");

    const plan = await adapter.planInstall(root, capabilityPlan);
    expect(plan.mutations).toEqual([]);
    expect(plan.diagnostics.map((item) => item.code)).toContain(
      "omp.skills-source",
    );
    await expect(
      readFile(resolve(root, ".omp/skills/loom-linked/SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts only immutable plans issued by the same adapter instance", async () => {
    const { root, skills, adapter } = await fixture();
    const config = resolve(root, ".omp/mcp.json");
    const forged = await adapter.apply({
      harness: "omp",
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
      "omp.invalid-mutation",
    );
    await expect(readFile(config, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const issued = await adapter.planInstall(root, capabilityPlan);
    expect(Object.isFrozen(issued)).toBe(true);
    expect(Object.isFrozen(issued.mutations[0])).toBe(true);
    expect((await adapter.apply(structuredClone(issued))).changed).toEqual([]);
    expect(
      (
        await new OmpHarnessAdapter({ skillsSource: skills }).apply(issued)
      ).diagnostics.map((item) => item.code),
    ).toContain("omp.invalid-mutation");
    expect((await adapter.apply(issued)).changed.length).toBeGreaterThan(0);
  });

  it("enforces expected hashes against changes after planning", async () => {
    const { root, adapter } = await fixture();
    const config = resolve(root, ".omp/mcp.json");
    const original = '{"mcpServers":{"other":{"command":"safe"}}}\n';
    await write(config, original);
    const plan = await adapter.planInstall(root, capabilityPlan);
    await writeFile(config, '{"changed":true}\n');
    const result = await adapter.apply(plan);
    expect(result.changed).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "omp.concurrent-change",
    );
    expect(await readFile(config, "utf8")).toBe('{"changed":true}\n');
    expect(
      plan.mutations.find((item) => item.path === config)?.expectedHash,
    ).toBe(createHash("sha256").update(original).digest("hex"));
  });
});
