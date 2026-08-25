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
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityPlan } from "@loom/core";
import { BEGIN_MARKER, CodexHarnessAdapter } from "./index.js";

const roots: string[] = [];
const plan = {} as CapabilityPlan;

async function fixture(): Promise<{
  root: string;
  source: string;
  adapter: CodexHarnessAdapter;
}> {
  const root = await mkdtemp(resolve(tmpdir(), "loom-codex-root-"));
  const source = await mkdtemp(resolve(tmpdir(), "loom-codex-skills-"));
  roots.push(root, source);
  await mkdir(resolve(source, "loom-test"));
  await writeFile(
    resolve(source, "loom-test/SKILL.md"),
    "---\nname: loom-test\n---\n",
  );
  return {
    root,
    source,
    adapter: new CodexHarnessAdapter({ skillsSource: source }),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CodexHarnessAdapter", () => {
  it("preserves existing TOML and comments byte-for-byte outside its block", async () => {
    const { root, adapter } = await fixture();
    const original = '# keep this comment\r\nmodel = "gpt-5"\r\n';
    await mkdir(resolve(root, ".codex"));
    await writeFile(resolve(root, ".codex/config.toml"), original);

    await adapter.apply(await adapter.planInstall(root, plan));
    const installed = await readFile(
      resolve(root, ".codex/config.toml"),
      "utf8",
    );

    expect(installed.startsWith(original)).toBe(true);
    expect(installed).toContain(
      '[mcp_servers.loom]\ncommand = "loom"\nargs = ["mcp"]\nrequired = false\nstartup_timeout_sec = 10\ntool_timeout_sec = 60',
    );
    expect(await adapter.verify(root)).toEqual([]);
  });

  it("emits one sorted agent-browser environment table", async () => {
    const { root, adapter } = await fixture();
    await adapter.apply(
      await adapter.planInstall(root, plan, {
        mcp: {
          name: "agent-browser",
          command: "/tool/agent-browser",
          args: ["mcp"],
          env: { ZEBRA: "z", ALPHA: "a" },
        },
      }),
    );

    const config = await readFile(resolve(root, ".codex/config.toml"), "utf8");
    expect(config.match(/\[mcp_servers\.agent-browser\.env\]/g)).toHaveLength(
      1,
    );
    expect(config).toContain(
      '[mcp_servers.agent-browser.env]\nALPHA = "a"\nZEBRA = "z"\n',
    );
  });

  it("rejects an existing mcp_servers.loom table", async () => {
    const { root, adapter } = await fixture();
    await mkdir(resolve(root, ".codex"));
    const original = '[mcp_servers.loom]\ncommand = "other"\n';
    await writeFile(resolve(root, ".codex/config.toml"), original);

    const install = await adapter.planInstall(root, plan);
    const result = await adapter.apply(install);

    expect(install.diagnostics.map((item) => item.code)).toContain(
      "codex.mcp-collision",
    );
    expect(result.changed).toEqual([]);
    expect(await readFile(resolve(root, ".codex/config.toml"), "utf8")).toBe(
      original,
    );
  });

  it("is dry-run safe and idempotent", async () => {
    const { root, adapter } = await fixture();
    const first = await adapter.planInstall(root, plan);
    const dryRun = await adapter.apply(first, true);
    expect(dryRun.changed.length).toBeGreaterThan(0);
    await expect(
      readFile(resolve(root, ".codex/config.toml"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await adapter.apply(await adapter.planInstall(root, plan));
    const repeated = await adapter.planInstall(root, plan);
    expect(repeated.mutations).toEqual([]);
    expect(
      (await readFile(resolve(root, ".codex/config.toml"), "utf8")).match(
        new RegExp(BEGIN_MARKER, "g"),
      ),
    ).toHaveLength(1);
  });

  it("rolls back a partially failed apply and permits a clean retry", async () => {
    const { root, source } = await fixture();
    const unrelated = resolve(root, "notes.txt");
    await writeFile(unrelated, "untouched\n");
    let writes = 0;
    const failing = new CodexHarnessAdapter({
      skillsSource: source,
      fileOperations: {
        async write(path, content) {
          writes += 1;
          if (writes === 2) throw new Error("injected write failure");
          await mkdir(resolve(path, ".."), { recursive: true });
          await writeFile(path, content);
        },
        async remove(path) {
          await rm(path);
        },
      },
    });
    const result = await failing.apply(await failing.planInstall(root, plan));

    expect(result.changed).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "codex.apply-failed",
        message: expect.stringContaining(
          "all earlier mutations were rolled back",
        ),
      }),
    );
    await expect(
      readFile(resolve(root, ".agents/skills/loom-test/SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(resolve(root, ".loom/ownership.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(unrelated, "utf8")).toBe("untouched\n");

    const retry = new CodexHarnessAdapter({ skillsSource: source });
    expect(
      (await retry.apply(await retry.planInstall(root, plan))).diagnostics,
    ).toEqual([]);
    expect(await retry.verify(root)).toEqual([]);
  });

  it("hash-safely removes obsolete owned skills while preserving shared and modified files", async () => {
    const { root, source, adapter } = await fixture();
    for (const name of ["loom-obsolete", "loom-shared", "loom-modified"]) {
      await mkdir(resolve(source, name));
      await writeFile(resolve(source, name, "SKILL.md"), `${name}\n`);
    }
    await adapter.apply(await adapter.planInstall(root, plan));
    const ownershipPath = resolve(root, ".loom/ownership.json");
    const ownership = JSON.parse(await readFile(ownershipPath, "utf8")) as {
      harnesses: Record<
        string,
        { files: Array<{ path: string; sha256: string }> }
      >;
    };
    const sharedPath = ".agents/skills/loom-shared/SKILL.md";
    const shared = ownership.harnesses.codex!.files.find(
      (file) => file.path === sharedPath,
    )!;
    ownership.harnesses.other = { files: [shared] };
    await writeFile(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);
    await rm(resolve(source, "loom-obsolete"), { recursive: true });
    await rm(resolve(source, "loom-shared"), { recursive: true });

    const removal = await adapter.apply(await adapter.planInstall(root, plan));
    expect(removal.diagnostics).toEqual([]);
    await expect(
      readFile(resolve(root, ".agents/skills/loom-obsolete/SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(
        resolve(root, ".agents/skills/loom-shared/SKILL.md"),
        "utf8",
      ),
    ).toBe("loom-shared\n");

    await rm(resolve(source, "loom-modified"), { recursive: true });
    const modified = resolve(root, ".agents/skills/loom-modified/SKILL.md");
    await writeFile(modified, "user change\n");
    const guarded = await adapter.planInstall(root, plan);
    expect(guarded.diagnostics.map((item) => item.code)).toContain(
      "codex.owned-file-modified",
    );
    expect((await adapter.apply(guarded)).changed).toEqual([]);
    expect(await readFile(modified, "utf8")).toBe("user change\n");
  });

  it("refuses to overwrite or remove a modified owned skill", async () => {
    const { root, adapter } = await fixture();
    await adapter.apply(await adapter.planInstall(root, plan));
    const skill = resolve(root, ".agents/skills/loom-test/SKILL.md");
    await writeFile(skill, "modified\n");

    const reinstall = await adapter.planInstall(root, plan);
    expect(reinstall.diagnostics.map((item) => item.code)).toContain(
      "codex.owned-file-modified",
    );
    expect((await adapter.apply(reinstall)).changed).toEqual([]);
    const removed = await adapter.uninstallOwned(root);
    expect(removed.skipped).toContain(skill);
    expect(await readFile(skill, "utf8")).toBe("modified\n");
  });

  it("refuses to overwrite or remove a modified owned MCP block", async () => {
    const { root, adapter } = await fixture();
    await adapter.apply(await adapter.planInstall(root, plan));
    const configPath = resolve(root, ".codex/config.toml");
    const modified = (await readFile(configPath, "utf8")).replace(
      "required = false",
      "required = true",
    );
    await writeFile(configPath, modified);

    const reinstall = await adapter.planInstall(root, plan);
    expect(reinstall.diagnostics.map((item) => item.code)).toContain(
      "codex.config-modified",
    );
    expect((await adapter.apply(reinstall)).changed).toEqual([]);
    expect((await adapter.uninstallOwned(root)).skipped).toContain(configPath);
    expect(await readFile(configPath, "utf8")).toBe(modified);
  });

  it("safely removes only owned files and restores existing TOML", async () => {
    const { root, adapter } = await fixture();
    const config = '# user config\nmodel = "gpt-5"\n';
    await mkdir(resolve(root, ".codex"));
    await writeFile(resolve(root, ".codex/config.toml"), config);
    await mkdir(resolve(root, ".agents/skills/user-skill"), {
      recursive: true,
    });
    await writeFile(
      resolve(root, ".agents/skills/user-skill/SKILL.md"),
      "user\n",
    );
    await adapter.apply(await adapter.planInstall(root, plan));

    await adapter.uninstallOwned(root);

    expect(await readFile(resolve(root, ".codex/config.toml"), "utf8")).toBe(
      config,
    );
    expect(
      await readFile(
        resolve(root, ".agents/skills/user-skill/SKILL.md"),
        "utf8",
      ),
    ).toBe("user\n");
    await expect(
      readFile(resolve(root, ".agents/skills/loom-test/SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(resolve(root, ".loom/ownership.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects traversal and absolute ownership paths", async () => {
    const { source } = await fixture();
    const container = await mkdtemp(resolve(tmpdir(), "loom-codex-forged-"));
    roots.push(container);
    const root = resolve(container, "project/nested");
    await mkdir(root, { recursive: true });
    const adapter = new CodexHarnessAdapter({ skillsSource: source });
    for (const [ownedPath, victim] of [
      ["../../victim", resolve(container, "victim")],
      [
        resolve(container, "absolute-victim"),
        resolve(container, "absolute-victim"),
      ],
    ] as const) {
      await writeFile(victim, "safe\n");
      await mkdir(resolve(root, ".loom"), { recursive: true });
      await writeFile(
        resolve(root, ".loom/ownership.json"),
        `${JSON.stringify({
          version: 1,
          harnesses: {
            codex: {
              files: [{ path: ownedPath, sha256: "forged" }],
              config: {
                path: ".codex/config.toml",
                blockSha256: "forged",
                prefix: "",
                created: true,
              },
            },
          },
        })}\n`,
      );

      expect(
        (await adapter.uninstallOwned(root)).diagnostics.map(
          (item) => item.code,
        ),
      ).toContain("codex.ownership-invalid");
      expect(await readFile(victim, "utf8")).toBe("safe\n");
    }
  });

  it("rejects symlinked managed parents without touching outside files", async () => {
    const { root, adapter } = await fixture();
    const outside = await mkdtemp(resolve(tmpdir(), "loom-codex-outside-"));
    roots.push(outside);
    await writeFile(resolve(outside, "victim"), "safe\n");
    await symlink(outside, resolve(root, ".agents"), "dir");
    await symlink(outside, resolve(root, ".loom"), "dir");
    await symlink(outside, resolve(root, ".codex"), "dir");

    const result = await adapter.apply(await adapter.planInstall(root, plan));

    expect(result.changed).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "codex.unsafe-path",
    );
    expect(await readFile(resolve(outside, "victim"), "utf8")).toBe("safe\n");
    await expect(
      readFile(resolve(outside, "skills/loom-test/SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects forged delete mutations without an expected hash", async () => {
    const { root, adapter } = await fixture();
    const victim = resolve(root, ".codex/config.toml");
    await mkdir(resolve(root, ".codex"));
    await writeFile(victim, "safe\n");
    const result = await adapter.apply({
      harness: "codex",
      root,
      diagnostics: [],
      mutations: [{ kind: "delete-file", path: victim, description: "forged" }],
    });

    expect(result.changed).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "codex.invalid-mutation",
    );
    expect(await readFile(victim, "utf8")).toBe("safe\n");
  });

  it("applies only exact plans issued by the same adapter", async () => {
    const { root, source, adapter } = await fixture();
    const config = resolve(root, ".codex/config.toml");
    const forgedCreate = await adapter.apply({
      harness: "codex",
      root,
      diagnostics: [],
      mutations: [
        {
          kind: "create-file",
          path: config,
          description: "forged",
          content: "forged = true\n",
        },
      ],
    });
    expect(forgedCreate.diagnostics.map((item) => item.code)).toContain(
      "codex.invalid-mutation",
    );
    await expect(readFile(config, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const original = 'model = "safe"\n';
    await mkdir(resolve(root, ".codex"));
    await writeFile(config, original);
    const forgedUpdate = await adapter.apply({
      harness: "codex",
      root,
      diagnostics: [],
      mutations: [
        {
          kind: "update-file",
          path: config,
          description: "forged",
          content: "forged = true\n",
          expectedHash: createHash("sha256").update(original).digest("hex"),
        },
      ],
    });
    expect(forgedUpdate.changed).toEqual([]);
    expect(await readFile(config, "utf8")).toBe(original);

    const issued = await adapter.planInstall(root, plan);
    const cloned = await adapter.apply(structuredClone(issued));
    expect(cloned.changed).toEqual([]);
    expect(cloned.diagnostics.map((item) => item.code)).toContain(
      "codex.invalid-mutation",
    );
    const other = new CodexHarnessAdapter({ skillsSource: source });
    const foreign = await other.apply(issued);
    expect(foreign.changed).toEqual([]);
    expect(foreign.diagnostics.map((item) => item.code)).toContain(
      "codex.invalid-mutation",
    );
    expect((await adapter.apply(issued, true)).changed.length).toBeGreaterThan(
      0,
    );
    expect((await adapter.apply(issued)).changed.length).toBeGreaterThan(0);
    expect(await adapter.verify(root)).toEqual([]);
  });
});
