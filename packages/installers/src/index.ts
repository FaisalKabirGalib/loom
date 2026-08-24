import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

const EXPECTED_SKILLS = [
  "dart-add-unit-test",
  "dart-build-cli-app",
  "dart-collect-coverage",
  "dart-fix-runtime-errors",
  "dart-generate-test-mocks",
  "dart-migrate-to-checks-package",
  "dart-resolve-package-conflicts",
  "dart-run-static-analysis",
  "dart-setup-ffi-assets",
  "dart-use-ffigen",
  "dart-use-pattern-matching",
  "dart-use-primary-constructors",
  "flutter-add-integration-test",
  "flutter-add-widget-preview",
  "flutter-add-widget-test",
  "flutter-apply-architecture-best-practices",
  "flutter-build-responsive-layout",
  "flutter-fix-layout-issues",
  "flutter-implement-json-serialization",
  "flutter-setup-declarative-routing",
  "flutter-setup-localization",
  "flutter-use-http-package",
] as const;

export const FLUTTER_AGENT_PLUGINS_RECIPE = Object.freeze({
  candidate: "builtin:flutter-agent-plugins" as const,
  harness: "opencode" as const,
  repository: "https://github.com/flutter/agent-plugins" as const,
  commit: "1e5696a2e986345f7ecc92842b5e9293bc079d6f" as const,
  sourcePath: "skills" as const,
  skills: EXPECTED_SKILLS,
});

export type InstallerCandidate = typeof FLUTTER_AGENT_PLUGINS_RECIPE.candidate;

export interface InstallerDiagnostic {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: string;
}

export interface InstallerMutation {
  kind: "create-file" | "update-file" | "delete-file";
  path: string;
  content?: string;
  expectedHash?: string;
}

export interface InstallerPlan {
  candidate: InstallerCandidate;
  root: string;
  recipeDigest: string;
  mutations: readonly InstallerMutation[];
  diagnostics: readonly InstallerDiagnostic[];
}

export interface InstallerResult {
  changed: string[];
  skipped: string[];
  diagnostics: InstallerDiagnostic[];
}

export interface ProcessRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

export interface InstallerFileOperations {
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface CapabilityInstallerOptions {
  dartPath: string;
  gitPath: string;
  processRunner?: ProcessRunner;
  temporaryDirectory?: string;
  fileOperations?: InstallerFileOperations;
}

interface OwnedPointer {
  path: "opencode.json" | "opencode.jsonc";
  value: unknown;
}

interface CapabilityOwnership {
  recipeDigest: string;
  files: Record<string, string>;
  pointers: { "mcp.dart-mcp-server": OwnedPointer };
}

interface Ownership {
  version: 1;
  capabilities: Record<string, unknown>;
}

const OWNERSHIP_PATH = ".loom/setup-ownership.json";
const CONFIG_PATHS = ["opencode.jsonc", "opencode.json"] as const;
const RECIPE_DIGEST = sha256(
  JSON.stringify({
    candidate: FLUTTER_AGENT_PLUGINS_RECIPE.candidate,
    harness: FLUTTER_AGENT_PLUGINS_RECIPE.harness,
    repository: FLUTTER_AGENT_PLUGINS_RECIPE.repository,
    commit: FLUTTER_AGENT_PLUGINS_RECIPE.commit,
    sourcePath: FLUTTER_AGENT_PLUGINS_RECIPE.sourcePath,
    skills: [...EXPECTED_SKILLS],
  }),
);

export const FLUTTER_AGENT_PLUGINS_RECIPE_DIGEST = RECIPE_DIGEST;

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function diagnostic(
  code: string,
  message: string,
  path?: string,
): InstallerDiagnostic {
  return path === undefined
    ? { level: "error", code, message }
    : { level: "error", code, message, path };
}

function isMissing(cause: unknown): boolean {
  return isRecord(cause) && cause.code === "ENOENT";
}

function skillPath(name: string): string {
  return `.agents/skills/${name}/SKILL.md`;
}

function allowedOwnedPath(path: string): boolean {
  return EXPECTED_SKILLS.some((name) => skillPath(name) === path);
}

function normalizedRelative(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

async function assertSafePath(root: string, absolute: string): Promise<void> {
  const candidate = relative(root, absolute);
  if (
    candidate === "" ||
    candidate === ".." ||
    candidate.startsWith(`..${sep}`) ||
    resolve(absolute) !== absolute
  ) {
    throw new Error(`Path escapes project root: ${absolute}`);
  }
  const rootState = await lstat(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
    throw new Error(`Project root is not a regular directory: ${root}`);
  }
  let current = root;
  for (const part of candidate.split(sep)) {
    current = resolve(current, part);
    try {
      const state = await lstat(current);
      if (state.isSymbolicLink())
        throw new Error(`Symlink is not allowed: ${current}`);
      if (current === absolute && !state.isFile()) {
        throw new Error(`Managed path is not a regular file: ${current}`);
      }
    } catch (cause) {
      if (isMissing(cause)) return;
      throw cause;
    }
  }
}

async function readSafeOptional(
  root: string,
  path: string,
): Promise<string | undefined> {
  const absolute = resolve(root, path);
  await assertSafePath(root, absolute);
  try {
    return await readFile(absolute, "utf8");
  } catch (cause) {
    if (isMissing(cause)) return undefined;
    throw cause;
  }
}

async function readSafeBytes(
  root: string,
  path: string,
): Promise<Buffer | undefined> {
  const absolute = resolve(root, path);
  await assertSafePath(root, absolute);
  try {
    return await readFile(absolute);
  } catch (cause) {
    if (isMissing(cause)) return undefined;
    throw cause;
  }
}

async function atomicWrite(
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

const defaultRunner: ProcessRunner = (request) =>
  new Promise((resolveResult, reject) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      shell: request.shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) =>
      resolveResult({
        exitCode: exitCode ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });

function parseJsonc(
  content: string,
  path: string,
): { value?: Record<string, unknown>; diagnostics: InstallerDiagnostic[] } {
  const errors: ParseError[] = [];
  const value: unknown = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || !isRecord(value)) {
    return {
      diagnostics: [
        diagnostic(
          "installers.invalid-config",
          "OpenCode config must be a JSON object",
          path,
        ),
      ],
    };
  }
  return { value, diagnostics: [] };
}

function formatting(content: string): {
  insertSpaces: boolean;
  tabSize: number;
  eol: string;
} {
  const indentation = content.match(/\n([\t ]+)\S/u)?.[1];
  return {
    insertSpaces: !indentation?.includes("\t"),
    tabSize: indentation?.includes("\t") ? 1 : (indentation?.length ?? 2),
    eol: content.includes("\r\n") ? "\r\n" : "\n",
  };
}

function setMcp(content: string, value: unknown): string {
  return applyEdits(
    content,
    modify(content, ["mcp", "dart-mcp-server"], value, {
      formattingOptions: formatting(content),
    }),
  );
}

function mcpValue(config: Record<string, unknown>): unknown {
  return isRecord(config.mcp) ? config.mcp["dart-mcp-server"] : undefined;
}

function ownedRecord(value: unknown): CapabilityOwnership | undefined {
  if (
    !isRecord(value) ||
    typeof value.recipeDigest !== "string" ||
    !isRecord(value.files) ||
    !isRecord(value.pointers)
  ) {
    return undefined;
  }
  const fileEntries = Object.entries(value.files);
  if (
    fileEntries.length !== EXPECTED_SKILLS.length ||
    fileEntries.some(
      ([path, hash]) =>
        !allowedOwnedPath(path) ||
        typeof hash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(hash),
    )
  ) {
    return undefined;
  }
  const pointer = value.pointers["mcp.dart-mcp-server"];
  if (
    Object.keys(value.pointers).length !== 1 ||
    !isRecord(pointer) ||
    !CONFIG_PATHS.includes(pointer.path as never) ||
    !("value" in pointer)
  ) {
    return undefined;
  }
  return value as unknown as CapabilityOwnership;
}

async function readOwnership(root: string): Promise<{
  value: Ownership;
  content?: string;
  owned?: CapabilityOwnership;
  diagnostics: InstallerDiagnostic[];
}> {
  let content: string | undefined;
  try {
    content = await readSafeOptional(root, OWNERSHIP_PATH);
  } catch {
    return {
      value: { version: 1, capabilities: {} },
      diagnostics: [
        diagnostic(
          "installers.unsafe-path",
          "Ownership path is unsafe",
          OWNERSHIP_PATH,
        ),
      ],
    };
  }
  if (content === undefined) {
    return { value: { version: 1, capabilities: {} }, diagnostics: [] };
  }
  try {
    const value: unknown = JSON.parse(content);
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !isRecord(value.capabilities)
    )
      throw new Error();
    const candidate =
      value.capabilities[FLUTTER_AGENT_PLUGINS_RECIPE.candidate];
    const owned = candidate === undefined ? undefined : ownedRecord(candidate);
    if (candidate !== undefined && owned === undefined) throw new Error();
    return {
      value: value as unknown as Ownership,
      content,
      ...(owned === undefined ? {} : { owned }),
      diagnostics: [],
    };
  } catch {
    return {
      value: { version: 1, capabilities: {} },
      content,
      diagnostics: [
        diagnostic(
          "installers.invalid-ownership",
          "Setup ownership file is invalid",
          OWNERSHIP_PATH,
        ),
      ],
    };
  }
}

async function collectSkills(
  repository: string,
): Promise<Record<string, string>> {
  const source = resolve(repository, FLUTTER_AGENT_PLUGINS_RECIPE.sourcePath);
  const sourceState = await lstat(source);
  if (!sourceState.isDirectory() || sourceState.isSymbolicLink())
    throw new Error("skills is not a directory");
  const entries = await readdir(source, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    names.length !== EXPECTED_SKILLS.length ||
    names.some((name, index) => name !== [...EXPECTED_SKILLS].sort()[index])
  ) {
    throw new Error("official skill directory set does not match the recipe");
  }
  const result: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error(`invalid skill directory: ${entry.name}`);
    const directory = resolve(source, entry.name);
    const children = await readdir(directory, { withFileTypes: true });
    if (
      children.length !== 1 ||
      children[0]?.name !== "SKILL.md" ||
      !children[0].isFile() ||
      children[0].isSymbolicLink()
    ) {
      throw new Error(`skill contains unsupported assets: ${entry.name}`);
    }
    const path = resolve(directory, "SKILL.md");
    const state = await lstat(path);
    if (!state.isFile() || state.isSymbolicLink())
      throw new Error(`invalid SKILL.md: ${entry.name}`);
    const bytes = await readFile(path);
    const content = bytes.toString("utf8");
    if (!Buffer.from(content).equals(bytes))
      throw new Error(`SKILL.md is not UTF-8: ${entry.name}`);
    result[skillPath(entry.name)] = content;
  }
  return result;
}

function mutation(
  kind: InstallerMutation["kind"],
  root: string,
  path: string,
  content?: string,
  expectedHash?: string,
): InstallerMutation {
  return {
    kind,
    path: resolve(root, path),
    ...(content === undefined ? {} : { content }),
    ...(expectedHash === undefined ? {} : { expectedHash }),
  };
}

function allowedMutation(root: string, path: string): string | undefined {
  if (!isAbsolute(path) || resolve(path) !== path) return undefined;
  const candidate = relative(root, path).split(sep).join("/");
  if (!normalizedRelative(candidate)) return undefined;
  return candidate === OWNERSHIP_PATH ||
    CONFIG_PATHS.includes(candidate as never) ||
    allowedOwnedPath(candidate)
    ? candidate
    : undefined;
}

export class CapabilityInstaller {
  readonly #dartPath: string;
  readonly #gitPath: string;
  readonly #runner: ProcessRunner;
  readonly #temporaryDirectory: string;
  readonly #fileOperations: InstallerFileOperations;
  readonly #plans = new WeakSet<InstallerPlan>();

  constructor(options: CapabilityInstallerOptions) {
    if (
      !isAbsolute(options.dartPath) ||
      resolve(options.dartPath) !== options.dartPath ||
      !isAbsolute(options.gitPath) ||
      resolve(options.gitPath) !== options.gitPath
    ) {
      throw new Error("dartPath and gitPath must be normalized absolute paths");
    }
    this.#dartPath = options.dartPath;
    this.#gitPath = options.gitPath;
    this.#runner = options.processRunner ?? defaultRunner;
    this.#temporaryDirectory = resolve(options.temporaryDirectory ?? tmpdir());
    this.#fileOperations =
      options.fileOperations ??
      ({
        write: atomicWrite,
        remove: unlink,
      } satisfies InstallerFileOperations);
  }

  #issue(plan: InstallerPlan): InstallerPlan {
    for (const item of plan.mutations) Object.freeze(item);
    for (const item of plan.diagnostics) Object.freeze(item);
    Object.freeze(plan.mutations);
    Object.freeze(plan.diagnostics);
    this.#plans.add(plan);
    return Object.freeze(plan);
  }

  async #stage(): Promise<Record<string, string>> {
    const temporary = await mkdtemp(
      join(this.#temporaryDirectory, "loom-flutter-agent-plugins-"),
    );
    const home = resolve(temporary, "home");
    const repository = resolve(temporary, "repository");
    await mkdir(home);
    await mkdir(repository);
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      ...(process.platform !== "win32" || process.env.SystemRoot === undefined
        ? {}
        : { SystemRoot: process.env.SystemRoot }),
    };
    const commands: readonly (readonly string[])[] = [
      ["init"],
      ["remote", "add", "origin", FLUTTER_AGENT_PLUGINS_RECIPE.repository],
      ["fetch", "--depth=1", "origin", FLUTTER_AGENT_PLUGINS_RECIPE.commit],
      ["checkout", "--detach", "FETCH_HEAD"],
      ["rev-parse", "HEAD"],
    ];
    try {
      let head = "";
      for (const args of commands) {
        const result = await this.#runner({
          command: this.#gitPath,
          args,
          cwd: repository,
          env,
          shell: false,
        });
        if (result.exitCode !== 0) {
          throw new Error(
            `git ${args.join(" ")} failed: ${result.stderr.trim()}`,
          );
        }
        if (args[0] === "rev-parse") head = result.stdout.trim();
      }
      if (head !== FLUTTER_AGENT_PLUGINS_RECIPE.commit)
        throw new Error("staged commit does not match recipe");
      return await collectSkills(repository);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async plan(
    root: string,
    candidate: InstallerCandidate = FLUTTER_AGENT_PLUGINS_RECIPE.candidate,
  ): Promise<InstallerPlan> {
    const projectRoot = resolve(root);
    const diagnostics: InstallerDiagnostic[] = [];
    if (candidate !== FLUTTER_AGENT_PLUGINS_RECIPE.candidate) {
      diagnostics.push(
        diagnostic(
          "installers.unsupported-candidate",
          `Unsupported candidate: ${String(candidate)}`,
        ),
      );
    }
    try {
      const rootState = await lstat(projectRoot);
      if (!rootState.isDirectory() || rootState.isSymbolicLink())
        throw new Error();
    } catch {
      diagnostics.push(
        diagnostic(
          "installers.invalid-root",
          "Project root must be a regular directory",
          projectRoot,
        ),
      );
    }
    const ownership =
      diagnostics.length === 0 ? await readOwnership(projectRoot) : undefined;
    if (ownership !== undefined) diagnostics.push(...ownership.diagnostics);
    let files: Record<string, string> = {};
    if (diagnostics.length === 0) {
      try {
        files = await this.#stage();
      } catch (cause) {
        diagnostics.push(
          diagnostic(
            "installers.stage-failed",
            cause instanceof Error ? cause.message : String(cause),
          ),
        );
      }
    }
    if (
      ownership?.owned !== undefined &&
      ownership.owned.recipeDigest !== RECIPE_DIGEST
    ) {
      diagnostics.push(
        diagnostic(
          "installers.recipe-collision",
          "Owned recipe digest does not match",
        ),
      );
    }
    const mutations: InstallerMutation[] = [];
    const ownedFiles = ownership?.owned?.files ?? {};
    for (const [path, content] of Object.entries(files)) {
      let current: string | undefined;
      try {
        current = await readSafeOptional(projectRoot, path);
      } catch {
        diagnostics.push(
          diagnostic("installers.unsafe-path", "Install path is unsafe", path),
        );
        continue;
      }
      const currentHash = current === undefined ? undefined : sha256(current);
      const ownedHash = ownedFiles[path];
      if (ownedHash !== undefined && ownedHash !== sha256(content)) {
        diagnostics.push(
          diagnostic(
            "installers.ownership-hash-mismatch",
            "Owned hash does not match the pinned recipe",
            path,
          ),
        );
      } else if (
        current !== undefined &&
        (ownedHash === undefined || currentHash !== ownedHash)
      ) {
        diagnostics.push(
          diagnostic(
            ownedHash === undefined
              ? "installers.file-collision"
              : "installers.modified-owned-file",
            ownedHash === undefined
              ? "Install path exists without an exact Loom ownership record"
              : "Owned file was modified",
            path,
          ),
        );
      } else if (current !== content) {
        mutations.push(
          mutation(
            current === undefined ? "create-file" : "update-file",
            projectRoot,
            path,
            content,
            currentHash,
          ),
        );
      }
    }

    const ownedPointer = ownership?.owned?.pointers["mcp.dart-mcp-server"];
    const presentConfigs: Array<(typeof CONFIG_PATHS)[number]> = [];
    for (const path of CONFIG_PATHS) {
      try {
        if ((await readSafeOptional(projectRoot, path)) !== undefined)
          presentConfigs.push(path);
      } catch {
        diagnostics.push(
          diagnostic(
            "installers.unsafe-path",
            "OpenCode config path is unsafe",
            path,
          ),
        );
      }
    }
    if (presentConfigs.length > 1 && ownedPointer === undefined) {
      diagnostics.push(
        diagnostic(
          "installers.ambiguous-config",
          "Both OpenCode config files exist",
        ),
      );
    }
    const configPath =
      ownedPointer?.path ?? presentConfigs[0] ?? "opencode.jsonc";
    let configContent: string | undefined;
    try {
      configContent = await readSafeOptional(projectRoot, configPath);
    } catch {
      diagnostics.push(
        diagnostic(
          "installers.unsafe-path",
          "OpenCode config path is unsafe",
          configPath,
        ),
      );
    }
    const configText = configContent ?? "{}\n";
    const parsed = parseJsonc(configText, configPath);
    diagnostics.push(...parsed.diagnostics);
    const desiredMcp = {
      type: "local",
      command: [this.#dartPath, "mcp-server"],
      enabled: true,
    };
    if (parsed.value !== undefined) {
      if (parsed.value.mcp !== undefined && !isRecord(parsed.value.mcp)) {
        diagnostics.push(
          diagnostic(
            "installers.mcp-collision",
            "OpenCode mcp value is not an object",
            configPath,
          ),
        );
      } else {
        const current = mcpValue(parsed.value);
        if (
          ownedPointer !== undefined &&
          !sameValue(current, ownedPointer.value)
        ) {
          diagnostics.push(
            diagnostic(
              "installers.modified-owned-pointer",
              "Owned MCP config was modified",
              configPath,
            ),
          );
        } else if (ownedPointer === undefined && current !== undefined) {
          diagnostics.push(
            diagnostic(
              "installers.mcp-collision",
              "mcp.dart-mcp-server is not owned by Loom",
              configPath,
            ),
          );
        }
      }
      const updated = setMcp(configText, desiredMcp);
      if (updated !== configText) {
        mutations.push(
          mutation(
            configContent === undefined ? "create-file" : "update-file",
            projectRoot,
            configPath,
            updated,
            configContent === undefined ? undefined : sha256(configContent),
          ),
        );
      }
    }
    if (diagnostics.some((item) => item.level === "error")) {
      return this.#issue({
        candidate,
        root: projectRoot,
        recipeDigest: RECIPE_DIGEST,
        mutations: [],
        diagnostics,
      });
    }
    const nextOwnership: Ownership = structuredClone(ownership!.value);
    nextOwnership.capabilities[candidate] = {
      recipeDigest: RECIPE_DIGEST,
      files: Object.fromEntries(
        Object.entries(files).map(([path, content]) => [path, sha256(content)]),
      ),
      pointers: {
        "mcp.dart-mcp-server": { path: configPath, value: desiredMcp },
      },
    } satisfies CapabilityOwnership;
    const ownershipContent = `${JSON.stringify(nextOwnership, null, 2)}\n`;
    if (ownershipContent !== ownership!.content) {
      mutations.push(
        mutation(
          ownership!.content === undefined ? "create-file" : "update-file",
          projectRoot,
          OWNERSHIP_PATH,
          ownershipContent,
          ownership!.content === undefined
            ? undefined
            : sha256(ownership!.content),
        ),
      );
    }
    return this.#issue({
      candidate,
      root: projectRoot,
      recipeDigest: RECIPE_DIGEST,
      mutations,
      diagnostics,
    });
  }

  async apply(plan: InstallerPlan, dryRun = false): Promise<InstallerResult> {
    if (!this.#plans.has(plan)) {
      return {
        changed: [],
        skipped: [],
        diagnostics: [
          diagnostic(
            "installers.invalid-plan",
            "Plan was not issued by this installer instance",
          ),
        ],
      };
    }
    const root = resolve(plan.root);
    const diagnostics = [...plan.diagnostics];
    if (
      !isAbsolute(plan.root) ||
      root !== plan.root ||
      plan.recipeDigest !== RECIPE_DIGEST
    ) {
      diagnostics.push(
        diagnostic(
          "installers.invalid-plan",
          "Plan root or recipe digest is invalid",
        ),
      );
    }
    const pending: Array<{
      mutation: InstallerMutation;
      relativePath: string;
      previous?: Buffer;
    }> = [];
    const skipped: string[] = [];
    for (const item of plan.mutations) {
      const relativePath = allowedMutation(root, item.path);
      if (
        relativePath === undefined ||
        ((item.kind === "create-file" || item.kind === "update-file") &&
          typeof item.content !== "string") ||
        ((item.kind === "update-file" || item.kind === "delete-file") &&
          typeof item.expectedHash !== "string")
      ) {
        diagnostics.push(
          diagnostic(
            "installers.invalid-mutation",
            "Mutation is not allowed",
            item.path,
          ),
        );
        skipped.push(item.path);
        continue;
      }
      let current: Buffer | undefined;
      try {
        current = await readSafeBytes(root, relativePath);
      } catch {
        diagnostics.push(
          diagnostic(
            "installers.unsafe-path",
            "Mutation path is unsafe",
            item.path,
          ),
        );
        skipped.push(item.path);
        continue;
      }
      const desired =
        item.kind === "delete-file" ? undefined : Buffer.from(item.content!);
      if (current !== undefined && desired?.equals(current) === true) {
        skipped.push(item.path);
      } else if (item.kind === "delete-file" && current === undefined) {
        skipped.push(item.path);
      } else if (
        (item.kind === "create-file" && current !== undefined) ||
        ((item.kind === "update-file" || item.kind === "delete-file") &&
          (current === undefined || sha256(current) !== item.expectedHash))
      ) {
        diagnostics.push(
          diagnostic(
            "installers.concurrent-change",
            "File changed after planning",
            item.path,
          ),
        );
        skipped.push(item.path);
      } else {
        pending.push({
          mutation: item,
          relativePath,
          ...(current === undefined ? {} : { previous: current }),
        });
      }
    }
    if (diagnostics.some((item) => item.level === "error")) {
      return {
        changed: [],
        skipped: [
          ...new Set([
            ...skipped,
            ...pending.map((entry) => entry.mutation.path),
          ]),
        ],
        diagnostics,
      };
    }
    if (dryRun) {
      return {
        changed: pending.map((entry) => entry.mutation.path),
        skipped,
        diagnostics,
      };
    }
    const journal: typeof pending = [];
    for (const entry of pending) {
      const item = entry.mutation;
      try {
        const current = await readSafeBytes(root, entry.relativePath);
        const matches =
          entry.previous === undefined
            ? current === undefined
            : current?.equals(entry.previous) === true;
        if (!matches) throw new Error("file changed during apply");
        if (item.kind === "delete-file")
          await this.#fileOperations.remove(item.path);
        else await this.#fileOperations.write(item.path, item.content!);
        journal.push(entry);
      } catch (cause) {
        const intended =
          item.kind === "delete-file" ? undefined : Buffer.from(item.content!);
        try {
          const current = await readSafeBytes(root, entry.relativePath);
          if (
            intended === undefined
              ? current === undefined
              : current?.equals(intended) === true
          )
            journal.push(entry);
        } catch {}
        const rollbackFailures: string[] = [];
        for (const applied of journal.reverse()) {
          try {
            const expected =
              applied.mutation.kind === "delete-file"
                ? undefined
                : Buffer.from(applied.mutation.content!);
            const current = await readSafeBytes(root, applied.relativePath);
            if (
              !(expected === undefined
                ? current === undefined
                : current?.equals(expected) === true)
            ) {
              throw new Error("changed before rollback");
            }
            if (applied.previous === undefined)
              await rm(applied.mutation.path, { force: true });
            else await atomicWrite(applied.mutation.path, applied.previous);
          } catch {
            rollbackFailures.push(applied.mutation.path);
          }
        }
        diagnostics.push(
          diagnostic(
            "installers.apply-failed",
            `${cause instanceof Error ? cause.message : String(cause)}; ${rollbackFailures.length === 0 ? "all mutations rolled back" : `rollback failed for ${rollbackFailures.join(", ")}`}`,
            item.path,
          ),
        );
        return {
          changed: [],
          skipped: pending.map((value) => value.mutation.path),
          diagnostics,
        };
      }
    }
    return {
      changed: pending.map((entry) => entry.mutation.path),
      skipped,
      diagnostics,
    };
  }

  async verify(root: string): Promise<InstallerDiagnostic[]> {
    const projectRoot = resolve(root);
    const state = await readOwnership(projectRoot);
    const diagnostics = [...state.diagnostics];
    const owned = state.owned;
    if (owned === undefined) {
      diagnostics.push({
        level: "warning",
        code: "installers.not-installed",
        message: "Flutter agent plugins are not installed",
      });
      return diagnostics;
    }
    if (owned.recipeDigest !== RECIPE_DIGEST) {
      diagnostics.push(
        diagnostic(
          "installers.recipe-collision",
          "Owned recipe digest does not match",
        ),
      );
    }
    for (const [path, hash] of Object.entries(owned.files)) {
      try {
        const content = await readSafeOptional(projectRoot, path);
        if (content === undefined)
          diagnostics.push(
            diagnostic(
              "installers.missing-owned-file",
              "Owned file is missing",
              path,
            ),
          );
        else if (sha256(content) !== hash)
          diagnostics.push(
            diagnostic(
              "installers.modified-owned-file",
              "Owned file was modified",
              path,
            ),
          );
      } catch {
        diagnostics.push(
          diagnostic("installers.unsafe-path", "Owned path is unsafe", path),
        );
      }
    }
    const pointer = owned.pointers["mcp.dart-mcp-server"];
    try {
      const content = await readSafeOptional(projectRoot, pointer.path);
      if (content === undefined) {
        diagnostics.push(
          diagnostic(
            "installers.missing-config",
            "OpenCode config is missing",
            pointer.path,
          ),
        );
      } else {
        const parsed = parseJsonc(content, pointer.path);
        diagnostics.push(...parsed.diagnostics);
        if (
          parsed.value !== undefined &&
          !sameValue(mcpValue(parsed.value), pointer.value)
        ) {
          diagnostics.push(
            diagnostic(
              "installers.modified-owned-pointer",
              "Owned MCP config was modified",
              pointer.path,
            ),
          );
        }
      }
    } catch {
      diagnostics.push(
        diagnostic(
          "installers.unsafe-path",
          "OpenCode config path is unsafe",
          pointer.path,
        ),
      );
    }
    return diagnostics;
  }

  async uninstall(root: string, dryRun = false): Promise<InstallerResult> {
    const projectRoot = resolve(root);
    const state = await readOwnership(projectRoot);
    const diagnostics = [...state.diagnostics];
    const owned = state.owned;
    if (
      owned === undefined ||
      diagnostics.some((item) => item.level === "error")
    ) {
      return { changed: [], skipped: [], diagnostics };
    }
    if (owned.recipeDigest !== RECIPE_DIGEST) {
      return {
        changed: [],
        skipped: [],
        diagnostics: [
          ...diagnostics,
          diagnostic(
            "installers.recipe-collision",
            "Owned recipe digest does not match; refusing uninstall",
          ),
        ],
      };
    }
    const mutations: InstallerMutation[] = [];
    for (const [path, hash] of Object.entries(owned.files)) {
      try {
        const content = await readSafeOptional(projectRoot, path);
        if (content === undefined || sha256(content) !== hash) {
          diagnostics.push(
            diagnostic(
              content === undefined
                ? "installers.missing-owned-file"
                : "installers.modified-owned-file",
              content === undefined
                ? "Owned file is missing"
                : "Owned file was modified; refusing uninstall",
              path,
            ),
          );
        } else {
          mutations.push(
            mutation("delete-file", projectRoot, path, undefined, hash),
          );
        }
      } catch {
        diagnostics.push(
          diagnostic("installers.unsafe-path", "Owned path is unsafe", path),
        );
      }
    }
    const pointer = owned.pointers["mcp.dart-mcp-server"];
    try {
      const content = await readSafeOptional(projectRoot, pointer.path);
      if (content === undefined) {
        diagnostics.push(
          diagnostic(
            "installers.missing-config",
            "OpenCode config is missing",
            pointer.path,
          ),
        );
      } else {
        const parsed = parseJsonc(content, pointer.path);
        diagnostics.push(...parsed.diagnostics);
        if (
          parsed.value === undefined ||
          !sameValue(mcpValue(parsed.value), pointer.value)
        ) {
          diagnostics.push(
            diagnostic(
              "installers.modified-owned-pointer",
              "Owned MCP config was modified; refusing uninstall",
              pointer.path,
            ),
          );
        } else {
          const updated = setMcp(content, undefined);
          if (updated !== content) {
            mutations.push(
              mutation(
                "update-file",
                projectRoot,
                pointer.path,
                updated,
                sha256(content),
              ),
            );
          }
        }
      }
    } catch {
      diagnostics.push(
        diagnostic(
          "installers.unsafe-path",
          "OpenCode config path is unsafe",
          pointer.path,
        ),
      );
    }
    const nextOwnership: Ownership = structuredClone(state.value);
    delete nextOwnership.capabilities[FLUTTER_AGENT_PLUGINS_RECIPE.candidate];
    if (Object.keys(nextOwnership.capabilities).length === 0) {
      mutations.push(
        mutation(
          "delete-file",
          projectRoot,
          OWNERSHIP_PATH,
          undefined,
          sha256(state.content!),
        ),
      );
    } else {
      mutations.push(
        mutation(
          "update-file",
          projectRoot,
          OWNERSHIP_PATH,
          `${JSON.stringify(nextOwnership, null, 2)}\n`,
          sha256(state.content!),
        ),
      );
    }
    const plan = this.#issue({
      candidate: FLUTTER_AGENT_PLUGINS_RECIPE.candidate,
      root: projectRoot,
      recipeDigest: RECIPE_DIGEST,
      mutations: diagnostics.some((item) => item.level === "error")
        ? []
        : mutations,
      diagnostics,
    });
    return this.apply(plan, dryRun);
  }
}

export default CapabilityInstaller;
