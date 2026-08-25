import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WEB_AGENT_INTELLIGENCE_RECIPE,
  WebAgentIntelligenceInstaller,
  webAgentIntelligenceResources,
} from "./web-agent-intelligence.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "loom-web-"));
  roots.push(root);
  const browser = join(root, "browser");
  await writeFile(browser, "browser");
  await chmod(browser, 0o700);
  return { root, browser };
}
const lock = (extra = "") =>
  `${JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { "agent-browser": "0.34.0", opensrc: "0.7.3" } }, "node_modules/agent-browser": { version: "0.34.0", integrity: WEB_AGENT_INTELLIGENCE_RECIPE.agentBrowser.integrity }, "node_modules/opensrc": { version: "0.7.3", integrity: WEB_AGENT_INTELLIGENCE_RECIPE.opensrc.integrity }, ...(extra ? { [extra]: { version: "1.0.0", integrity: "sha512-injected" } } : {}) } })}\n`;
async function installBinaries(cwd: string) {
  await mkdir(join(cwd, "node_modules/agent-browser/bin"), { recursive: true });
  await mkdir(join(cwd, "node_modules/opensrc/bin"), { recursive: true });
  await writeFile(
    join(
      cwd,
      `node_modules/agent-browser/bin/agent-browser-${process.platform}-${process.arch}`,
    ),
    "agent",
  );
  await writeFile(join(cwd, "node_modules/opensrc/bin/opensrc.js"), "opensrc");
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("WebAgentIntelligenceInstaller", () => {
  it("requires a real executable browser and exposes its exact path to every harness resource", async () => {
    const { root, browser } = await fixture();
    const installer = new WebAgentIntelligenceInstaller(async (request) => {
      if (request.args[0] === "ci") await installBinaries(request.cwd);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const missing = await installer.plan(
      root,
      process.execPath,
      process.execPath,
    );
    expect(missing.diagnostics.map(({ code }) => code)).toContain(
      "web.browser-prerequisite",
    );
    const plan = await installer.plan(
      root,
      process.execPath,
      process.execPath,
      browser,
    );
    expect(plan.install.args).toEqual(
      expect.arrayContaining([
        "--ignore-scripts",
        "--package-lock-only",
        "agent-browser@0.34.0",
        "opensrc@0.7.3",
      ]),
    );
    expect(
      webAgentIntelligenceResources(root, browser).mcp.env
        .AGENT_BROWSER_EXECUTABLE_PATH,
    ).toBe(browser);
    expect(webAgentIntelligenceResources(root, browser).mcp.command).toBe(
      join(
        plan.toolRoot,
        `node_modules/agent-browser/bin/agent-browser-${process.platform}-${process.arch}`,
      ),
    );
  });

  it("executes a hash-bound npm shell wrapper directly", async () => {
    const { root, browser } = await fixture();
    const node = join(root, "node");
    const npm = join(root, "npm");
    const npmCli = join(root, "npm-cli.js");
    await symlink(process.execPath, node);
    await writeFile(
      npmCli,
      'if (!["install", "ci"].includes(process.argv[2])) process.exit(1);\n',
    );
    await writeFile(
      npm,
      '#!/bin/sh\nbasedir=$(dirname "$0")\nexec "$basedir/node" "$basedir/npm-cli.js" "$@"\n',
    );
    await chmod(npm, 0o700);
    const installer = new WebAgentIntelligenceInstaller(async (request) => {
      const result = await new Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        const child = spawn(request.command, [...request.args], {
          cwd: request.cwd,
          env: request.env,
          shell: request.shell,
          stdio: "ignore",
        });
        child.once("error", (error) =>
          resolve({ exitCode: 1, stdout: "", stderr: error.message }),
        );
        child.once("close", (exitCode) =>
          resolve({ exitCode: exitCode ?? 1, stdout: "", stderr: "" }),
        );
      });
      if (result.exitCode === 0 && request.args[0] === "install")
        await writeFile(join(request.cwd, "package-lock.json"), lock());
      if (result.exitCode === 0 && request.args[0] === "ci")
        await installBinaries(request.cwd);
      return result;
    });
    const plan = await installer.plan(root, node, npm, browser);

    expect(plan.install.command).toBe(npm);
    expect(plan.install.command).not.toBe(node);
    expect((await installer.applyTransaction(plan)).diagnostics).toEqual([]);
  });

  it("rejects browser paths outside the project, missing, non-executable, symlinked, or below symlinked ancestors", async () => {
    const { root, browser } = await fixture();
    const installer = new WebAgentIntelligenceInstaller(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const external = join(tmpdir(), `loom-browser-${Date.now()}`);
    await writeFile(external, "browser");
    await chmod(external, 0o700);
    const nonExecutable = join(root, "not-executable");
    await writeFile(nonExecutable, "browser");
    const linked = join(root, "linked-browser");
    const browserDirectory = join(root, "browser-directory");
    await mkdir(browserDirectory);
    await symlink(browserDirectory, join(root, "browser-link"));
    await symlink(browser, linked);
    const paths = [
      external,
      join(root, "missing"),
      nonExecutable,
      linked,
      join(root, "browser-link", "browser"),
    ];

    for (const path of paths) {
      const plan = await installer.plan(
        root,
        process.execPath,
        process.execPath,
        path,
      );
      expect(plan.diagnostics.map(({ code }) => code)).toContain(
        "web.invalid-browser",
      );
    }
    await rm(external, { force: true });
  });

  it("rejects tool paths with symlinked ancestors before applying", async () => {
    const { root, browser } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "loom-web-outside-"));
    roots.push(outside);
    await mkdir(join(root, ".loom"));
    await symlink(outside, join(root, ".loom", "tools"));
    const installer = new WebAgentIntelligenceInstaller(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));

    const plan = await installer.plan(
      root,
      process.execPath,
      process.execPath,
      browser,
    );
    expect(plan.diagnostics.map(({ code }) => code)).toContain(
      "web.unsafe-tool-path",
    );
    expect((await installer.applyTransaction(plan)).diagnostics[0]?.code).toBe(
      "web.unsafe-tool-path",
    );
  });

  it("rejects injected package-lock nodes and restores the exact prior tool state", async () => {
    const { root, browser } = await fixture();
    let injected = true;
    const installer = new WebAgentIntelligenceInstaller(async (request) => {
      if (request.args[0] === "install")
        await writeFile(
          join(request.cwd, "package-lock.json"),
          lock(injected ? "node_modules/evil" : ""),
        );
      if (request.args[0] === "ci") await installBinaries(request.cwd);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const plan = await installer.plan(
      root,
      process.execPath,
      process.execPath,
      browser,
    );
    expect((await installer.applyTransaction(plan)).diagnostics[0]?.code).toBe(
      "web.install-failed",
    );
    injected = false;
    const applied = await installer.applyTransaction(plan);
    expect(applied.diagnostics).toEqual([]);
    const before = await readFile(
      join(plan.toolRoot, "runtime-manifest.json"),
      "utf8",
    );
    await installer.rollback(applied.rollbackToken!);
    expect(
      await readFile(
        join(plan.toolRoot, "runtime-manifest.json"),
        "utf8",
      ).catch(() => ""),
    ).toBe("");
    expect(before).toContain(browser);
  });

  it("accepts the audited closure, rejects an injected transitive node, and detects binary tampering", async () => {
    const { root, browser } = await fixture();
    const installer = new WebAgentIntelligenceInstaller(async (request) => {
      if (request.args[0] === "install")
        await writeFile(join(request.cwd, "package-lock.json"), lock());
      if (request.args[0] === "ci") await installBinaries(request.cwd);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const plan = await installer.plan(
      root,
      process.execPath,
      process.execPath,
      browser,
    );
    const applied = await installer.applyTransaction(plan);
    expect(applied.diagnostics).toEqual([]);
    expect(await installer.verify(root)).toEqual([]);
    await installer.commit(applied.rollbackToken!);
    await writeFile(
      join(
        plan.toolRoot,
        `node_modules/agent-browser/bin/agent-browser-${process.platform}-${process.arch}`,
      ),
      "tampered",
    );
    expect((await installer.verify(root))[0]?.code).toBe(
      "web.modified-browser",
    );
    await writeFile(
      join(
        plan.toolRoot,
        `node_modules/agent-browser/bin/agent-browser-${process.platform}-${process.arch}`,
      ),
      "agent",
    );
    await rm(browser);
    expect((await installer.verify(root))[0]?.code).toBe(
      "web.modified-browser",
    );
    await writeFile(browser, "browser");
    await chmod(browser, 0o700);
    await rm(join(plan.toolRoot, "node_modules/opensrc/bin/opensrc.js"));
    expect((await installer.verify(root))[0]?.code).toBe(
      "web.modified-browser",
    );
    expect((await installer.uninstall(root))[0]?.code).toBe(
      "web.modified-browser",
    );
  });

  it("serializes apply transactions until rollback releases the project lock", async () => {
    const { root, browser } = await fixture();
    const installer = new WebAgentIntelligenceInstaller(async (request) => {
      if (request.args[0] === "install")
        await writeFile(join(request.cwd, "package-lock.json"), lock());
      if (request.args[0] === "ci") await installBinaries(request.cwd);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const plan = await installer.plan(
      root,
      process.execPath,
      process.execPath,
      browser,
    );
    const first = await installer.applyTransaction(plan);
    expect((await installer.applyTransaction(plan)).diagnostics[0]?.code).toBe(
      "web.transaction-active",
    );
    await installer.rollback(first.rollbackToken!);
  });

  it("refuses and preserves an unowned existing tool root", async () => {
    const { root, browser } = await fixture();
    const installer = new WebAgentIntelligenceInstaller(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const plan = await installer.plan(
      root,
      process.execPath,
      process.execPath,
      browser,
    );
    await mkdir(plan.toolRoot, { recursive: true });
    await writeFile(join(plan.toolRoot, "user-owned"), "keep");
    expect((await installer.applyTransaction(plan)).diagnostics[0]?.code).toBe(
      "web.unowned-tool-root",
    );
    expect(await readFile(join(plan.toolRoot, "user-owned"), "utf8")).toBe(
      "keep",
    );
  });

  it("refuses execution when an approved executable changes", async () => {
    const { root, browser } = await fixture();
    const node = join(root, "node");
    const npm = join(root, "npm");
    await writeFile(node, "node");
    await writeFile(npm, "npm");
    await chmod(node, 0o700);
    await chmod(npm, 0o700);
    const installer = new WebAgentIntelligenceInstaller(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const plan = await installer.plan(root, node, npm, browser);
    await writeFile(node, "swapped");
    expect((await installer.applyTransaction(plan)).diagnostics[0]?.code).toBe(
      "web.executable-drift",
    );
  });
});
