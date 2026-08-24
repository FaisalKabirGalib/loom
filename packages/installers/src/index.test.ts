import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";
import {
  CapabilityInstaller,
  FLUTTER_AGENT_PLUGINS_RECIPE,
  FLUTTER_AGENT_PLUGINS_RECIPE_DIGEST,
  type ProcessRequest,
  type ProcessRunner,
} from "./index.js";

const roots: string[] = [];

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function fixture(): Promise<{
  root: string;
  source: string;
  temporary: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "loom-installer-project-"));
  const source = await mkdtemp(join(tmpdir(), "loom-installer-source-"));
  const temporary = await mkdtemp(join(tmpdir(), "loom-installer-temp-"));
  roots.push(root, source, temporary);
  for (const name of FLUTTER_AGENT_PLUGINS_RECIPE.skills) {
    await write(
      join(source, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Official fixture.\n---\n\n# ${name}\n`,
    );
  }
  return { root, source, temporary };
}

function runner(
  source: string,
  requests: ProcessRequest[] = [],
  head: string = FLUTTER_AGENT_PLUGINS_RECIPE.commit,
): ProcessRunner {
  return async (request) => {
    requests.push(request);
    if (request.args[0] === "checkout") {
      await cp(join(source, "skills"), join(request.cwd, "skills"), {
        recursive: true,
      });
    }
    return {
      exitCode: 0,
      stdout: request.args[0] === "rev-parse" ? `${head}\n` : "",
      stderr: "",
    };
  };
}

function installer(
  source: string,
  temporary: string,
  options: {
    requests?: ProcessRequest[];
    runner?: ProcessRunner;
    fileOperations?: ConstructorParameters<
      typeof CapabilityInstaller
    >[0]["fileOperations"];
  } = {},
): CapabilityInstaller {
  return new CapabilityInstaller({
    dartPath: "/opt/flutter/bin/dart",
    gitPath: "/usr/bin/git",
    processRunner: options.runner ?? runner(source, options.requests ?? []),
    temporaryDirectory: temporary,
    ...(options.fileOperations === undefined
      ? {}
      : { fileOperations: options.fileOperations }),
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CapabilityInstaller", () => {
  it("exports the pinned recipe and stages it with exact safe git argv", async () => {
    const { root, source, temporary } = await fixture();
    const requests: ProcessRequest[] = [];
    const value = installer(source, temporary, { requests });

    const plan = await value.plan(root);

    expect(plan.diagnostics).toEqual([]);
    expect(FLUTTER_AGENT_PLUGINS_RECIPE_DIGEST).toMatch(/^[a-f0-9]{64}$/u);
    expect(requests.map(({ args }) => args)).toEqual([
      ["init"],
      ["remote", "add", "origin", "https://github.com/flutter/agent-plugins"],
      [
        "fetch",
        "--depth=1",
        "origin",
        "1e5696a2e986345f7ecc92842b5e9293bc079d6f",
      ],
      ["checkout", "--detach", "FETCH_HEAD"],
      ["rev-parse", "HEAD"],
    ]);
    expect(requests.every((request) => request.shell === false)).toBe(true);
    expect(
      requests.every((request) => request.command === "/usr/bin/git"),
    ).toBe(true);
    expect(
      requests.every((request) => request.env.HOME?.startsWith(temporary)),
    ).toBe(true);
    await expect(lstat(requests[0]!.cwd)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("installs 22 skills, preserves JSONC, supports dry-run, and is idempotent", async () => {
    const { root, source, temporary } = await fixture();
    await write(
      join(root, "opencode.jsonc"),
      `{
  // retained
  "model": "provider/model",
  "mcp": { "other": { "type": "remote", "url": "https://example.test" } },
}
`,
    );
    const value = installer(source, temporary);
    const plan = await value.plan(root);

    expect((await value.apply(plan, true)).changed).toHaveLength(24);
    await expect(
      readFile(
        join(root, ".agents/skills/dart-add-unit-test/SKILL.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const result = await value.apply(plan);
    const configText = await readFile(join(root, "opencode.jsonc"), "utf8");
    const config = parse(configText) as {
      mcp: Record<string, unknown>;
      model: string;
    };
    const ownership = JSON.parse(
      await readFile(join(root, ".loom/setup-ownership.json"), "utf8"),
    ) as {
      capabilities: Record<
        string,
        { recipeDigest: string; files: Record<string, string> }
      >;
    };

    expect(result.diagnostics).toEqual([]);
    expect(configText).toContain("// retained");
    expect(config.model).toBe("provider/model");
    expect(config.mcp["dart-mcp-server"]).toEqual({
      type: "local",
      command: ["/opt/flutter/bin/dart", "mcp-server"],
      enabled: true,
    });
    expect(
      Object.keys(
        ownership.capabilities[FLUTTER_AGENT_PLUGINS_RECIPE.candidate]!.files,
      ),
    ).toHaveLength(22);
    expect(
      ownership.capabilities[FLUTTER_AGENT_PLUGINS_RECIPE.candidate]!
        .recipeDigest,
    ).toBe(FLUTTER_AGENT_PLUGINS_RECIPE_DIGEST);
    expect((await value.apply(plan)).changed).toEqual([]);
    expect((await value.plan(root)).mutations).toEqual([]);
    expect(await value.verify(root)).toEqual([]);
  });

  it("rejects unowned files and MCP collisions", async () => {
    const { root, source, temporary } = await fixture();
    await write(
      join(root, ".agents/skills/dart-add-unit-test/SKILL.md"),
      "unowned\n",
    );
    await write(
      join(root, "opencode.json"),
      '{"mcp":{"dart-mcp-server":{"type":"local","command":["other"]}}}\n',
    );

    const plan = await installer(source, temporary).plan(root);

    expect(plan.mutations).toEqual([]);
    expect(plan.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "installers.file-collision",
        "installers.mcp-collision",
      ]),
    );
  });

  it("rejects wrong commits and unsupported staged assets", async () => {
    const wrongHead = await fixture();
    const wrongHeadPlan = await installer(
      wrongHead.source,
      wrongHead.temporary,
      {
        runner: runner(
          wrongHead.source,
          [],
          "0000000000000000000000000000000000000000",
        ),
      },
    ).plan(wrongHead.root);
    expect(wrongHeadPlan.diagnostics.map((item) => item.code)).toContain(
      "installers.stage-failed",
    );

    const nested = await fixture();
    await write(
      join(nested.source, "skills/dart-add-unit-test/reference.md"),
      "extra\n",
    );
    const nestedPlan = await installer(nested.source, nested.temporary).plan(
      nested.root,
    );
    expect(nestedPlan.diagnostics[0]?.message).toContain("unsupported assets");

    const linked = await fixture();
    const target = join(linked.source, "target.md");
    await write(target, "target\n");
    await rm(join(linked.source, "skills/dart-add-unit-test/SKILL.md"));
    await symlink(
      target,
      join(linked.source, "skills/dart-add-unit-test/SKILL.md"),
    );
    const linkedPlan = await installer(linked.source, linked.temporary).plan(
      linked.root,
    );
    expect(linkedPlan.diagnostics.map((item) => item.code)).toContain(
      "installers.stage-failed",
    );
  });

  it("binds plans to the issuing instance and rejects cloned or forged plans", async () => {
    const { root, source, temporary } = await fixture();
    const value = installer(source, temporary);
    const issued = await value.plan(root);

    expect(
      (await value.apply(structuredClone(issued))).diagnostics[0]?.code,
    ).toBe("installers.invalid-plan");
    expect(
      (await installer(source, temporary).apply(issued)).diagnostics[0]?.code,
    ).toBe("installers.invalid-plan");
    expect(
      (
        await value.apply({
          candidate: FLUTTER_AGENT_PLUGINS_RECIPE.candidate,
          root,
          recipeDigest: FLUTTER_AGENT_PLUGINS_RECIPE_DIGEST,
          diagnostics: [],
          mutations: [
            {
              kind: "delete-file",
              path: join(root, "victim"),
              expectedHash: createHash("sha256").update("safe").digest("hex"),
            },
          ],
        })
      ).diagnostics[0]?.code,
    ).toBe("installers.invalid-plan");
  });

  it("rolls back partial apply failures", async () => {
    const { root, source, temporary } = await fixture();
    let writes = 0;
    const value = installer(source, temporary, {
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

    const result = await value.apply(await value.plan(root));

    expect(result.changed).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "installers.apply-failed",
    );
    await expect(
      readFile(
        join(root, ".agents/skills/dart-add-unit-test/SKILL.md"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(root, ".loom/setup-ownership.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses modified resources and cleanly uninstalls owned resources", async () => {
    const modified = await fixture();
    const modifiedInstaller = installer(modified.source, modified.temporary);
    await modifiedInstaller.apply(await modifiedInstaller.plan(modified.root));
    const changedSkill = join(
      modified.root,
      ".agents/skills/dart-add-unit-test/SKILL.md",
    );
    await writeFile(changedSkill, "user change\n", "utf8");

    const refused = await modifiedInstaller.uninstall(modified.root);
    expect(refused.changed).toEqual([]);
    expect(refused.diagnostics.map((item) => item.code)).toContain(
      "installers.modified-owned-file",
    );
    expect(await readFile(changedSkill, "utf8")).toBe("user change\n");

    const clean = await fixture();
    await write(
      join(clean.root, "opencode.jsonc"),
      '{\n  // keep\n  "permission": { "edit": "ask" }\n}\n',
    );
    const cleanInstaller = installer(clean.source, clean.temporary);
    await cleanInstaller.apply(await cleanInstaller.plan(clean.root));
    expect(
      (await cleanInstaller.uninstall(clean.root, true)).changed,
    ).toHaveLength(24);
    const removed = await cleanInstaller.uninstall(clean.root);
    const configText = await readFile(
      join(clean.root, "opencode.jsonc"),
      "utf8",
    );
    expect(removed.diagnostics).toEqual([]);
    expect(configText).toContain("// keep");
    expect(parse(configText)).toEqual({ permission: { edit: "ask" }, mcp: {} });
    await expect(
      readFile(join(clean.root, ".loom/setup-ownership.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlinked managed paths without touching outside files", async () => {
    const { root, source, temporary } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "loom-installer-outside-"));
    roots.push(outside);
    await write(join(outside, "victim"), "safe\n");
    await symlink(outside, join(root, ".agents"), "dir");

    const plan = await installer(source, temporary).plan(root);

    expect(plan.mutations).toEqual([]);
    expect(plan.diagnostics.map((item) => item.code)).toContain(
      "installers.unsafe-path",
    );
    expect(await readFile(join(outside, "victim"), "utf8")).toBe("safe\n");
  });
});
