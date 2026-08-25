import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  acquireInstallerTransactionLock,
  type InstallerTransactionLock,
} from "./transaction-lock.js";

export const WEB_AGENT_INTELLIGENCE_RECIPE = Object.freeze({
  candidate: "builtin:web-agent-intelligence" as const,
  toolPath: ".loom/tools/web-agent-intelligence" as const,
  agentBrowser: {
    package: "agent-browser" as const,
    version: "0.34.0" as const,
    integrity:
      "sha512-eR6Ey4I/DMs9zZ60b3ziV6pgLIgpxXWzggr3dfFbtskLmeXPJAgXCIIwVL4PihVYJqEUpvWgUKlZ2CIjY1u44g==" as const,
  },
  opensrc: {
    package: "opensrc" as const,
    version: "0.7.3" as const,
    integrity:
      "sha512-REvdS9CG2q1KW6fiyLQkZgrhvNykARJCbigDF7vJOskGwqamwF74OzHRbgblZ7YlRkaLc7CTOsUMfnxw+NW83A==" as const,
  },
});

const APPROVED_PACKAGES = Object.freeze({
  "node_modules/agent-browser": {
    version: WEB_AGENT_INTELLIGENCE_RECIPE.agentBrowser.version,
    integrity: WEB_AGENT_INTELLIGENCE_RECIPE.agentBrowser.integrity,
  },
  "node_modules/opensrc": {
    version: WEB_AGENT_INTELLIGENCE_RECIPE.opensrc.version,
    integrity: WEB_AGENT_INTELLIGENCE_RECIPE.opensrc.integrity,
  },
});
const ROOT_DEPENDENCIES = Object.freeze({
  "agent-browser": WEB_AGENT_INTELLIGENCE_RECIPE.agentBrowser.version,
  opensrc: WEB_AGENT_INTELLIGENCE_RECIPE.opensrc.version,
});
const AGENT_BROWSER_PLATFORM = `${process.platform}-${
  process.platform === "win32" && process.arch === "arm64"
    ? "x64"
    : process.arch
}${process.platform === "win32" ? ".exe" : ""}`;
const RUNTIME_BINARIES = Object.freeze({
  agentBrowser: `node_modules/agent-browser/bin/agent-browser-${AGENT_BROWSER_PLATFORM}`,
  opensrc: "node_modules/opensrc/bin/opensrc.js",
});

export interface WebToolDiagnostic {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
}
export interface WebAgentIntelligenceResources {
  mcp: {
    name: "agent-browser";
    command: string;
    args: readonly string[];
    env: Readonly<Record<string, string>>;
  };
  skill: { name: string; content: string };
}
export interface WebToolProcess {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
}
export interface WebToolProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export interface WebToolPlan {
  root: string;
  toolRoot: string;
  manifest: string;
  install: WebToolProcess;
  bindings?: {
    node: { path: string; sha256: string };
    npm: { path: string; sha256: string };
  };
  browser?: { path: string; sha256: string };
  diagnostics: readonly WebToolDiagnostic[];
}
export interface WebToolRollbackToken {
  root: string;
  backup?: string;
  created: boolean;
}
export type WebToolRunner = (
  request: WebToolProcess,
) => Promise<WebToolProcessResult>;

const digest = (value: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const manifest = () =>
  `${JSON.stringify({ lockfileVersion: 1, recipe: WEB_AGENT_INTELLIGENCE_RECIPE, approvedPackages: APPROVED_PACKAGES, launch: { agentBrowser: `${RUNTIME_BINARIES.agentBrowser} mcp --tools core`, opensrc: "node_modules/opensrc/bin/opensrc.js --modify=false" } }, null, 2)}\n`;
const environment = (toolRoot: string): NodeJS.ProcessEnv => ({
  HOME: join(toolRoot, ".home"),
  npm_config_cache: join(toolRoot, ".npm-cache"),
  XDG_CACHE_HOME: join(toolRoot, ".xdg/cache"),
  XDG_CONFIG_HOME: join(toolRoot, ".xdg/config"),
  XDG_DATA_HOME: join(toolRoot, ".xdg/data"),
  XDG_STATE_HOME: join(toolRoot, ".xdg/state"),
  npm_config_ignore_scripts: "true",
  npm_config_audit: "false",
  npm_config_fund: "false",
});

function isContained(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

async function hasSafeDirectoryAncestors(
  root: string,
  path: string,
): Promise<boolean> {
  if (!isContained(root, path)) return false;
  let current = root;
  const rootState = await lstat(current).catch(() => undefined);
  if (!rootState?.isDirectory() || rootState.isSymbolicLink()) return false;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    const state = await lstat(current).catch(() => undefined);
    if (state === undefined) return true;
    if (!state.isDirectory() || state.isSymbolicLink()) return false;
  }
  return true;
}

export function webAgentIntelligenceResources(
  root: string,
  browserPath: string,
): WebAgentIntelligenceResources {
  const toolRoot = resolve(root, WEB_AGENT_INTELLIGENCE_RECIPE.toolPath);
  return {
    mcp: {
      name: "agent-browser",
      command: join(toolRoot, RUNTIME_BINARIES.agentBrowser),
      args: ["mcp", "--tools", "core"],
      env: {
        AGENT_BROWSER_EXECUTABLE_PATH: browserPath,
        AGENT_BROWSER_SOCKET_DIR: join(toolRoot, ".agent-browser/socket"),
      },
    },
    skill: {
      name: "loom-web-agent-intelligence",
      content:
        "Use the project-local opensrc binary only with `--modify=false`. Do not use npx or modify source through OpenSrc.\n",
    },
  };
}

async function executableBinding(path: string | undefined) {
  if (!path || !isAbsolute(path) || resolve(path) !== path) return undefined;
  const state = await lstat(path).catch(() => undefined);
  if (
    !state ||
    (!state.isFile() && !state.isSymbolicLink()) ||
    !(state.mode & 0o111)
  )
    return undefined;
  if (
    await access(path, 1)
      .then(() => false)
      .catch(() => true)
  )
    return undefined;
  return { path, sha256: digest(await readFile(path)) };
}

function validLock(content: string): boolean {
  try {
    const lock = JSON.parse(content) as {
      lockfileVersion?: unknown;
      packages?: Record<
        string,
        { version?: unknown; integrity?: unknown; dependencies?: unknown }
      >;
    };
    const packages = lock.packages;
    if (
      lock.lockfileVersion !== 3 ||
      !packages ||
      Object.keys(packages).length !==
        Object.keys(APPROVED_PACKAGES).length + 1 ||
      !Object.keys(packages).every(
        (key) => key === "" || key in APPROVED_PACKAGES,
      ) ||
      !Object.entries(ROOT_DEPENDENCIES).every(
        ([name, version]) =>
          (packages[""]?.dependencies as Record<string, unknown> | undefined)?.[
            name
          ] === version,
      ) ||
      Object.keys((packages[""]?.dependencies as Record<string, unknown>) ?? {})
        .length !== Object.keys(ROOT_DEPENDENCIES).length
    )
      return false;
    return Object.entries(APPROVED_PACKAGES).every(
      ([path, approved]) =>
        packages[path]?.version === approved.version &&
        packages[path]?.integrity === approved.integrity,
    );
  } catch {
    return false;
  }
}

export class WebAgentIntelligenceInstaller {
  readonly #transactions = new WeakMap<
    WebToolRollbackToken,
    InstallerTransactionLock
  >();
  constructor(private readonly runner: WebToolRunner) {}
  async plan(
    root: string,
    nodePath?: string,
    npmPath?: string,
    browserPath = process.env.AGENT_BROWSER_EXECUTABLE_PATH,
  ): Promise<WebToolPlan> {
    const projectRoot = resolve(root);
    const toolRoot = resolve(
      projectRoot,
      WEB_AGENT_INTELLIGENCE_RECIPE.toolPath,
    );
    const diagnostics: WebToolDiagnostic[] = [];
    if (!(await hasSafeDirectoryAncestors(projectRoot, projectRoot)))
      diagnostics.push({
        level: "error",
        code: "web.invalid-root",
        message: "Project root must be a real directory",
      });
    const node = await executableBinding(nodePath);
    const npm = await executableBinding(npmPath);
    if (!node || !npm)
      diagnostics.push({
        level: "error",
        code: "web.node-unavailable",
        message: "The web recipe requires installed Node.js and npm",
      });
    if (!(await hasSafeDirectoryAncestors(projectRoot, toolRoot)))
      diagnostics.push({
        level: "error",
        code: "web.unsafe-tool-path",
        message: "Tool path is not a real directory",
      });
    let browser: WebToolPlan["browser"];
    if (!browserPath)
      diagnostics.push({
        level: "error",
        code: "web.browser-prerequisite",
        message:
          "Set AGENT_BROWSER_EXECUTABLE_PATH to an existing real browser executable; Loom never downloads browsers.",
      });
    else {
      const path = resolve(browserPath);
      const browserState = await lstat(path).catch(() => undefined);
      if (
        !isAbsolute(browserPath) ||
        path !== browserPath ||
        !(await hasSafeDirectoryAncestors(projectRoot, resolve(path, ".."))) ||
        !browserState?.isFile() ||
        browserState.isSymbolicLink()
      )
        diagnostics.push({
          level: "error",
          code: "web.invalid-browser",
          message:
            "AGENT_BROWSER_EXECUTABLE_PATH must be a real non-symlink executable file",
        });
      else if (!(browserState.mode & 0o111))
        diagnostics.push({
          level: "error",
          code: "web.invalid-browser",
          message: "AGENT_BROWSER_EXECUTABLE_PATH is not executable",
        });
      else if (
        await access(path, 1)
          .then(() => false)
          .catch(() => true)
      )
        diagnostics.push({
          level: "error",
          code: "web.invalid-browser",
          message: "AGENT_BROWSER_EXECUTABLE_PATH is not executable",
        });
      else browser = { path, sha256: digest(await readFile(path)) };
    }
    return Object.freeze({
      root: projectRoot,
      toolRoot,
      manifest: manifest(),
      install: {
        command: npm?.path ?? "npm",
        args: [
          "install",
          "--ignore-scripts",
          "--package-lock-only",
          "--save-exact",
          "agent-browser@0.34.0",
          "opensrc@0.7.3",
        ],
        cwd: toolRoot,
        env: environment(toolRoot),
        shell: false as const,
      },
      ...(browser === undefined ? {} : { browser }),
      ...(node === undefined || npm === undefined
        ? {}
        : { bindings: { node, npm } }),
      diagnostics: Object.freeze(diagnostics),
    });
  }
  async applyTransaction(plan: WebToolPlan): Promise<{
    diagnostics: WebToolDiagnostic[];
    rollbackToken?: WebToolRollbackToken;
  }> {
    if (plan.diagnostics.some(({ level }) => level === "error"))
      return { diagnostics: [...plan.diagnostics] };
    if (!(await hasSafeDirectoryAncestors(plan.root, plan.toolRoot)))
      return {
        diagnostics: [
          {
            level: "error",
            code: "web.unsafe-tool-path",
            message: "Tool path contains a symlink or escapes the project root",
          },
        ],
      };
    if (
      plan.bindings === undefined ||
      (await executableBinding(plan.bindings.node.path))?.sha256 !==
        plan.bindings.node.sha256 ||
      (await executableBinding(plan.bindings.npm.path))?.sha256 !==
        plan.bindings.npm.sha256
    )
      return {
        diagnostics: [
          {
            level: "error",
            code: "web.executable-drift",
            message:
              "Node.js or npm changed after setup review; generate a new setup command",
          },
        ],
      };
    let transaction: InstallerTransactionLock;
    try {
      transaction = await acquireInstallerTransactionLock(plan.root);
    } catch (error) {
      return {
        diagnostics: [
          {
            level: "error",
            code: "web.transaction-active",
            message: (error as Error).message,
          },
        ],
      };
    }
    let existing = false;
    let backup = "";
    try {
      const parent = resolve(plan.toolRoot, "..");
      await mkdir(parent, { recursive: true, mode: 0o700 });
      existing =
        (await lstat(plan.toolRoot).catch(() => undefined)) !== undefined;
      if (existing) {
        const lock = await readFile(
          join(plan.toolRoot, "loom-web-tools.lock.json"),
          "utf8",
        ).catch(() => undefined);
        if (
          lock !== manifest() ||
          (await this.verify(plan.root)).length !== 0
        ) {
          await transaction.release().catch(() => undefined);
          return {
            diagnostics: [
              {
                level: "error",
                code: "web.unowned-tool-root",
                message:
                  "Existing web tool root is not a complete verified Loom-owned installation",
              },
            ],
          };
        }
      }
      backup = `${plan.toolRoot}.rollback-${Date.now()}`;
      if (existing) await rename(plan.toolRoot, backup);
      await mkdir(plan.toolRoot, { recursive: true, mode: 0o700 });
      await rm(plan.install.env.npm_config_cache!, {
        recursive: true,
        force: true,
      });
      await writeFile(
        join(plan.toolRoot, "package.json"),
        `${JSON.stringify({ private: true, name: "loom-web-agent-intelligence", dependencies: { "agent-browser": WEB_AGENT_INTELLIGENCE_RECIPE.agentBrowser.version, opensrc: WEB_AGENT_INTELLIGENCE_RECIPE.opensrc.version } })}\n`,
        { mode: 0o600 },
      );
      const result = await this.runner(plan.install);
      if (result.exitCode !== 0)
        throw new Error(result.stderr.trim() || "npm install failed");
      const lock = await readFile(
        join(plan.toolRoot, "package-lock.json"),
        "utf8",
      );
      if (!validLock(lock))
        throw new Error(
          "Generated npm lock contains an unreviewed package or integrity",
        );
      const installed = await this.runner({
        ...plan.install,
        args: ["ci", "--ignore-scripts"],
      });
      if (installed.exitCode !== 0)
        throw new Error(installed.stderr.trim() || "npm ci failed");
      const binaries = await this.#binaries(plan.toolRoot);
      await writeFile(
        join(plan.toolRoot, "loom-web-tools.lock.json"),
        plan.manifest,
        { mode: 0o600 },
      );
      await writeFile(
        join(plan.toolRoot, "runtime-manifest.json"),
        `${JSON.stringify({ browser: plan.browser, binaries }, null, 2)}\n`,
        { mode: 0o600 },
      );
      const rollbackToken = {
        root: plan.root,
        ...(existing ? { backup } : {}),
        created: !existing,
      };
      this.#transactions.set(rollbackToken, transaction);
      return {
        diagnostics: [],
        rollbackToken,
      };
    } catch (error) {
      await rm(plan.toolRoot, { recursive: true, force: true });
      if (existing) await rename(backup, plan.toolRoot).catch(() => undefined);
      await transaction.release().catch(() => undefined);
      return {
        diagnostics: [
          {
            level: "error",
            code: "web.install-failed",
            message: (error as Error).message,
          },
        ],
      };
    }
  }
  async commit(token: WebToolRollbackToken): Promise<WebToolDiagnostic[]> {
    try {
      if (token.backup)
        await rm(token.backup, { recursive: true, force: true });
      return [];
    } finally {
      const transaction = this.#transactions.get(token);
      this.#transactions.delete(token);
      await transaction?.release().catch(() => undefined);
    }
  }
  async rollback(token: WebToolRollbackToken): Promise<WebToolDiagnostic[]> {
    const toolRoot = resolve(
      token.root,
      WEB_AGENT_INTELLIGENCE_RECIPE.toolPath,
    );
    if (!(await hasSafeDirectoryAncestors(token.root, toolRoot))) {
      const transaction = this.#transactions.get(token);
      this.#transactions.delete(token);
      await transaction?.release().catch(() => undefined);
      return [
        {
          level: "error",
          code: "web.unsafe-tool-path",
          message: "Tool path contains a symlink or escapes the project root",
        },
      ];
    }
    try {
      await rm(toolRoot, { recursive: true, force: true });
      if (token.backup) await rename(token.backup, toolRoot);
      return [];
    } finally {
      const transaction = this.#transactions.get(token);
      this.#transactions.delete(token);
      await transaction?.release().catch(() => undefined);
    }
  }
  async #binaries(toolRoot: string) {
    const values: Record<string, { path: string; sha256: string }> = {};
    for (const [name, path] of Object.entries(RUNTIME_BINARIES)) {
      const absolutePath = resolve(toolRoot, path);
      const state = await lstat(absolutePath);
      if (
        !(await hasSafeDirectoryAncestors(
          toolRoot,
          resolve(absolutePath, ".."),
        )) ||
        !state.isFile() ||
        state.isSymbolicLink()
      )
        throw new Error(`Required ${name} binary is missing or unsafe`);
      values[name] = { path, sha256: digest(await readFile(absolutePath)) };
    }
    return values;
  }
  async verify(root: string): Promise<WebToolDiagnostic[]> {
    const toolRoot = resolve(root, WEB_AGENT_INTELLIGENCE_RECIPE.toolPath);
    const lock = await readFile(
      join(toolRoot, "loom-web-tools.lock.json"),
      "utf8",
    ).catch(() => undefined);
    if (lock === undefined)
      return [
        {
          level: "warning",
          code: "web.not-installed",
          message: "Web agent intelligence is not installed",
        },
      ];
    if (lock !== manifest())
      return [
        {
          level: "error",
          code: "web.modified-lock",
          message: "Web tool lock manifest was modified",
        },
      ];
    const packageLock = await readFile(
      join(toolRoot, "package-lock.json"),
      "utf8",
    ).catch(() => "");
    if (!validLock(packageLock))
      return [
        {
          level: "error",
          code: "web.integrity-mismatch",
          message:
            "Web package lock contains an unreviewed package or integrity",
        },
      ];
    try {
      const runtime = JSON.parse(
        await readFile(join(toolRoot, "runtime-manifest.json"), "utf8"),
      ) as {
        browser?: { path?: string; sha256?: string };
        binaries?: Record<string, { path?: string; sha256?: string }>;
      };
      const browserPath = runtime.browser?.path;
      const state = browserPath ? await lstat(browserPath) : undefined;
      if (
        !state?.isFile() ||
        state.isSymbolicLink() ||
        !runtime.browser?.sha256 ||
        digest(await readFile(browserPath!)) !== runtime.browser.sha256
      )
        throw new Error();
      const binaries = await this.#binaries(toolRoot);
      if (
        JSON.stringify(runtime.binaries) !== JSON.stringify(binaries) ||
        Object.keys(runtime.binaries ?? {}).length !==
          Object.keys(RUNTIME_BINARIES).length
      )
        throw new Error();
    } catch {
      return [
        {
          level: "error",
          code: "web.modified-browser",
          message:
            "Owned browser executable is missing, symlinked, or modified",
        },
      ];
    }
    return [];
  }
  async uninstall(root: string, dryRun = false): Promise<WebToolDiagnostic[]> {
    let transaction: InstallerTransactionLock;
    try {
      transaction = await acquireInstallerTransactionLock(root);
    } catch (error) {
      return [
        {
          level: "error",
          code: "web.transaction-active",
          message: (error as Error).message,
        },
      ];
    }
    try {
      const toolRoot = resolve(root, WEB_AGENT_INTELLIGENCE_RECIPE.toolPath);
      if (!(await hasSafeDirectoryAncestors(resolve(root), toolRoot)))
        return [
          {
            level: "error",
            code: "web.unsafe-tool-path",
            message: "Tool path contains a symlink or escapes the project root",
          },
        ];
      const lock = await readFile(
        join(toolRoot, "loom-web-tools.lock.json"),
        "utf8",
      ).catch(() => undefined);
      if (lock === undefined)
        return [
          {
            level: "warning",
            code: "web.not-installed",
            message: "Web agent intelligence is not installed",
          },
        ];
      if (lock !== manifest())
        return [
          {
            level: "error",
            code: "web.modified-lock",
            message: "Web tool lock manifest was modified",
          },
        ];
      const diagnostics = await this.verify(root);
      if (diagnostics.some(({ level }) => level === "error"))
        return diagnostics;
      if (!dryRun) await rm(toolRoot, { recursive: true, force: true });
      return [];
    } finally {
      await transaction.release().catch(() => undefined);
    }
  }
}
export const webToolManifestHash = () => digest(manifest());
