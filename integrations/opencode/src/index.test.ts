import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CapabilityPlan } from "@loom/core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "jsonc-parser";
import { OpenCodeHarnessAdapter } from "./index.js";

const roots: string[] = [];
const capabilityPlan = {} as CapabilityPlan;

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function fixture(): Promise<{
  root: string;
  skills: string;
  adapter: OpenCodeHarnessAdapter;
}> {
  const root = await mkdtemp(join(tmpdir(), "loom-opencode-project-"));
  const skills = await mkdtemp(join(tmpdir(), "loom-opencode-skills-"));
  roots.push(root, skills);
  await write(
    join(skills, "loom-project-start", "SKILL.md"),
    "---\nname: loom-project-start\ndescription: Start a project.\n---\n\n# Start\n",
  );
  await write(
    join(skills, "loom-verification-loop", "SKILL.md"),
    "---\nname: loom-verification-loop\ndescription: Verify a project.\n---\n\n# Verify\n",
  );
  return {
    root,
    skills,
    adapter: new OpenCodeHarnessAdapter({ skillsSource: skills }),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("OpenCodeHarnessAdapter", () => {
  it("preserves JSONC comments and existing config values", async () => {
    const { root, adapter } = await fixture();
    await write(
      join(root, "opencode.jsonc"),
      `{
  // keep this comment
  "model": "provider/model",
  "mcp": {
    "other": { "type": "remote", "url": "https://example.test" },
  },
}
`,
    );

    const plan = await adapter.planInstall(root, capabilityPlan);
    const result = await adapter.apply(plan);
    const config = await readFile(join(root, "opencode.jsonc"), "utf8");
    const value = parse(config) as Record<string, unknown>;

    expect(result.diagnostics).toEqual([]);
    expect(config).toContain("// keep this comment");
    expect(config).toContain('"model": "provider/model"');
    expect(value).toMatchObject({
      mcp: {
        other: { type: "remote", url: "https://example.test" },
        loom: { type: "local", command: ["loom", "mcp"], enabled: true },
      },
    });
    expect(
      await readFile(join(root, ".opencode/plugins/loom.ts"), "utf8"),
    ).toContain("export const LoomPlugin = (async () => ({\n  config:");
  });

  it("supports dry-run and is idempotent across repeated apply and planning", async () => {
    const { root, adapter } = await fixture();
    const plan = await adapter.planInstall(root, capabilityPlan);
    const dryRun = await adapter.apply(plan, true);

    expect(dryRun.changed.length).toBeGreaterThan(0);
    await expect(
      readFile(join(root, "opencode.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const first = await adapter.apply(plan);
    const second = await adapter.apply(plan);
    const nextPlan = await adapter.planInstall(root, capabilityPlan);

    expect(first.changed.length).toBeGreaterThan(0);
    expect(second.changed).toEqual([]);
    expect(second.diagnostics).toEqual([]);
    expect(nextPlan.mutations).toEqual([]);
    expect(await adapter.verify(root)).toEqual([]);
  });

  it("rolls back a partially failed apply and permits a clean retry", async () => {
    const { root, skills } = await fixture();
    const unrelated = join(root, "notes.txt");
    await write(unrelated, "untouched\n");
    let writes = 0;
    const failing = new OpenCodeHarnessAdapter({
      skillsSource: skills,
      fileOperations: {
        async write(path, content) {
          writes += 1;
          if (writes === 2) throw new Error("injected write failure");
          await write(path, content);
        },
        async remove(path) {
          await rm(path);
        },
      },
    });
    const result = await failing.apply(
      await failing.planInstall(root, capabilityPlan),
    );

    expect(result.changed).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "opencode.apply-failed",
        message: expect.stringContaining(
          "all earlier mutations were rolled back",
        ),
      }),
    );
    await expect(
      readFile(join(root, ".opencode/plugins/loom.ts"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(root, ".loom/ownership.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(unrelated, "utf8")).toBe("untouched\n");

    const retry = new OpenCodeHarnessAdapter({ skillsSource: skills });
    expect(
      (await retry.apply(await retry.planInstall(root, capabilityPlan)))
        .diagnostics,
    ).toEqual([]);
    expect(await retry.verify(root)).toEqual([]);
  });

  it("detects unowned file and MCP collisions", async () => {
    const { root, adapter } = await fixture();
    await write(
      join(root, ".opencode/plugins/loom.ts"),
      "export const Existing = true;\n",
    );
    await write(
      join(root, "opencode.json"),
      '{"mcp":{"loom":{"type":"local","command":["other"],"enabled":true}}}\n',
    );

    const plan = await adapter.planInstall(root, capabilityPlan);

    expect(plan.mutations).toEqual([]);
    expect(plan.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "opencode.file-collision",
        "opencode.mcp-collision",
      ]),
    );
  });

  it("refuses to overwrite or uninstall a changed owned file", async () => {
    const { root, adapter } = await fixture();
    await adapter.apply(await adapter.planInstall(root, capabilityPlan));
    const plugin = join(root, ".opencode/plugins/loom.ts");
    await writeFile(plugin, "export const UserChange = true;\n", "utf8");

    const plan = await adapter.planInstall(root, capabilityPlan);
    const uninstall = await adapter.uninstallOwned(root);

    expect(plan.mutations).toEqual([]);
    expect(plan.diagnostics.map((item) => item.code)).toContain(
      "opencode.modified-owned-file",
    );
    expect(uninstall.diagnostics.map((item) => item.code)).toContain(
      "opencode.modified-owned-file",
    );
    expect(await readFile(plugin, "utf8")).toBe(
      "export const UserChange = true;\n",
    );
    expect(
      await readFile(join(root, ".loom/ownership.json"), "utf8"),
    ).toContain(".opencode/plugins/loom.ts");
  });

  it("uninstalls only owned resources and preserves unrelated JSONC content", async () => {
    const { root, adapter } = await fixture();
    await write(
      join(root, "opencode.jsonc"),
      `{
  // retained
  "mcp": {
    "other": { "type": "local", "command": ["other"] }
  },
  "permission": { "edit": "ask" }
}
`,
    );
    await write(
      join(root, ".agents/skills/user-skill/SKILL.md"),
      "user content\n",
    );
    await adapter.apply(await adapter.planInstall(root, capabilityPlan));

    const result = await adapter.uninstallOwned(root);
    const config = await readFile(join(root, "opencode.jsonc"), "utf8");
    const value = parse(config) as {
      mcp: Record<string, unknown>;
      permission: unknown;
    };

    expect(result.diagnostics).toEqual([]);
    expect(config).toContain("// retained");
    expect(value.mcp.other).toEqual({ type: "local", command: ["other"] });
    expect(value.mcp.loom).toBeUndefined();
    expect(value.permission).toEqual({ edit: "ask" });
    expect(
      await readFile(join(root, ".agents/skills/user-skill/SKILL.md"), "utf8"),
    ).toBe("user content\n");
    await expect(
      readFile(join(root, ".loom/ownership.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses injected command arrays", async () => {
    const { root, skills } = await fixture();
    const adapter = new OpenCodeHarnessAdapter({
      command: ["node", "loom.mjs", "mcp"],
      skillsSource: skills,
    });
    await adapter.apply(await adapter.planInstall(root, capabilityPlan));
    const config = parse(
      await readFile(join(root, "opencode.json"), "utf8"),
    ) as {
      mcp: { loom: { command: string[] } };
    };

    expect(config.mcp.loom.command).toEqual(["node", "loom.mjs", "mcp"]);
  });

  it("rejects traversal and absolute ownership paths", async () => {
    const { skills } = await fixture();
    const container = await mkdtemp(join(tmpdir(), "loom-opencode-forged-"));
    roots.push(container);
    const root = join(container, "project/nested");
    await mkdir(root, { recursive: true });
    const adapter = new OpenCodeHarnessAdapter({ skillsSource: skills });
    for (const [ownedPath, victim] of [
      ["../../victim", join(container, "victim")],
      [join(container, "absolute-victim"), join(container, "absolute-victim")],
    ] as const) {
      await write(victim, "safe\n");
      await write(
        join(root, ".loom/ownership.json"),
        `${JSON.stringify({
          version: 1,
          harnesses: {
            opencode: { files: { [ownedPath]: "forged" }, pointers: {} },
          },
        })}\n`,
      );

      expect(
        (await adapter.uninstallOwned(root)).diagnostics.map(
          (item) => item.code,
        ),
      ).toContain("opencode.invalid-ownership");
      expect(await readFile(victim, "utf8")).toBe("safe\n");
    }
  });

  it("rejects symlinked managed parents without touching outside files", async () => {
    const { root, adapter } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "loom-opencode-outside-"));
    roots.push(outside);
    await write(join(outside, "victim"), "safe\n");
    await symlink(outside, join(root, ".agents"), "dir");
    await symlink(outside, join(root, ".loom"), "dir");
    await symlink(outside, join(root, ".opencode"), "dir");

    const result = await adapter.apply(
      await adapter.planInstall(root, capabilityPlan),
    );

    expect(result.changed).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "opencode.unsafe-path",
    );
    expect(await readFile(join(outside, "victim"), "utf8")).toBe("safe\n");
    await expect(
      readFile(join(outside, "skills/loom-project-start/SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects forged delete mutations without an expected hash", async () => {
    const { root, adapter } = await fixture();
    const victim = join(root, ".opencode/plugins/loom.ts");
    await write(victim, "safe\n");
    const result = await adapter.apply({
      harness: "opencode",
      root,
      diagnostics: [],
      mutations: [{ kind: "delete-file", path: victim, description: "forged" }],
    });

    expect(result.changed).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "opencode.invalid-mutation",
    );
    expect(await readFile(victim, "utf8")).toBe("safe\n");
  });

  it("applies only exact plans issued by the same adapter", async () => {
    const { root, skills, adapter } = await fixture();
    const config = join(root, "opencode.json");
    const forgedCreate = await adapter.apply({
      harness: "opencode",
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
    expect(forgedCreate.diagnostics.map((item) => item.code)).toContain(
      "opencode.invalid-mutation",
    );
    await expect(readFile(config, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const original = '{"model":"safe"}\n';
    await write(config, original);
    const forgedUpdate = await adapter.apply({
      harness: "opencode",
      root,
      diagnostics: [],
      mutations: [
        {
          kind: "update-file",
          path: config,
          description: "forged",
          content: '{"forged":true}\n',
          expectedHash: createHash("sha256").update(original).digest("hex"),
        },
      ],
    });
    expect(forgedUpdate.changed).toEqual([]);
    expect(await readFile(config, "utf8")).toBe(original);

    const issued = await adapter.planInstall(root, capabilityPlan);
    const cloned = await adapter.apply(structuredClone(issued));
    expect(cloned.changed).toEqual([]);
    expect(cloned.diagnostics.map((item) => item.code)).toContain(
      "opencode.invalid-mutation",
    );
    const other = new OpenCodeHarnessAdapter({ skillsSource: skills });
    const foreign = await other.apply(issued);
    expect(foreign.changed).toEqual([]);
    expect(foreign.diagnostics.map((item) => item.code)).toContain(
      "opencode.invalid-mutation",
    );
    expect((await adapter.apply(issued, true)).changed.length).toBeGreaterThan(
      0,
    );
    expect((await adapter.apply(issued)).changed.length).toBeGreaterThan(0);
    expect(await adapter.verify(root)).toEqual([]);
  });
});
