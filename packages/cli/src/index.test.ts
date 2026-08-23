import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./index.js";

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

async function invoke(
  root: string,
  args: string[],
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const stdout = new BufferWriter();
  const stderr = new BufferWriter();
  const code = await runCli(args, {
    cwd: root,
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
      version: "0.1.0",
      command: "detect",
      ok: true,
    });
    expect(plan).toMatchObject({
      schemaVersion: 1,
      version: "0.1.0",
      command: "plan",
      ok: true,
    });
    expect(await exists(join(root, ".loom"))).toBe(false);
  });

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
      version: "0.1.0",
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

  it("refuses to lock unresolved built-in recommendations", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-cli-flutter-"));
    roots.push(root);
    await writeFile(
      join(root, "pubspec.yaml"),
      "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
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
});
