import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  decodeSetupIntent,
  detectProject,
  type CapabilityCandidate,
} from "@loom/core";
import {
  BuiltinRegistry,
  SkillsCliRegistry,
  type CapabilityRegistry,
} from "@loom/registry";
import { describe, expect, it, vi } from "vitest";

import { createLoomToolHandlers } from "./handlers.js";

describe("createLoomToolHandlers", () => {
  it("delegates detection and keeps network discovery disabled by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-mcp-"));
    const detect = vi.fn(detectProject);
    const network = vi.fn<() => readonly CapabilityRegistry[]>(() => [
      new BuiltinRegistry(),
    ]);
    const handlers = createLoomToolHandlers({
      cwd: () => root,
      detectProject: detect,
      networkRegistries: network,
    });

    const detected = await handlers.projectDetect({});
    const searched = await handlers.capabilitySearch({ text: "context7" });

    expect(detect).toHaveBeenCalledWith(root);
    expect(detected.project).toMatchObject({ root, lifecycle: "greenfield" });
    expect(network).not.toHaveBeenCalled();
    expect(searched).toMatchObject({
      networkDiscovery: false,
      registries: ["builtin"],
      count: 1,
    });
  });

  it("uses network registries only when explicitly requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-mcp-"));
    const candidate = (await new BuiltinRegistry().resolve(
      "context7",
    )) as CapabilityCandidate;
    const registry: CapabilityRegistry = {
      id: "network-test",
      search: vi.fn(async () => [candidate]),
      resolve: vi.fn(async () => candidate),
    };
    const network = vi.fn(() => [registry]);
    const handlers = createLoomToolHandlers({
      cwd: () => root,
      localRegistries: [],
      networkRegistries: network,
    });

    const result = await handlers.capabilitySearch({
      text: "context7",
      networkDiscovery: true,
    });

    expect(network).toHaveBeenCalledOnce();
    expect(registry.search).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ count: 1, registries: ["network-test"] });
  });

  it("reads valid state and refuses state-file symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-mcp-"));
    const stateDirectory = join(root, ".loom");
    const outside = join(root, "outside.json");
    await mkdir(stateDirectory);
    await writeFile(
      join(stateDirectory, "capabilities.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date(0).toISOString(),
        entries: [],
      }),
    );
    await writeFile(outside, JSON.stringify({ phase: "build" }));
    await symlink(outside, join(stateDirectory, "workflow.json"));
    const handlers = createLoomToolHandlers({ cwd: () => root });

    const capabilities = await handlers.capabilityStatus({});
    const workflow = await handlers.workflowStatus({});

    expect(capabilities).toMatchObject({
      state: { status: "valid" },
      capabilities: [],
    });
    expect(workflow).toMatchObject({
      state: {
        status: "invalid",
        error: "State file must not be a symbolic link",
      },
      workflow: null,
    });
  });

  it("recommends a deterministic, non-executable setup intent", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-mcp-"));
    const candidate = (await new BuiltinRegistry().resolve(
      "context7",
    )) as CapabilityCandidate;
    const project = detectProject(root);
    const task = {
      summary: "Read current package documentation",
      intents: ["documentation"],
      requiredCapabilities: ["DOCS.api-reference"],
      usefulCapabilities: ["DOCS.framework-docs"],
      risk: "low" as const,
    };
    const selected = {
      candidate,
      score: 90,
      reasons: ["Covers requested documentation"],
      penalties: [],
      coverage: [
        "DOCS.framework-docs",
        "DOCS.api-reference",
        "DOCS.framework-docs",
      ],
      breakdown: {
        taskFit: 1,
        projectFit: 1,
        coverage: 1,
        maintenance: 1,
        provenance: 1,
        security: 1,
        contextEfficiency: 1,
        portability: 1,
        penalties: 0,
      },
    };
    const handlers = createLoomToolHandlers({
      cwd: () => root,
      networkRegistries: () => [],
      planProject: vi.fn(async () => ({
        project,
        task,
        candidates: [candidate],
        plan: {
          project,
          task,
          selected: [selected],
          optional: [],
          rejected: [],
          uncovered: [],
          requiredApprovals: [],
        },
      })),
    });

    const result = await handlers.setupRecommend({
      task: "Read current package documentation",
      harness: "opencode",
    });
    const intent = decodeSetupIntent(result.intent as string);

    expect(intent).toMatchObject({
      schemaVersion: 1,
      mode: "apply",
      harness: "opencode",
      task: "Read current package documentation",
    });
    expect(intent.requestedCapabilities).toEqual([
      "DOCS.api-reference",
      "DOCS.framework-docs",
    ]);
    expect(result.command).toBe(`loom setup --intent ${result.intent}`);
    expect(Object.keys(intent).sort()).toEqual(
      [
        "harness",
        "mode",
        "projectFingerprint",
        "requestedCapabilities",
        "root",
        "schemaVersion",
        "selectedSkills",
        "selectionRationale",
        "task",
      ].sort(),
    );
    expect(JSON.stringify(intent)).not.toMatch(/https?:\/\//i);
    expect(intent).not.toHaveProperty("recipe");
    expect(intent).not.toHaveProperty("url");
  });

  it("requires explicit LLM selection from exact locked package skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-mcp-flutter-"));
    const packageRoot = join(root, "cache/example_pkg-2.3.4");
    await mkdir(join(root, ".dart_tool"), { recursive: true });
    await mkdir(join(packageRoot, "skills/example-pkg-usage"), {
      recursive: true,
    });
    await writeFile(
      join(root, "pubspec.yaml"),
      "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n  example_pkg: 2.3.4\n",
    );
    await writeFile(
      join(root, "pubspec.lock"),
      `packages:\n  example_pkg:\n    dependency: direct main\n    description:\n      name: example_pkg\n      sha256: ${"a".repeat(64)}\n      url: "https://pub.dev"\n    source: hosted\n    version: "2.3.4"\nsdks:\n  dart: ">=3.10.0 <4.0.0"\n`,
    );
    await writeFile(
      join(root, ".dart_tool/package_config.json"),
      JSON.stringify({
        configVersion: 2,
        packages: [
          {
            name: "example_pkg",
            rootUri: pathToFileURL(packageRoot).href,
            packageUri: "lib/",
          },
        ],
      }),
    );
    await writeFile(
      join(packageRoot, "skills/example-pkg-usage/SKILL.md"),
      "---\nname: example-pkg-usage\ndescription: Use ExamplePkg safely.\n---\n",
    );
    const handlers = createLoomToolHandlers({
      cwd: () => root,
      skillsRegistry: new SkillsCliRegistry({
        runner: {
          run: async () => ({
            exitCode: 0,
            stdout: "owner/repo@repo-skill\n",
            stderr: "",
          }),
        },
      }),
      registrySkillResolver: {
        resolve: async () => ({
          repository: "https://github.com/owner/repo",
          commit: "b".repeat(40),
          path: "catalog/repo-skill",
          contentHash: `sha256:${"c".repeat(64)}`,
          description: "Pinned registry skill",
        }),
      },
    });

    const first = await handlers.setupRecommend({
      task: "Use ExamplePkg",
      networkDiscovery: false,
    });
    const searched = await handlers.skillSearch({ task: "Use ExamplePkg" });
    const candidate = (searched.candidates as Array<{ id: string }>)[0]!;
    const registryCandidate = (
      searched.candidates as Array<Record<string, unknown>>
    ).find(({ id }) => id === "skill:owner/repo@repo-skill");
    const second = await handlers.setupRecommend({
      task: "Use ExamplePkg",
      networkDiscovery: false,
      selectedSkills: [{ id: candidate.id, reason: "Direct task dependency" }],
    });

    expect(first).toMatchObject({ selectionRequired: true, command: null });
    expect(searched).toMatchObject({ installCommand: null });
    expect(JSON.stringify(searched)).toContain(`sha256:${"a".repeat(64)}`);
    expect(registryCandidate).toMatchObject({
      commit: "b".repeat(40),
      path: "catalog/repo-skill",
      contentHash: `sha256:${"c".repeat(64)}`,
    });
    expect(decodeSetupIntent(second.intent as string).selectedSkills).toEqual([
      expect.objectContaining({
        id: candidate.id,
        reason: "Direct task dependency",
        bindingHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      }),
    ]);
  });
});
