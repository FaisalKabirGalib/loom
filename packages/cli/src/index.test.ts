import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  detectProject,
  encodeSetupIntent,
  sha256,
} from "@loom/core";
import { WebAgentIntelligenceInstaller } from "@loom/installers";
import { planProject } from "@loom/registry";

import { configureCliRuntime, runCli, type RunCliOptions } from "./index.js";

class BufferWriter {
  value = "";

  write(value: string): void {
    this.value += value;
  }
}

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "loom-cli-"));
  roots.push(root);
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", devDependencies: { typescript: "7.0.2" } }, null, 2)}\n`,
    "utf8",
  );
  return root;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function setupFingerprint(root: string): string {
  const {
    detectionSignals: _detectionSignals,
    existingAgentConfigs: _existingAgentConfigs,
    ...binding
  } = detectProject(root);
  return sha256(canonicalJson(binding));
}

async function setupCapabilities(
  root: string,
  task?: string,
): Promise<string[]> {
  const resolution = await planProject(
    root,
    task === undefined ? {} : { task },
  );
  return [
    ...new Set(resolution.plan.selected.flatMap((item) => item.coverage)),
  ].sort();
}

async function invoke(
  root: string,
  args: string[],
  options: RunCliOptions = {},
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  const code = await runCli(args, {
    ...options,
    cwd: root,
    env:
      options.env ??
      ({
        ...process.env,
        HOME: root,
        XDG_STATE_HOME: join(root, ".user-state"),
      } satisfies NodeJS.ProcessEnv),
    stdout,
    stderr,
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  });
  return { code, stdout: stdout.value, stderr: stderr.value };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("runCli", () => {
  it("keeps bare Loom non-interactive usage safe", async () => {
    const root = await fixture();
    const result = await invoke(root, [], { isTTY: false });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage: loom [command]");
  });

  it("rejects an unlisted interactive choice", async () => {
    const root = await fixture();
    const result = await invoke(root, [], {
      isTTY: true,
      select: async () => "not a choice",
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage.invalid-selection");
  });

  it("guides a Flutter project through OpenCode setup and agent handoff", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "pubspec.yaml"),
      "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    const choices = ["set up this project", "opencode"];
    const result = await invoke(root, [], {
      isTTY: true,
      confirm: async () => true,
      select: async (_prompt, options) => {
        const choice = choices.shift();
        expect(options).toContain(choice);
        return choice!;
      },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "Flutter package-intelligence is verified on OpenCode.",
    );
    expect(result.stdout).toContain("Connect (opencode)");
    expect(result.stdout).toContain("restart OpenCode");
    expect(result.stdout).toContain("Search relevant package skills");
    expect(await exists(join(root, "opencode.json"))).toBe(true);
  });

  it.each([
    ["opencode", "opencode.json"],
    ["codex", ".codex/config.toml"],
    ["claude", ".mcp.json"],
    ["omp", ".omp/mcp.json"],
    ["antigravity", ".agents/mcp_config.json"],
  ])("offers %s through guided setup", async (harness, config) => {
    const root = await fixture();
    const choices = ["set up this project", harness];
    const result = await invoke(root, [], {
      isTTY: true,
      confirm: async () => true,
      select: async () => choices.shift()!,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Connect (${harness})`);
    expect(await exists(join(root, config))).toBe(true);
  });

  it("does not connect when guided setup is cancelled", async () => {
    const root = await fixture();
    const choices = ["set up this project", "opencode"];
    const result = await invoke(root, [], {
      isTTY: true,
      confirm: async () => false,
      select: async () => choices.shift()!,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Setup cancelled.");
    expect(await exists(join(root, "opencode.json"))).toBe(false);
  });

  it("blocks agent handoff for a broken existing harness", async () => {
    const root = await fixture();
    expect(
      (await invoke(root, ["connect", "--harness", "opencode"])).code,
    ).toBe(0);
    await writeFile(join(root, ".opencode/plugins/loom.ts"), "tampered\n");
    const choices = ["set up this project", "opencode"];
    const result = await invoke(root, [], {
      isTTY: true,
      select: async () => choices.shift()!,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Cannot use opencode");
    expect(result.stdout).not.toContain("Next: restart OpenCode");
  });

  it("runs doctor from the interactive menu", async () => {
    const root = await fixture();
    const choices = ["doctor", "opencode"];
    const result = await invoke(root, [], {
      isTTY: true,
      select: async () => choices.shift()!,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Doctor (opencode)");
  });

  it("returns stable JSON without mutating detection or planning", async () => {
    const root = await fixture();
    const detected = await invoke(root, ["detect", "--json"]);
    const planned = await invoke(root, [
      "plan",
      "--json",
      "--task",
      "refactor types",
    ]);
    const detection = JSON.parse(detected.stdout) as Record<string, unknown>;
    const plan = JSON.parse(planned.stdout) as Record<string, unknown>;

    expect(detected.code).toBe(0);
    expect(planned.code).toBe(0);
    expect(detection).toMatchObject({
      schemaVersion: 1,
      version: "0.2.2",
      command: "detect",
      ok: true,
    });
    expect(plan).toMatchObject({
      schemaVersion: 1,
      version: "0.2.2",
      command: "plan",
      ok: true,
    });
    expect(await exists(join(root, ".loom"))).toBe(false);
  });

  it.each([
    [
      "generic TypeScript",
      { devDependencies: { typescript: "7.0.2" } },
      [
        "loom-project-setup",
        "builtin:web-agent-intelligence",
        "builtin:context7",
      ],
    ],
    [
      "Next and React",
      { dependencies: { next: "16.0.0", react: "19.0.0" } },
      ["builtin:web-agent-intelligence", "builtin:context7"],
    ],
    [
      "Flutter",
      undefined,
      ["builtin:flutter-package-intelligence", "flutter-package-skills"],
    ],
  ])(
    "includes framework recommendations for %s",
    async (_name, manifest, expected) => {
      const root = await fixture();
      if (manifest !== undefined)
        await writeFile(
          join(root, "package.json"),
          `${JSON.stringify(manifest)}\n`,
        );
      else
        await writeFile(
          join(root, "pubspec.yaml"),
          "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
        );

      const result = await invoke(root, ["plan", "--json"]);
      const data = (
        JSON.parse(result.stdout) as { data: Record<string, unknown> }
      ).data;
      const recommendations = data.frameworkRecommendations as Record<
        string,
        Array<{ id: string }>
      >;
      const suggestions = recommendations.suggested ?? [];
      const ids = Object.values(recommendations)
        .flat()
        .map((item) => item.id);

      expect(result.code).toBe(0);
      for (const value of expected) {
        if (["defaults", "installable", "suggested"].includes(value))
          expect(recommendations).toHaveProperty(value);
        else expect(ids).toContain(value);
      }
      const selected = (
        data.plan as { selected: Array<{ candidate: { id: string } }> }
      ).selected.map((item) => item.candidate.id);
      if (suggestions.length > 0)
        expect(selected).not.toEqual(
          expect.arrayContaining(suggestions.map((item) => item.id)),
        );
      if (_name === "generic TypeScript")
        expect(
          (recommendations.installable ?? []).find(
            ({ id }) => id === "builtin:web-agent-intelligence",
          ),
        ).toMatchObject({
          manualCommand:
            "AGENT_BROWSER_EXECUTABLE_PATH must point to a project-local verified executable; Loom will not download browser.",
        });
    },
  );

  it("keeps dry-run mutation free", async () => {
    const root = await fixture();
    const result = await invoke(root, [
      "apply",
      "--dry-run",
      "--harness",
      "opencode",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Apply preview (opencode)");
    expect(await exists(join(root, "opencode.json"))).toBe(false);
    expect(await exists(join(root, ".loom"))).toBe(false);
  });

  it("connects Loom without external capability approval", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "pubspec.yaml"),
      "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );

    const connected = await invoke(root, ["connect", "--harness", "opencode"]);
    const doctor = await invoke(root, ["doctor", "--harness", "opencode"]);

    expect(connected.code).toBe(0);
    expect(connected.stdout).toContain("Connect (opencode)");
    expect(await exists(join(root, "opencode.json"))).toBe(true);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain("installed yes");
  });

  it("restores an existing harness preimage after later setup failure", async () => {
    const root = await fixture();
    const skills = join(root, "skills-source");
    const defaultSkills = fileURLToPath(
      new URL("../../skills", import.meta.url),
    );
    await mkdir(skills);
    await writeFile(
      join(root, "pubspec.yaml"),
      "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    configureCliRuntime({
      skillsPath: skills,
      executablePath: process.execPath,
    });
    try {
      expect(
        (await invoke(root, ["connect", "--harness", "opencode"])).code,
      ).toBe(0);
      const configPath = join(root, "opencode.json");
      const ownershipPath = join(root, ".loom/ownership.json");
      const configBefore = await readFile(configPath);
      const ownershipBefore = await readFile(ownershipPath);
      await mkdir(join(skills, "loom-new-skill"));
      await writeFile(
        join(skills, "loom-new-skill/SKILL.md"),
        "---\nname: loom-new-skill\ndescription: Test.\n---\n",
      );
      const token = encodeSetupIntent({
        schemaVersion: 1,
        root,
        projectFingerprint: setupFingerprint(root),
        harness: "opencode",
        mode: "apply",
        requestedCapabilities: await setupCapabilities(root),
        selectedSkills: [],
        selectionRationale: "No package skill is relevant to this test",
      });
      await mkdir(join(root, ".loom/project.json"));
      let observedHarnessMutation = false;
      let installerRolledBack = false;
      let installerUninstalled = false;
      const rollbackToken = { id: "test-installer-rollback" };
      const installer = {
        async plan(
          projectRoot: string,
          recipe: NonNullable<
            Parameters<
              import("@loom/installers").CapabilityInstaller["plan"]
            >[1]
          >,
        ) {
          return {
            candidate: "builtin:flutter-package-intelligence" as const,
            root: projectRoot,
            recipeDigest: "a".repeat(64),
            recipe,
            process: {
              command: process.execPath,
              args: [],
              cwd: projectRoot,
              env: {},
              shell: false as const,
            },
            mutations: [],
            diagnostics: [],
            executionRequired: false,
          };
        },
        async apply() {
          return {
            changed: ["installer-state"],
            skipped: [],
            diagnostics: [],
            rollbackToken,
          };
        },
        async verify() {
          observedHarnessMutation = await exists(
            join(root, ".agents/skills/loom-new-skill/SKILL.md"),
          );
          return [];
        },
        async uninstall() {
          installerUninstalled = true;
          return { changed: [], skipped: [], diagnostics: [] };
        },
        async rollback(token: { id: string }) {
          installerRolledBack = token === rollbackToken;
          return { changed: [], skipped: [], diagnostics: [] };
        },
      };
      const result = await invoke(root, ["setup", "--intent", token], {
        isTTY: true,
        confirm: async () => true,
        installerFactory: () => installer,
        resolveExecutable: async () => process.execPath,
      });

      expect(result.code).toBe(1);
      expect(observedHarnessMutation).toBe(true);
      expect(installerRolledBack).toBe(true);
      expect(installerUninstalled).toBe(false);
      expect(await readFile(configPath)).toEqual(configBefore);
      expect(await readFile(ownershipPath)).toEqual(ownershipBefore);
      expect(
        await exists(join(root, ".agents/skills/loom-new-skill/SKILL.md")),
      ).toBe(false);
    } finally {
      configureCliRuntime({ skillsPath: defaultSkills });
    }
  });

  it("runs one-confirmation setup and reuses the exact approval", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "pubspec.yaml"),
      "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    const token = encodeSetupIntent({
      schemaVersion: 1,
      root,
      projectFingerprint: setupFingerprint(root),
      harness: "opencode",
      mode: "apply",
      task: "work on this Flutter app",
      requestedCapabilities: await setupCapabilities(
        root,
        "work on this Flutter app",
      ),
      selectedSkills: [],
      selectionRationale: "No package skill is relevant to this test",
    });
    let confirmations = 0;
    let installerApplies = 0;
    const installer = {
      async plan(
        projectRoot: string,
        recipe: NonNullable<
          Parameters<import("@loom/installers").CapabilityInstaller["plan"]>[1]
        >,
      ) {
        return {
          candidate: "builtin:flutter-package-intelligence" as const,
          root: projectRoot,
          recipeDigest: "a".repeat(64),
          recipe,
          process: {
            command: process.execPath,
            args: [],
            cwd: projectRoot,
            env: {},
            shell: false as const,
          },
          mutations: [],
          diagnostics: [],
          executionRequired: true,
        };
      },
      async apply() {
        installerApplies += 1;
        return { changed: [], skipped: [], diagnostics: [] };
      },
      async verify() {
        return [];
      },
      async uninstall() {
        return { changed: [], skipped: [], diagnostics: [] };
      },
    };
    const options: RunCliOptions = {
      isTTY: true,
      confirm: async () => {
        confirmations += 1;
        return true;
      },
      installerFactory: () => installer,
      resolveExecutable: async () => process.execPath,
    };

    expect(
      (await invoke(root, ["connect", "--harness", "opencode"], options)).code,
    ).toBe(0);
    const first = await invoke(root, ["setup", "--intent", token], options);
    const second = await invoke(root, ["setup", "--intent", token], options);
    expect(first.code, first.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    const transaction = JSON.parse(
      await readFile(join(root, ".loom/setup-transaction.json"), "utf8"),
    ) as { transactionId: string };
    const listed = await invoke(root, ["transactions"], options);
    const rolledBack = await invoke(
      root,
      ["rollback", transaction.transactionId],
      options,
    );

    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("Setup complete");
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("approval         reused");
    expect(confirmations).toBe(1);
    expect(installerApplies).toBe(2);
    expect(listed.stdout).toContain(transaction.transactionId);
    expect(rolledBack.code).toBe(0);
    expect(await exists(join(root, ".loom/setup-approval.json"))).toBe(false);
    expect(await exists(join(root, ".loom/capabilities.lock.json"))).toBe(true);
  });

  it("refuses first-time setup outside an interactive terminal", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "pubspec.yaml"),
      "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    const token = encodeSetupIntent({
      schemaVersion: 1,
      root,
      projectFingerprint: setupFingerprint(root),
      harness: "opencode",
      mode: "apply",
      requestedCapabilities: await setupCapabilities(root),
      selectedSkills: [],
      selectionRationale: "No package skill is relevant to this test",
    });
    let installerPlans = 0;
    const installer = {
      async plan(
        projectRoot: string,
        recipe: NonNullable<
          Parameters<import("@loom/installers").CapabilityInstaller["plan"]>[1]
        >,
      ) {
        installerPlans += 1;
        return {
          candidate: "builtin:flutter-package-intelligence" as const,
          root: projectRoot,
          recipeDigest: "a".repeat(64),
          recipe,
          process: {
            command: process.execPath,
            args: [],
            cwd: projectRoot,
            env: {},
            shell: false as const,
          },
          mutations: [],
          diagnostics: [],
          executionRequired: false,
        };
      },
      async apply() {
        return { changed: [], skipped: [], diagnostics: [] };
      },
      async verify() {
        return [];
      },
      async uninstall() {
        return { changed: [], skipped: [], diagnostics: [] };
      },
    };

    const options: RunCliOptions = {
      isTTY: false,
      installerFactory: () => installer,
      resolveExecutable: async () => process.execPath,
    };
    expect(
      (await invoke(root, ["connect", "--harness", "opencode"], options)).code,
    ).toBe(0);
    await writeFile(
      join(root, ".loom/setup-approval.json"),
      JSON.stringify({ planId: "forged", expiresAt: "2999-01-01T00:00:00Z" }),
    );
    const result = await invoke(root, ["setup", "--intent", token], options);

    expect(result.code, result.stderr).toBe(3);
    expect(result.stderr).toContain("setup.confirmation-required");
    expect(installerPlans).toBe(1);
  });

  it("treats missing state as normal before installation", async () => {
    const root = await fixture();
    const result = await invoke(root, ["doctor", "--harness", "opencode"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("installed no");
    expect(result.stdout).not.toContain("loom.state-invalid");
  });

  it("reports partial state before installation", async () => {
    const root = await fixture();
    await mkdir(join(root, ".loom"));
    await writeFile(
      join(root, ".loom/project.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        version: "0.2.2",
        project: detectProject(root),
      })}\n`,
    );

    const result = await invoke(root, ["doctor", "--harness", "opencode"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("loom.state-invalid");
  });

  it("omits mutation contents from JSON plans", async () => {
    const root = await fixture();
    const result = await invoke(root, [
      "plan",
      "--json",
      "--harness",
      "opencode",
    ]);
    const envelope = JSON.parse(result.stdout) as {
      data: { harnessPlan: { mutations: Array<Record<string, unknown>> } };
    };

    expect(result.code).toBe(0);
    expect(
      envelope.data.harnessPlan.mutations.every(
        (mutation) => !("content" in mutation),
      ),
    ).toBe(true);
  });

  it("rejects unknown approvals", async () => {
    const root = await fixture();
    const result = await invoke(root, [
      "apply",
      "--harness",
      "opencode",
      "--approve",
      "not-requested",
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("approval.unknown");
  });

  it("refuses apply when policy leaves required capabilities uncovered", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "go.mod"),
      "module example.com/app\n\ngo 1.24\n",
    );
    await mkdir(join(root, ".loom"));
    await writeFile(
      join(root, ".loom/policy.toml"),
      "[capabilities]\nmin_score = 100\n",
    );
    const result = await invoke(root, ["apply", "--harness", "opencode"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("plan.uncovered");
    expect(await exists(join(root, "opencode.json"))).toBe(false);
  });

  it("applies idempotently and removes owned state", async () => {
    const root = await fixture();
    const first = await invoke(root, ["apply", "--harness", "opencode"]);
    const second = await invoke(root, ["apply", "--harness", "opencode"]);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("changed 0");
    expect(
      JSON.parse(await readFile(join(root, ".loom/project.json"), "utf8")),
    ).toMatchObject({
      schemaVersion: 1,
      version: "0.2.2",
    });
    expect(await exists(join(root, ".loom/workflow.json"))).toBe(true);
    expect(await exists(join(root, ".loom/capabilities.lock.json"))).toBe(true);

    const removed = await invoke(root, ["remove", "--harness", "opencode"]);

    expect(removed.code).toBe(0);
    expect(await exists(join(root, ".opencode/plugins/loom.ts"))).toBe(false);
    expect(await exists(join(root, ".loom/project.json"))).toBe(false);
    expect(await exists(join(root, ".loom/workflow.json"))).toBe(false);
    expect(await exists(join(root, ".loom/capabilities.lock.json"))).toBe(
      false,
    );
  });

  it.each([
    ["claude", ".mcp.json"],
    ["omp", ".omp/mcp.json"],
    ["antigravity", ".agents/mcp_config.json"],
  ])("runs the %s lifecycle through CLI dispatch", async (harness, config) => {
    const root = await fixture();
    const first = await invoke(root, ["apply", "--harness", harness]);
    const second = await invoke(root, ["apply", "--harness", harness]);
    const configPath = join(root, config);
    const value = JSON.parse(await readFile(configPath, "utf8")) as {
      mcpServers: { loom: Record<string, unknown> };
    };
    value.mcpServers.loom = Object.fromEntries(
      Object.entries(value.mcpServers.loom).reverse(),
    );
    await writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`);
    const doctor = await invoke(root, ["doctor", "--harness", harness]);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("changed 0");
    expect(doctor.code).toBe(0);
    expect(await exists(configPath)).toBe(true);

    const removed = await invoke(root, ["remove", "--harness", harness]);

    expect(removed.code).toBe(0);
    if (await exists(configPath)) {
      const remaining = JSON.parse(await readFile(configPath, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      expect(remaining.mcpServers?.loom).toBeUndefined();
    }
  });

  it("shares skills safely across OpenCode, Codex, and Antigravity", async () => {
    const root = await fixture();
    expect((await invoke(root, ["apply", "--harness", "opencode"])).code).toBe(
      0,
    );
    expect((await invoke(root, ["apply", "--harness", "codex"])).code).toBe(0);
    expect(
      (await invoke(root, ["apply", "--harness", "antigravity"])).code,
    ).toBe(0);

    const skill = join(root, ".agents/skills/loom-project-start/SKILL.md");
    expect(await exists(skill)).toBe(true);
    expect((await invoke(root, ["remove", "--harness", "opencode"])).code).toBe(
      0,
    );
    expect(await exists(skill)).toBe(true);
    expect(await exists(join(root, ".loom/project.json"))).toBe(true);
    expect(
      JSON.parse(await readFile(join(root, ".loom/workflow.json"), "utf8")),
    ).toMatchObject({ harnesses: { codex: {} } });
    expect(
      JSON.parse(
        await readFile(join(root, ".loom/capabilities.lock.json"), "utf8"),
      ),
    ).toMatchObject({ harnesses: { codex: [] } });

    expect((await invoke(root, ["remove", "--harness", "codex"])).code).toBe(0);
    expect(await exists(skill)).toBe(true);
    expect(
      (await invoke(root, ["remove", "--harness", "antigravity"])).code,
    ).toBe(0);
    expect(await exists(skill)).toBe(false);
    expect(await exists(join(root, ".loom/project.json"))).toBe(false);
  });

  it("applies Flutter with approval and an exact upstream revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-cli-flutter-"));
    roots.push(root);
    await writeFile(
      join(root, "pubspec.yaml"),
      "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );

    const withoutApproval = await invoke(root, [
      "apply",
      "--harness",
      "opencode",
    ]);
    const result = await invoke(root, [
      "apply",
      "--harness",
      "opencode",
      "--approve",
      "builtin:flutter-package-intelligence",
    ]);
    expect(result.code, result.stderr).toBe(0);
    const lock = JSON.parse(
      await readFile(join(root, ".loom/capabilities.lock.json"), "utf8"),
    ) as { entries: Array<{ id: string; version: string }> };
    const doctor = await invoke(root, ["doctor", "--harness", "opencode"]);

    expect(withoutApproval.code).toBe(3);
    expect(withoutApproval.stderr).toContain("approval.required");
    expect(result.code).toBe(0);
    expect(await exists(join(root, "opencode.json"))).toBe(true);
    expect(lock.entries).toContainEqual(
      expect.objectContaining({
        id: "builtin:flutter-package-intelligence",
        version: "0.9.0+skills.1.0.0",
      }),
    );
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain("  ok");
  });

  it("refuses to lock unresolved built-in recommendations", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "react-native": "0.76.0" } }),
    );

    const result = await invoke(root, ["apply", "--harness", "opencode"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("plan.unresolved-version");
    expect(await exists(join(root, "opencode.json"))).toBe(false);
  });

  it("returns a usage exit code for unknown commands", async () => {
    const root = await fixture();
    const result = await invoke(root, ["wat"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage.unknown-command");
  });

  it("never emits secret values", async () => {
    const root = await fixture();
    const path = join(root, "package.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({ dependencies: { api_token: "do-not-print-this" } })}\n`,
      "utf8",
    );

    const result = await invoke(root, ["detect", "--json"]);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("do-not-print-this");
    expect(result.stdout).toContain("[REDACTED]");
  });

  it.each(["opencode", "codex", "claude", "omp", "antigravity"])(
    "accepts the audited web setup intent for %s",
    async (harness) => {
      const root = await fixture();
      const browser = join(root, "browser");
      await writeFile(browser, "browser");
      await chmod(browser, 0o700);
      const options: RunCliOptions = {
        resolveExecutable: async () => process.execPath,
        env: {
          ...process.env,
          HOME: root,
          XDG_STATE_HOME: join(root, ".user-state"),
          AGENT_BROWSER_EXECUTABLE_PATH: browser,
        },
      };
      expect(
        (await invoke(root, ["connect", "--harness", harness], options)).code,
      ).toBe(0);
      const intent = encodeSetupIntent({
        schemaVersion: 1,
        root,
        projectFingerprint: setupFingerprint(root),
        harness,
        mode: "apply",
        requestedCapabilities: await setupCapabilities(root),
        selectedSkills: [],
        selectionRationale: "Web recipe has no skills",
      });
      const result = await invoke(
        root,
        ["setup", "--dry-run", "--intent", intent],
        options,
      );

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("agent-browser@0.34.0 + opensrc@0.7.3");
    },
  );

  it("keeps web tools until the last harness consumer is removed", async () => {
    const root = await fixture();
    const browser = join(root, "browser");
    await writeFile(browser, "browser");
    await chmod(browser, 0o700);
    const webInstaller = new WebAgentIntelligenceInstaller(async (request) => {
      if (request.args[0] === "install")
        await writeFile(
          join(request.cwd, "package-lock.json"),
          JSON.stringify({
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: {
                  "agent-browser": "0.34.0",
                  opensrc: "0.7.3",
                },
              },
              "node_modules/agent-browser": {
                version: "0.34.0",
                integrity:
                  "sha512-eR6Ey4I/DMs9zZ60b3ziV6pgLIgpxXWzggr3dfFbtskLmeXPJAgXCIIwVL4PihVYJqEUpvWgUKlZ2CIjY1u44g==",
              },
              "node_modules/opensrc": {
                version: "0.7.3",
                integrity:
                  "sha512-REvdS9CG2q1KW6fiyLQkZgrhvNykARJCbigDF7vJOskGwqamwF74OzHRbgblZ7YlRkaLc7CTOsUMfnxw+NW83A==",
              },
            },
          }),
        );
      if (request.args[0] === "ci") {
        await mkdir(join(request.cwd, "node_modules/agent-browser/bin"), {
          recursive: true,
        });
        await mkdir(join(request.cwd, "node_modules/opensrc/bin"), {
          recursive: true,
        });
        await writeFile(
          join(
            request.cwd,
            `node_modules/agent-browser/bin/agent-browser-${process.platform}-${process.arch}`,
          ),
          "agent",
        );
        await writeFile(
          join(request.cwd, "node_modules/opensrc/bin/opensrc.js"),
          "opensrc",
        );
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const webPlan = await webInstaller.plan(
      root,
      process.execPath,
      process.execPath,
      browser,
    );
    const webApplied = await webInstaller.applyTransaction(webPlan);
    expect(webApplied.diagnostics).toEqual([]);
    await webInstaller.commit(webApplied.rollbackToken!);
    expect((await invoke(root, ["connect", "--harness", "codex"])).code).toBe(
      0,
    );
    expect((await invoke(root, ["connect", "--harness", "claude"])).code).toBe(
      0,
    );
    await mkdir(join(root, ".loom"), { recursive: true });
    await writeFile(
      join(root, ".loom/workflow.json"),
      JSON.stringify({
        schemaVersion: 1,
        version: "0.2.2",
        harnesses: { codex: {}, claude: {} },
      }),
    );

    const options = { webInstallerFactory: () => webInstaller };
    expect(
      (await invoke(root, ["remove", "--harness", "codex"], options)).code,
    ).toBe(0);
    expect(await exists(webPlan.toolRoot)).toBe(true);
    expect(
      (await invoke(root, ["remove", "--harness", "claude"], options)).code,
    ).toBe(0);
    expect(await exists(webPlan.toolRoot)).toBe(false);
  });

  it("keeps web tools when final harness removal fails", async () => {
    const root = await fixture();
    const browser = join(root, "browser");
    await writeFile(browser, "browser");
    await chmod(browser, 0o700);
    const webInstaller = new WebAgentIntelligenceInstaller(async (request) => {
      if (request.args[0] === "install")
        await writeFile(
          join(request.cwd, "package-lock.json"),
          JSON.stringify({
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: {
                  "agent-browser": "0.34.0",
                  opensrc: "0.7.3",
                },
              },
              "node_modules/agent-browser": {
                version: "0.34.0",
                integrity:
                  "sha512-eR6Ey4I/DMs9zZ60b3ziV6pgLIgpxXWzggr3dfFbtskLmeXPJAgXCIIwVL4PihVYJqEUpvWgUKlZ2CIjY1u44g==",
              },
              "node_modules/opensrc": {
                version: "0.7.3",
                integrity:
                  "sha512-REvdS9CG2q1KW6fiyLQkZgrhvNykARJCbigDF7vJOskGwqamwF74OzHRbgblZ7YlRkaLc7CTOsUMfnxw+NW83A==",
              },
            },
          }),
        );
      if (request.args[0] === "ci") {
        await mkdir(join(request.cwd, "node_modules/agent-browser/bin"), {
          recursive: true,
        });
        await mkdir(join(request.cwd, "node_modules/opensrc/bin"), {
          recursive: true,
        });
        await writeFile(
          join(
            request.cwd,
            `node_modules/agent-browser/bin/agent-browser-${process.platform}-${process.arch}`,
          ),
          "agent",
        );
        await writeFile(
          join(request.cwd, "node_modules/opensrc/bin/opensrc.js"),
          "opensrc",
        );
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const webPlan = await webInstaller.plan(
      root,
      process.execPath,
      process.execPath,
      browser,
    );
    const webApplied = await webInstaller.applyTransaction(webPlan);
    await webInstaller.commit(webApplied.rollbackToken!);
    expect((await invoke(root, ["connect", "--harness", "omp"])).code).toBe(0);
    await writeFile(join(root, ".omp/mcp.json"), "{}");

    expect(
      (
        await invoke(root, ["remove", "--harness", "omp"], {
          webInstallerFactory: () => webInstaller,
        })
      ).code,
    ).toBe(1);
    expect(await exists(webPlan.toolRoot)).toBe(true);
  });

  it("requires Node and npm before planning web setup", async () => {
    const root = await fixture();
    expect((await invoke(root, ["connect", "--harness", "codex"])).code).toBe(
      0,
    );
    const intent = encodeSetupIntent({
      schemaVersion: 1,
      root,
      projectFingerprint: setupFingerprint(root),
      harness: "codex",
      mode: "apply",
      requestedCapabilities: await setupCapabilities(root),
      selectedSkills: [],
      selectionRationale: "Web recipe has no skills",
    });
    const result = await invoke(root, ["setup", "--intent", intent], {
      resolveExecutable: async () => undefined,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("setup.node-unavailable");
  });

  it("rejects Flutter package intelligence outside OpenCode before installation", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "pubspec.yaml"),
      "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    expect((await invoke(root, ["connect", "--harness", "codex"])).code).toBe(
      0,
    );
    const intent = encodeSetupIntent({
      schemaVersion: 1,
      root,
      projectFingerprint: setupFingerprint(root),
      harness: "codex",
      mode: "apply",
      requestedCapabilities: await setupCapabilities(root),
      selectedSkills: [],
      selectionRationale: "No package skill is relevant to this test",
    });

    const result = await invoke(root, [
      "setup",
      "--dry-run",
      "--intent",
      intent,
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("setup.unsupported-harness");
    expect(result.stderr).toContain(
      "Flutter/Dart package intelligence is supported on OpenCode only.",
    );
  });
});
