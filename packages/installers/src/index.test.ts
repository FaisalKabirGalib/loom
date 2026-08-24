import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  readdir,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  CapabilityInstaller,
  FLUTTER_AGENT_PLUGINS_RECIPE,
  FLUTTER_PACKAGE_INTELLIGENCE_RECIPE,
  type ProcessRequest,
} from "./index.js";

const roots: string[] = [];
const packageArchive = Buffer.from("fixture package archive");
const packageArchiveHash = `sha256:${createHash("sha256").update(packageArchive).digest("hex")}`;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  const visit = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const state = await lstat(path);
      if (entry.isDirectory()) {
        values[`${relative}/`] = `dir:${state.mode & 0o777}`;
        await visit(path, relative);
      } else
        values[relative] = `file:${state.mode & 0o777}:${(
          await readFile(path)
        ).toString("base64")}`;
    }
  };
  await visit(root);
  return values;
}

async function writeToolPackageConfig(root: string): Promise<void> {
  const dartPubdevRoot = join(
    root,
    ".pub-cache/hosted/pub.dev/dart_pubdev_mcp-0.9.0",
  );
  const skillsRoot = join(root, ".pub-cache/hosted/pub.dev/skills-1.0.0");
  await write(
    join(dartPubdevRoot, "pubspec.yaml"),
    "name: dart_pubdev_mcp\nversion: 0.9.0\n",
  );
  await write(
    join(skillsRoot, "pubspec.yaml"),
    "name: skills\nversion: 1.0.0\n",
  );
  await write(
    join(root, ".dart_tool/package_config.json"),
    `${JSON.stringify({
      configVersion: 2,
      packages: [
        {
          name: "dart_pubdev_mcp",
          rootUri: pathToFileURL(dartPubdevRoot).href,
        },
        { name: "skills", rootUri: pathToFileURL(skillsRoot).href },
      ],
    })}\n`,
  );
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "loom-package-intelligence-"));
  roots.push(root);
  const requests: ProcessRequest[] = [];
  const preseedChecks: boolean[] = [];
  const processRunner = async (request: ProcessRequest) => {
    requests.push(request);
    if (request.args[0] === "--version")
      return {
        exitCode: 0,
        stdout: "Dart SDK version: 3.11.4 (stable)",
        stderr: "",
      };
    if (request.args[0] === "pub" && request.args[1] === "unpack") {
      const [packageName, version] = request.args[2]!.split(":");
      const output = request.args[request.args.indexOf("--output") + 1]!;
      await cp(
        join(root, "cache", `${packageName}-${version}`),
        join(output, `${packageName}-${version}`),
        { recursive: true },
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (request.args.slice(0, 3).join(" ") === "pub cache add") {
      const packageName = request.args[3]!;
      const version = request.args[request.args.indexOf("--version") + 1]!;
      const cache = request.env.PUB_CACHE!;
      await cp(
        join(root, "cache", `${packageName}-${version}`),
        join(cache, "hosted/pub.dev", `${packageName}-${version}`),
        { recursive: true },
      );
      const lock = await readFile(join(root, "pubspec.lock"), "utf8");
      const archiveHash = /sha256:\s*([a-f0-9]{64})/u.exec(lock)?.[1];
      if (archiveHash === undefined)
        return { exitCode: 1, stdout: "", stderr: "missing archive hash" };
      await write(
        join(
          cache,
          "hosted-hashes/pub.dev",
          `${packageName}-${version}.sha256`,
        ),
        `${archiveHash}\n`,
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (request.args.join(" ") === "pub get --enforce-lockfile") {
      preseedChecks.push(
        await readFile(join(request.cwd, ".pub-cache/preseed.dart"))
          .then(() => true)
          .catch(() => false),
      );
      await writeToolPackageConfig(request.cwd);
    }
    if (request.args[0] === "compile") {
      const output = request.args[request.args.indexOf("-o") + 1]!;
      await write(output, "owned-compiled-runtime\n");
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const installer = new CapabilityInstaller({
    dartPath: "/opt/flutter/bin/dart",
    gitPath: "/usr/bin/git",
    processRunner,
    fetch: async () => new Response(packageArchive),
  });
  return { root, installer, requests, preseedChecks, processRunner };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CapabilityInstaller", () => {
  it("refuses uninstall while an apply owns the transaction lock", async () => {
    const { root, installer } = await fixture();
    const plan = await installer.plan(root);
    const applied = await installer.apply(plan);

    expect(applied.rollbackToken).toBeDefined();
    const uninstall = await installer.uninstall(root);
    expect(uninstall.diagnostics).toContainEqual(
      expect.objectContaining({ code: "installers.transaction-locked" }),
    );
    expect(
      await readFile(join(root, ".loom/setup-ownership.json"), "utf8"),
    ).toContain("builtin:flutter-package-intelligence");

    await installer.rollback(applied.rollbackToken!);
  });

  it("plans the exact local package, two MCP pointers, and isolated pub get", async () => {
    const { root, installer, requests } = await fixture();
    const plan = await installer.plan(root);

    expect(plan.diagnostics).toEqual([]);
    expect(plan.candidate).toBe("builtin:flutter-package-intelligence");
    expect(plan.mutations.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        join(root, ".loom/tools/flutter-package-intelligence/pubspec.yaml"),
        join(root, ".loom/tools/flutter-package-intelligence/pubspec.lock"),
        join(root, "opencode.jsonc"),
        join(root, ".loom/setup-ownership.json"),
      ]),
    );
    expect(plan.process).toMatchObject({
      command: "/opt/flutter/bin/dart",
      args: ["pub", "get", "--enforce-lockfile"],
      shell: false,
    });
    expect(plan.compileProcess).toMatchObject({
      command: "/opt/flutter/bin/dart",
      args: expect.arrayContaining(["compile", "exe", "-o"]),
      shell: false,
    });
    expect(plan.process.env.PUB_CACHE).toBe(
      join(root, ".loom/tools/flutter-package-intelligence/.pub-cache"),
    );
    expect(Object.isFrozen(plan.process)).toBe(true);
    expect(Object.isFrozen(plan.process.args)).toBe(true);
    expect(Object.isFrozen(plan.process.env)).toBe(true);
    expect(Object.isFrozen(plan.mutations)).toBe(true);
    expect(Object.isFrozen(plan.diagnostics)).toBe(true);
    expect(Object.isFrozen(plan.recipe)).toBe(true);
    const configMutation = plan.mutations.find(({ path }) =>
      path.endsWith("opencode.jsonc"),
    );
    const config = JSON.parse(configMutation?.content ?? "null") as {
      mcp: Record<string, { command: string[]; cwd?: string }>;
    };
    expect(config.mcp["dart-pubdev-explorer"]).toEqual(
      expect.objectContaining({
        command: [
          join(
            root,
            ".loom/tools/flutter-package-intelligence/.runtime/dart-pubdev-explorer",
          ),
        ],
      }),
    );
    expect(requests[0]).toMatchObject({ args: ["--version"], shell: false });
    expect(FLUTTER_PACKAGE_INTELLIGENCE_RECIPE).toMatchObject({
      dartPubdevMcp: { version: "0.9.0" },
      skillsCli: { version: "1.0.0" },
    });
  });

  it("owns the compiled runtime and refuses tampered no-op activation", async () => {
    const { root, installer } = await fixture();
    const initial = await installer.apply(await installer.plan(root));
    await installer.commit(initial.rollbackToken!);
    const runtime = join(
      root,
      ".loom/tools/flutter-package-intelligence/.runtime/dart-pubdev-explorer",
    );
    await write(runtime, "tampered\n");

    expect((await installer.verify(root)).map(({ code }) => code)).toContain(
      "installers.modified-owned-file",
    );
    const plan = await installer.plan(root);
    expect(plan.mutations).toEqual([]);
    expect(plan.diagnostics.map(({ code }) => code)).toContain(
      "installers.modified-owned-runtime",
    );
    expect((await installer.apply(plan)).changed).toEqual([]);
  });

  it("clears a preseeded package cache before Dart package code executes", async () => {
    const { root, installer, preseedChecks } = await fixture();
    await write(
      join(
        root,
        ".loom/tools/flutter-package-intelligence/.pub-cache/preseed.dart",
      ),
      "malicious\n",
    );

    const result = await installer.apply(await installer.plan(root));

    expect(result.diagnostics).toEqual([]);
    expect(preseedChecks).toEqual([false]);
  });

  it("restores generated state and the prior runtime after failed repair", async () => {
    const { root, installer, processRunner } = await fixture();
    const initial = await installer.apply(await installer.plan(root));
    await installer.commit(initial.rollbackToken!);
    const toolRoot = join(root, ".loom/tools/flutter-package-intelligence");
    const runtime = join(toolRoot, ".runtime/dart-pubdev-explorer");
    const runtimeBefore = await readFile(runtime);
    await write(join(toolRoot, ".pub-cache/sentinel"), "keep\n");
    await write(join(toolRoot, ".dart_tool/package_config.json"), "{}\n");
    const failingInstaller = new CapabilityInstaller({
      dartPath: "/opt/flutter/bin/dart",
      gitPath: "/usr/bin/git",
      processRunner: async (request) => {
        const result = await processRunner(request);
        return request.args.join(" ") === "pub get --enforce-lockfile"
          ? { ...result, exitCode: 1, stderr: "injected failure" }
          : result;
      },
    });

    const result = await failingInstaller.apply(
      await failingInstaller.plan(root),
    );

    expect(result.diagnostics.map(({ code }) => code)).toContain(
      "installers.apply-failed",
    );
    expect(await readFile(join(toolRoot, ".pub-cache/sentinel"), "utf8")).toBe(
      "keep\n",
    );
    expect(await readFile(runtime)).toEqual(runtimeBefore);
  });

  it("applies, verifies, is idempotent, and removes unchanged ownership", async () => {
    const { root, installer, requests } = await fixture();
    const first = await installer.apply(await installer.plan(root));
    const config = await readFile(join(root, "opencode.jsonc"), "utf8");
    const activations = requests.filter(
      ({ args }) => args.join(" ") === "pub get --enforce-lockfile",
    ).length;

    expect(first.diagnostics).toEqual([]);
    await installer.commit(first.rollbackToken!);
    expect(
      requests.find(({ args }) => args[0] === "compile")?.args.at(-1),
    ).toBe(
      join(
        root,
        ".loom/tools/flutter-package-intelligence/.runtime/.dart-pubdev-explorer.staged",
      ),
    );
    await expect(
      readFile(
        join(
          root,
          ".loom/tools/flutter-package-intelligence/.runtime/.dart-pubdev-explorer.staged",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(config).toContain('"dart-mcp-server"');
    expect(config).toContain('"dart-pubdev-explorer"');
    expect(config).not.toContain(process.env.HOME ?? "impossible-global-home");
    expect(await installer.verify(root)).toEqual([]);
    const repeatedPlan = await installer.plan(root);
    expect(repeatedPlan.mutations).toEqual([]);
    const repeated = await installer.apply(repeatedPlan);
    expect(repeated.changed).toEqual([]);
    await installer.commit(repeated.rollbackToken!);
    expect(
      requests.filter(
        ({ args }) => args.join(" ") === "pub get --enforce-lockfile",
      ),
    ).toHaveLength(activations);
    await write(
      join(
        root,
        ".loom/tools/flutter-package-intelligence/.dart_tool/package_config.json",
      ),
      "{}\n",
    );
    const reactivated = await installer.apply(await installer.plan(root));
    expect(reactivated.changed).toEqual([]);
    await installer.commit(reactivated.rollbackToken!);
    expect(
      requests.filter(
        ({ args }) => args.join(" ") === "pub get --enforce-lockfile",
      ),
    ).toHaveLength(activations + 1);
    expect(await installer.verify(root)).toEqual([]);
    expect((await installer.uninstall(root)).diagnostics).toEqual([]);
    const removedConfig = await readFile(join(root, "opencode.jsonc"), "utf8");
    expect(removedConfig).not.toContain('"dart-mcp-server"');
    expect(removedConfig).not.toContain('"dart-pubdev-explorer"');
    await expect(
      readFile(join(root, ".loom/setup-ownership.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls a fresh installation back to the exact prior tree", async () => {
    const { root, installer } = await fixture();
    const plan = await installer.plan(root);
    const before = await snapshot(root);
    const applied = await installer.apply(plan);

    expect(applied.rollbackToken).toBeDefined();
    expect(
      (await installer.rollback(applied.rollbackToken!)).diagnostics,
    ).toEqual([]);
    expect(await snapshot(root)).toEqual(before);
  });

  it("rolls a pre-existing installation repair back exactly", async () => {
    const { root, installer } = await fixture();
    const installed = await installer.apply(await installer.plan(root));
    expect(installed.rollbackToken).toBeDefined();
    expect(await installer.commit(installed.rollbackToken!)).toEqual([]);
    const packageConfig = join(
      root,
      ".loom/tools/flutter-package-intelligence/.dart_tool/package_config.json",
    );
    await write(packageConfig, "{}\n");
    const before = await snapshot(root);
    const repaired = await installer.apply(await installer.plan(root));

    expect(repaired.rollbackToken).toBeDefined();
    expect(
      (await installer.rollback(repaired.rollbackToken!)).diagnostics,
    ).toEqual([]);
    expect(await snapshot(root)).toEqual(before);
  });

  it("refuses to remove unknown files from the private tool directory", async () => {
    const { root, installer } = await fixture();
    const installed = await installer.apply(await installer.plan(root));
    await installer.commit(installed.rollbackToken!);
    const userFile = join(
      root,
      ".loom/tools/flutter-package-intelligence/user-file.txt",
    );
    await write(userFile, "keep\n");

    const result = await installer.uninstall(root);

    expect(result.changed).toEqual([]);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      "installers.unowned-tool-entry",
    );
    expect(await readFile(userFile, "utf8")).toBe("keep\n");
  });

  it("rejects forged ownership before uninstalling files", async () => {
    const { root, installer } = await fixture();
    const installed = await installer.apply(await installer.plan(root));
    await installer.commit(installed.rollbackToken!);
    const ownershipPath = join(root, ".loom/setup-ownership.json");
    const ownership = JSON.parse(await readFile(ownershipPath, "utf8")) as {
      capabilities: Record<string, { recipeDigest: string }>;
    };
    ownership.capabilities[
      FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.candidate
    ]!.recipeDigest = "0".repeat(64);
    await write(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);

    const result = await installer.uninstall(root);

    expect(result.changed).toEqual([]);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      "installers.invalid-ownership",
    );
    expect(
      await readFile(
        join(root, ".loom/tools/flutter-package-intelligence/pubspec.yaml"),
        "utf8",
      ),
    ).toContain("dart_pubdev_mcp");
  });

  it("refuses a self-consistent forged skill manifest after source authentication", async () => {
    const { root, installer } = await fixture();
    const initial = await installer.apply(await installer.plan(root));
    await installer.commit(initial.rollbackToken!);
    const arbitraryPath = ".agents/skills/forged-skill/SKILL.md";
    const arbitrary = "arbitrary project file\n";
    const source = "authenticated source file\n";
    const digest = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    const bound = (value: string) => `sha256:${digest(value)}`;
    await write(join(root, arbitraryPath), arbitrary);
    await write(
      join(root, "cache/forged_pkg-1.0.0/pubspec.yaml"),
      "name: forged_pkg\nversion: 1.0.0\n",
    );
    await write(
      join(root, "cache/forged_pkg-1.0.0/skills/forged-skill/SKILL.md"),
      source,
    );
    await write(
      join(root, "pubspec.lock"),
      `packages:\n  forged_pkg:\n    description:\n      sha256: ${"b".repeat(64)}\n`,
    );
    const ownershipPath = join(root, ".loom/setup-ownership.json");
    const ownership = JSON.parse(await readFile(ownershipPath, "utf8")) as {
      capabilities: Record<
        string,
        {
          recipeDigest: string;
          recipe: Record<string, unknown> & { selectedSkills: unknown[] };
          files: Record<string, string>;
        }
      >;
    };
    const capability =
      ownership.capabilities[FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.candidate]!;
    capability.recipe.selectedSkills = [
      {
        source: "hosted-package",
        id: "pub:forged_pkg@1.0.0/forged-skill",
        reason: "Forged ownership",
        package: "forged_pkg",
        version: "1.0.0",
        packageContentHash: `sha256:${"b".repeat(64)}`,
        archiveHash: `sha256:${"b".repeat(64)}`,
        path: "skills/forged-skill",
        contentHash: bound(`SKILL.md\0${bound(arbitrary)}`),
      },
    ];
    capability.files[arbitraryPath] = digest(arbitrary);
    capability.recipeDigest = digest(
      JSON.stringify(canonicalize(capability.recipe)),
    );
    await write(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`);

    const result = await installer.uninstall(root);

    expect(result.changed).toEqual([]);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      "installers.skill-authentication",
    );
    expect(await readFile(join(root, arbitraryPath), "utf8")).toBe(arbitrary);
  });

  it("refuses to activate a pre-populated private tool directory", async () => {
    const { root, installer } = await fixture();
    await write(
      join(root, ".loom/tools/flutter-package-intelligence/unowned.txt"),
      "keep\n",
    );

    const plan = await installer.plan(root);

    expect(plan.mutations).toEqual([]);
    expect(plan.diagnostics.map(({ code }) => code)).toContain(
      "installers.unowned-tool-entry",
    );
  });

  it("rejects Dart 3.10 because the locked tool package requires 3.11", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-old-dart-"));
    roots.push(root);
    const installer = new CapabilityInstaller({
      dartPath: "/opt/flutter/bin/dart",
      gitPath: "/usr/bin/git",
      processRunner: async () => ({
        exitCode: 0,
        stdout: "Dart SDK version: 3.10.4",
        stderr: "",
      }),
    });

    const plan = await installer.plan(root);

    expect(plan.mutations).toEqual([]);
    expect(plan.diagnostics.map(({ code }) => code)).toContain(
      "installers.dart-version",
    );
  });

  it("refuses collisions and keeps legacy ownership removal-only", async () => {
    const { root, installer } = await fixture();
    await write(
      join(root, "opencode.jsonc"),
      '{"mcp":{"dart-pubdev-explorer":{"command":["other"]}}}\n',
    );
    expect(
      (await installer.plan(root)).diagnostics.map(({ code }) => code),
    ).toContain("installers.mcp-collision");
    expect(FLUTTER_AGENT_PLUGINS_RECIPE.candidate).toBe(
      "builtin:flutter-agent-plugins",
    );
  });

  it("installs every file from one exact locked package skill", async () => {
    const { root, installer, requests, processRunner } = await fixture();
    const packageRoot = join(root, "cache/example_pkg-2.3.4");
    const skill =
      "---\nname: example-pkg-usage\ndescription: Exact fixture.\n---\n";
    const reference = "Use only the stable API.\n";
    await write(
      join(packageRoot, "pubspec.yaml"),
      'name: example_pkg\nversion: "2.3.4"\n',
    );
    await write(join(packageRoot, "skills/example-pkg-usage/SKILL.md"), skill);
    await write(
      join(packageRoot, "skills/example-pkg-usage/references/api.md"),
      reference,
    );
    await write(
      join(root, "pubspec.yaml"),
      "name: app\ndependencies:\n  example_pkg: 2.3.4\n",
    );
    await write(
      join(root, ".dart_tool/package_config.json"),
      JSON.stringify({
        configVersion: 2,
        packages: [
          { name: "example_pkg", rootUri: pathToFileURL(packageRoot).href },
        ],
      }),
    );
    await write(
      join(root, "pubspec.lock"),
      `packages:\n  example_pkg:\n    dependency: direct main\n    description:\n      name: example_pkg\n      sha256: ${packageArchiveHash.slice(7)}\n      url: "https://pub.dev"\n    source: hosted\n    version: "2.3.4"\n`,
    );
    const digest = (value: string) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`;
    const contentHash = digest(
      [
        `SKILL.md\0${digest(skill)}`,
        `references/api.md\0${digest(reference)}`,
      ].join("\n"),
    );
    const recipe = {
      kind: "flutter-package-intelligence" as const,
      toolPath: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath,
      dartPubdevMcp: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.dartPubdevMcp,
      skillsCli: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.skillsCli,
      pubspecHash: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.pubspecHash,
      lockfileHash: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.lockfileHash,
      selectedSkills: [
        {
          source: "hosted-package" as const,
          id: "pub:example_pkg@2.3.4/example-pkg-usage",
          reason: "Required by the task",
          package: "example_pkg",
          version: "2.3.4",
          packageContentHash: packageArchiveHash,
          archiveHash: packageArchiveHash,
          path: "skills/example-pkg-usage",
          contentHash,
        },
      ],
    };
    const mismatchedInstaller = new CapabilityInstaller({
      dartPath: "/opt/flutter/bin/dart",
      gitPath: "/usr/bin/git",
      processRunner,
      fetch: async () => new Response("different archive"),
    });
    const mismatchedPlan = await mismatchedInstaller.plan(root, recipe);
    expect(mismatchedPlan.mutations).toEqual([]);
    expect(mismatchedPlan.diagnostics.map(({ message }) => message)).toContain(
      "Downloaded package archive hash does not match the pin",
    );

    const result = await installer.apply(await installer.plan(root, recipe));

    expect(result.diagnostics).toEqual([]);
    await installer.commit(result.rollbackToken!);
    const skillsRequest = requests.find((request) =>
      request.args.includes("skills:skills"),
    );
    expect(skillsRequest?.args).toEqual(
      expect.arrayContaining([
        "--package",
        "example_pkg",
        "--skill",
        "example-pkg-usage",
      ]),
    );
    expect(skillsRequest?.args).not.toContain("--all");
    expect(
      requests.some(
        ({ args, env }) =>
          args.join(" ") ===
            `pub unpack example_pkg:2.3.4 --no-resolve --output ${args.at(-1)}` &&
          env.PUB_CACHE?.includes("loom-pub-skill-") === true,
      ),
    ).toBe(true);
    expect(
      await readFile(
        join(root, ".agents/skills/example-pkg-usage/references/api.md"),
        "utf8",
      ),
    ).toBe(reference);
    const removed = await installer.uninstall(root);
    expect(removed.diagnostics).toEqual([]);
    expect(
      requests.some(
        ({ args }) =>
          args.join(" ") === "pub cache add example_pkg --version 2.3.4",
      ),
    ).toBe(true);
    await expect(
      readFile(join(root, ".agents/skills/example-pkg-usage/SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stages a registry skill from its exact commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-registry-install-"));
    const source = await mkdtemp(join(tmpdir(), "loom-registry-source-"));
    roots.push(root, source);
    const commit = "b".repeat(40);
    const skill = "---\nname: repo-skill\ndescription: Pinned.\n---\n";
    await write(join(source, "catalog/repo-skill/SKILL.md"), skill);
    const requests: ProcessRequest[] = [];
    const installer = new CapabilityInstaller({
      dartPath: "/opt/flutter/bin/dart",
      gitPath: "/usr/bin/git",
      processRunner: async (request) => {
        requests.push(request);
        if (request.args[0] === "--version")
          return {
            exitCode: 0,
            stdout: "Dart SDK version: 3.11.4",
            stderr: "",
          };
        if (request.command === "/usr/bin/git") {
          if (request.args[0] === "checkout")
            await cp(source, request.cwd, { recursive: true });
          return {
            exitCode: 0,
            stdout: request.args[0] === "rev-parse" ? `${commit}\n` : "",
            stderr: "",
          };
        }
        if (request.args.join(" ") === "pub get --enforce-lockfile")
          await writeToolPackageConfig(request.cwd);
        if (request.args[0] === "compile") {
          const output = request.args[request.args.indexOf("-o") + 1]!;
          await write(output, "owned-compiled-runtime\n");
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const digest = (value: string) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`;
    const recipe = {
      kind: "flutter-package-intelligence" as const,
      toolPath: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath,
      dartPubdevMcp: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.dartPubdevMcp,
      skillsCli: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.skillsCli,
      pubspecHash: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.pubspecHash,
      lockfileHash: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.lockfileHash,
      selectedSkills: [
        {
          source: "skills-registry" as const,
          id: "skill:owner/repo@repo-skill",
          reason: "Relevant registry skill",
          repository: "https://github.com/owner/repo",
          commit,
          path: "catalog/repo-skill",
          contentHash: digest(`SKILL.md\0${digest(skill)}`),
        },
      ],
    };

    const result = await installer.apply(await installer.plan(root, recipe));

    expect(result.diagnostics).toEqual([]);
    expect(
      await readFile(join(root, ".agents/skills/repo-skill/SKILL.md"), "utf8"),
    ).toBe(skill);
    expect(
      requests.some(
        ({ command, args }) =>
          command === "/usr/bin/git" &&
          args.join(" ") === `fetch --depth=1 origin ${commit}`,
      ),
    ).toBe(true);
  });

  it("refuses symlinked skill destinations", async () => {
    const { root, installer } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "loom-outside-"));
    roots.push(outside);
    await mkdir(join(root, ".loom"));
    await symlink(outside, join(root, ".loom/tools"), "dir");
    const plan = await installer.plan(root);

    expect(plan.mutations).toEqual([]);
    expect(plan.diagnostics.map(({ code }) => code)).toContain(
      "installers.unsafe-path",
    );
  });

  it("rejects concurrent changes and rolls back partial writes", async () => {
    const concurrent = await fixture();
    const concurrentPlan = await concurrent.installer.plan(concurrent.root);
    await write(join(concurrent.root, "opencode.jsonc"), '{"changed":true}\n');
    const refused = await concurrent.installer.apply(concurrentPlan);
    expect(refused.diagnostics.map(({ code }) => code)).toContain(
      "installers.concurrent-change",
    );

    const root = await mkdtemp(join(tmpdir(), "loom-rollback-"));
    roots.push(root);
    let writes = 0;
    const installer = new CapabilityInstaller({
      dartPath: "/opt/flutter/bin/dart",
      gitPath: "/usr/bin/git",
      processRunner: async (request) =>
        request.args[0] === "--version"
          ? {
              exitCode: 0,
              stdout: "Dart SDK version: 3.11.4",
              stderr: "",
            }
          : { exitCode: 0, stdout: "", stderr: "" },
      fileOperations: {
        write: async (path, content) => {
          writes += 1;
          await write(path, content);
          if (writes === 2) throw new Error("injected post-write failure");
        },
        remove: async (path) => rm(path, { force: true }),
      },
    });
    const result = await installer.apply(await installer.plan(root));

    expect(result.diagnostics.map(({ code }) => code)).toContain(
      "installers.apply-failed",
    );
    await expect(
      readFile(
        join(root, ".loom/tools/flutter-package-intelligence/pubspec.yaml"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an ownership update that races package activation", async () => {
    const { root, processRunner } = await fixture();
    const racedOwnership = '{"version":1,"capabilities":{"race":{}}}\n';
    const installer = new CapabilityInstaller({
      dartPath: "/opt/flutter/bin/dart",
      gitPath: "/usr/bin/git",
      fetch: async () => new Response(packageArchive),
      processRunner: async (request) => {
        const result = await processRunner(request);
        if (request.args.join(" ") === "pub get --enforce-lockfile")
          await write(join(root, ".loom/setup-ownership.json"), racedOwnership);
        return result;
      },
    });

    const result = await installer.apply(await installer.plan(root));

    expect(result.changed).toEqual([]);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      "installers.apply-failed",
    );
    expect(
      await readFile(join(root, ".loom/setup-ownership.json"), "utf8"),
    ).toBe(racedOwnership);
    await expect(
      readFile(
        join(root, ".loom/tools/flutter-package-intelligence/pubspec.yaml"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates unchanged legacy ownership without leaving the bundle", async () => {
    const { root, installer } = await fixture();
    const name = FLUTTER_AGENT_PLUGINS_RECIPE.skills[0];
    const path = `.agents/skills/${name}/SKILL.md`;
    const content = "legacy\n";
    const pointer = {
      type: "local",
      command: ["/opt/flutter/bin/dart", "mcp-server"],
      enabled: true,
    };
    await write(join(root, path), content);
    await write(
      join(root, "opencode.jsonc"),
      `${JSON.stringify({ mcp: { "dart-mcp-server": pointer } }, null, 2)}\n`,
    );
    await write(
      join(root, ".loom/setup-ownership.json"),
      `${JSON.stringify({
        version: 1,
        capabilities: {
          [FLUTTER_AGENT_PLUGINS_RECIPE.candidate]: {
            recipeDigest: "legacy",
            files: {
              [path]: createHash("sha256").update(content).digest("hex"),
            },
            pointers: {
              "mcp.dart-mcp-server": { path: "opencode.jsonc", value: pointer },
            },
          },
        },
      })}\n`,
    );

    const result = await installer.apply(await installer.plan(root));
    const ownership = await readFile(
      join(root, ".loom/setup-ownership.json"),
      "utf8",
    );

    expect(result.diagnostics).toEqual([]);
    await expect(readFile(join(root, path), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(ownership).not.toContain("builtin:flutter-agent-plugins");
    expect(ownership).toContain("builtin:flutter-package-intelligence");
  });
});
