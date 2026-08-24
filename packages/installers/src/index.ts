import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

import { FLUTTER_TOOL_LOCK } from "./flutter-tool-lock.js";
import { FLUTTER_TOOL_PUBSPEC } from "./flutter-tool-pubspec.js";

const LEGACY_SKILLS = [
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
  skills: LEGACY_SKILLS,
});

const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const boundHash = (value: string | Uint8Array): string =>
  `sha256:${hash(value)}`;

export const FLUTTER_AGENT_PLUGINS_RECIPE_DIGEST = hash(
  JSON.stringify({
    candidate: FLUTTER_AGENT_PLUGINS_RECIPE.candidate,
    harness: FLUTTER_AGENT_PLUGINS_RECIPE.harness,
    repository: FLUTTER_AGENT_PLUGINS_RECIPE.repository,
    commit: FLUTTER_AGENT_PLUGINS_RECIPE.commit,
    sourcePath: FLUTTER_AGENT_PLUGINS_RECIPE.sourcePath,
    skills: [...LEGACY_SKILLS],
  }),
);

export const FLUTTER_PACKAGE_INTELLIGENCE_RECIPE = Object.freeze({
  candidate: "builtin:flutter-package-intelligence" as const,
  harness: "opencode" as const,
  toolPath: ".loom/tools/flutter-package-intelligence" as const,
  dartPubdevMcp: {
    version: "0.9.0" as const,
    contentHash:
      "sha256:5a5bcbf342ffb8f570e1a0162a5725985798d5aab79d7577364732f3dc692900" as const,
  },
  skillsCli: {
    version: "1.0.0" as const,
    contentHash:
      "sha256:9c8096e21e27fd102176e1ac025fdee96526f3be1533d10145fed312ae75e1d1" as const,
  },
  pubspecHash: boundHash(FLUTTER_TOOL_PUBSPEC),
  lockfileHash: boundHash(FLUTTER_TOOL_LOCK),
});

export interface PackageSkillBinding {
  source: "hosted-package";
  id: string;
  reason: string;
  package: string;
  version: string;
  packageContentHash: string;
  archiveHash: string;
  path: string;
  contentHash: string;
}

export interface RegistrySkillBinding {
  source: "skills-registry";
  id: string;
  reason: string;
  repository: string;
  commit: string;
  path: string;
  contentHash: string;
}

export interface FlutterPackageIntelligenceInstallRecipe {
  kind: "flutter-package-intelligence";
  toolPath: typeof FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath;
  dartPubdevMcp: typeof FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.dartPubdevMcp;
  skillsCli: typeof FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.skillsCli;
  pubspecHash: string;
  lockfileHash: string;
  selectedSkills: Array<PackageSkillBinding | RegistrySkillBinding>;
  selectionRationale?: string;
}

export type InstallerCandidate =
  typeof FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.candidate;
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
  recipe: FlutterPackageIntelligenceInstallRecipe;
  mutations: readonly InstallerMutation[];
  diagnostics: readonly InstallerDiagnostic[];
  executionRequired: boolean;
  process: ProcessRequest;
  compileProcess?: ProcessRequest;
  skillsProcess?: ProcessRequest;
}
export interface InstallerResult {
  changed: string[];
  skipped: string[];
  diagnostics: InstallerDiagnostic[];
  rollbackToken?: InstallerRollbackToken;
}
export interface InstallerRollbackToken {
  readonly id: string;
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
  fetch?: typeof fetch;
}

interface OwnedPointer {
  path: "opencode.json" | "opencode.jsonc";
  value: unknown;
}
interface CapabilityOwnership {
  recipeDigest: string;
  recipe: FlutterPackageIntelligenceInstallRecipe;
  files: Record<string, string>;
  pointers: Record<string, OwnedPointer>;
}
interface Ownership {
  version: 1;
  capabilities: Record<string, unknown>;
}
interface AppliedMutation {
  mutation: InstallerMutation;
  relative: string;
  previous?: Buffer;
  previousMode?: number;
}
interface InstallerRollbackState {
  root: string;
  toolRoot: string;
  applied: AppliedMutation[];
  generatedNames: string[];
  generatedBackups: Array<{ path: string; backup: string }>;
  backupRoot: string;
  effectsStarted: boolean;
  installedRuntime?: {
    previous?: Buffer;
    previousMode?: number;
    bytes: Buffer;
  };
}

const OWNERSHIP_PATH = ".loom/setup-ownership.json";
const CONFIG_PATHS = ["opencode.jsonc", "opencode.json"] as const;
const RUNTIME_PATH = `${FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath}/.runtime/dart-pubdev-explorer${process.platform === "win32" ? ".exe" : ""}`;
const RUNTIME_STAGED_PATH = `${FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath}/.runtime/.dart-pubdev-explorer.staged`;

const defaultRunner: ProcessRunner = (request) =>
  new Promise((done, reject) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (value: Buffer) => stdout.push(value));
    child.stderr.on("data", (value: Buffer) => stderr.push(value));
    child.once("error", reject);
    child.once("close", (exitCode) =>
      done({
        exitCode: exitCode ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });

async function atomicWrite(
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function issue(
  code: string,
  message: string,
  path?: string,
): InstallerDiagnostic {
  return path === undefined
    ? { level: "error", code, message }
    : { level: "error", code, message, path };
}
function normalized(path: string): boolean {
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
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
async function safeRead(
  root: string,
  path: string,
): Promise<string | undefined> {
  const absolute = resolve(root, path);
  const candidate = relative(root, absolute);
  if (!normalized(candidate.split(sep).join("/")))
    throw new Error("unsafe path");
  let current = root;
  for (const part of candidate.split(sep)) {
    current = resolve(current, part);
    try {
      const state = await lstat(current);
      if (state.isSymbolicLink()) throw new Error("symlink");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
  }
  return readFile(absolute, "utf8").catch((cause: NodeJS.ErrnoException) =>
    cause.code === "ENOENT" ? undefined : Promise.reject(cause),
  );
}
async function safeReadBytes(
  root: string,
  path: string,
): Promise<Buffer | undefined> {
  const absolute = resolve(root, path);
  const candidate = relative(root, absolute);
  if (!normalized(candidate.split(sep).join("/")))
    throw new Error("unsafe path");
  let current = root;
  for (const part of candidate.split(sep)) {
    current = resolve(current, part);
    try {
      const state = await lstat(current);
      if (state.isSymbolicLink()) throw new Error("symlink");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    }
  }
  return readFile(absolute).catch((cause: NodeJS.ErrnoException) =>
    cause.code === "ENOENT" ? undefined : Promise.reject(cause),
  );
}
async function assertSafeDirectory(
  root: string,
  absolute: string,
): Promise<void> {
  if (resolve(absolute) === resolve(root)) {
    const state = await lstat(root);
    if (!state.isDirectory() || state.isSymbolicLink())
      throw new Error("unsafe project root");
    return;
  }
  const candidate = relative(root, absolute);
  if (!normalized(candidate.split(sep).join("/")))
    throw new Error("unsafe path");
  let current = root;
  for (const part of candidate.split(sep)) {
    current = resolve(current, part);
    try {
      const state = await lstat(current);
      if (state.isSymbolicLink() || !state.isDirectory())
        throw new Error("unsafe directory path");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
  }
}
async function managedRead(
  root: string,
  path: string,
  diagnostics: InstallerDiagnostic[],
): Promise<string | undefined> {
  try {
    return await safeRead(root, path);
  } catch {
    diagnostics.push(
      issue(
        "installers.unsafe-path",
        "Managed path contains a symlink or escapes the project root",
        path,
      ),
    );
    return undefined;
  }
}
async function managedReadBytes(
  root: string,
  path: string,
  diagnostics: InstallerDiagnostic[],
): Promise<Buffer | undefined> {
  try {
    return await safeReadBytes(root, path);
  } catch {
    diagnostics.push(
      issue(
        "installers.unsafe-path",
        "Managed path contains a symlink or escapes the project root",
        path,
      ),
    );
    return undefined;
  }
}
function parseJsonc(
  content: string,
  path: string,
): { value?: Record<string, unknown>; diagnostics: InstallerDiagnostic[] } {
  const errors: ParseError[] = [];
  const value: unknown = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  return errors.length === 0 && isRecord(value)
    ? { value, diagnostics: [] }
    : {
        diagnostics: [
          issue(
            "installers.invalid-config",
            "OpenCode config must be a JSON object",
            path,
          ),
        ],
      };
}
function formatting(content: string) {
  const indentation = content.match(/\n([\t ]+)\S/u)?.[1];
  return {
    insertSpaces: !indentation?.includes("\t"),
    tabSize: indentation?.includes("\t") ? 1 : (indentation?.length ?? 2),
    eol: content.includes("\r\n") ? "\r\n" : "\n",
  };
}
function pointerValue(config: Record<string, unknown>, name: string): unknown {
  return isRecord(config.mcp) ? config.mcp[name] : undefined;
}
function setPointer(content: string, name: string, value: unknown): string {
  return applyEdits(
    content,
    modify(content, ["mcp", name], value, {
      formattingOptions: formatting(content),
    }),
  );
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
function recipeDigest(recipe: FlutterPackageIntelligenceInstallRecipe): string {
  return hash(JSON.stringify(canonicalize(recipe)));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  return value;
}

function validInstalledRecipe(
  value: unknown,
): value is FlutterPackageIntelligenceInstallRecipe {
  if (
    !isRecord(value) ||
    value["kind"] !== "flutter-package-intelligence" ||
    value["toolPath"] !== FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath ||
    !isDeepStrictEqual(
      value["dartPubdevMcp"],
      FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.dartPubdevMcp,
    ) ||
    !isDeepStrictEqual(
      value["skillsCli"],
      FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.skillsCli,
    ) ||
    value["pubspecHash"] !== FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.pubspecHash ||
    value["lockfileHash"] !==
      FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.lockfileHash ||
    !Array.isArray(value["selectedSkills"])
  )
    return false;
  const selections = value["selectedSkills"];
  if (
    new Set(
      selections.map((selection) => isRecord(selection) && selection["id"]),
    ).size !== selections.length ||
    new Set(
      selections.map(
        (selection) =>
          isRecord(selection) &&
          typeof selection["path"] === "string" &&
          selection["path"].split("/").at(-1),
      ),
    ).size !== selections.length
  )
    return false;
  return selections.every((selection) => {
    if (
      !isRecord(selection) ||
      typeof selection["id"] !== "string" ||
      typeof selection["reason"] !== "string" ||
      selection["reason"].trim().length === 0 ||
      typeof selection["path"] !== "string" ||
      !normalized(selection["path"]) ||
      typeof selection["contentHash"] !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(selection["contentHash"])
    )
      return false;
    if (selection["source"] === "hosted-package")
      return (
        typeof selection["package"] === "string" &&
        typeof selection["version"] === "string" &&
        typeof selection["packageContentHash"] === "string" &&
        /^sha256:[a-f0-9]{64}$/u.test(selection["packageContentHash"]) &&
        typeof selection["archiveHash"] === "string" &&
        /^sha256:[a-f0-9]{64}$/u.test(selection["archiveHash"])
      );
    return (
      selection["source"] === "skills-registry" &&
      typeof selection["repository"] === "string" &&
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(
        selection["repository"],
      ) &&
      typeof selection["commit"] === "string" &&
      /^[a-f0-9]{40}$/u.test(selection["commit"])
    );
  });
}

function ownedRecord(
  value: unknown,
  legacy: boolean,
  root?: string,
): CapabilityOwnership | undefined {
  if (
    !isRecord(value) ||
    typeof value["recipeDigest"] !== "string" ||
    !isRecord(value["files"]) ||
    !isRecord(value["pointers"])
  )
    return undefined;
  const recipe = value["recipe"];
  if (!legacy) {
    if (
      !validInstalledRecipe(recipe) ||
      value["recipeDigest"] !== recipeDigest(recipe)
    )
      return undefined;
  }
  const validFile = ([path, value]: [string, unknown]): boolean =>
    typeof value === "string" &&
    /^[a-f0-9]{64}$/u.test(value) &&
    normalized(path) &&
    (legacy
      ? LEGACY_SKILLS.some((name) => path === `.agents/skills/${name}/SKILL.md`)
      : path.startsWith(`${FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath}/`) ||
        /^\.agents\/skills\/[a-z0-9][a-z0-9._-]+\/.+/u.test(path));
  if (!Object.entries(value["files"]).every(validFile)) return undefined;
  if (!legacy) {
    const installedRecipe = recipe as FlutterPackageIntelligenceInstallRecipe;
    const files = value["files"] as Record<string, string>;
    if (
      files[`${FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath}/pubspec.yaml`] !==
        FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.pubspecHash.slice(7) ||
      files[`${FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath}/pubspec.lock`] !==
        FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.lockfileHash.slice(7) ||
      files[RUNTIME_PATH] === undefined
    )
      return undefined;
    const skillRoots = new Set(
      installedRecipe.selectedSkills.map(
        (selection) => `.agents/skills/${selection.path.split("/").at(-1)!}`,
      ),
    );
    for (const path of Object.keys(files))
      if (
        ![
          `${FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath}/pubspec.yaml`,
          `${FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath}/pubspec.lock`,
          RUNTIME_PATH,
        ].includes(path) &&
        ![...skillRoots].some((root) => path.startsWith(`${root}/`))
      )
        return undefined;
    if ([...skillRoots].some((root) => files[`${root}/SKILL.md`] === undefined))
      return undefined;
    for (const selection of installedRecipe.selectedSkills) {
      const root = `.agents/skills/${selection.path.split("/").at(-1)!}`;
      const aggregate = boundHash(
        Object.entries(files)
          .filter(([path]) => path.startsWith(`${root}/`))
          .map(
            ([path, fileHash]) =>
              `${path.slice(root.length + 1)}\0sha256:${fileHash}`,
          )
          .sort()
          .join("\n"),
      );
      if (aggregate !== selection.contentHash) return undefined;
    }
  }
  for (const [key, pointer] of Object.entries(value["pointers"])) {
    if (
      !["mcp.dart-mcp-server", "mcp.dart-pubdev-explorer"].includes(key) ||
      !isRecord(pointer) ||
      !CONFIG_PATHS.includes(pointer["path"] as never) ||
      !("value" in pointer)
    )
      return undefined;
  }
  if (
    !legacy &&
    !isDeepStrictEqual(Object.keys(value["pointers"]).sort(), [
      "mcp.dart-mcp-server",
      "mcp.dart-pubdev-explorer",
    ])
  )
    return undefined;
  if (!legacy) {
    if (root === undefined) return undefined;
    const pointers = value["pointers"] as Record<string, OwnedPointer>;
    const dart = pointers["mcp.dart-mcp-server"]!;
    const explorer = pointers["mcp.dart-pubdev-explorer"]!;
    if (dart.path !== explorer.path || !isRecord(dart.value)) return undefined;
    const dartCommand = dart.value["command"];
    if (
      !isDeepStrictEqual(Object.keys(dart.value).sort(), [
        "command",
        "enabled",
        "type",
      ]) ||
      dart.value["type"] !== "local" ||
      dart.value["enabled"] !== true ||
      !Array.isArray(dartCommand) ||
      dartCommand.length !== 2 ||
      typeof dartCommand[0] !== "string" ||
      !isAbsolute(dartCommand[0]) ||
      dartCommand[1] !== "mcp-server"
    )
      return undefined;
    const toolRoot = resolve(
      root,
      FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath,
    );
    const environment = {
      PUB_CACHE: join(toolRoot, ".pub-cache"),
      HOME: join(toolRoot, ".home"),
      XDG_CACHE_HOME: join(toolRoot, ".xdg/cache"),
      XDG_CONFIG_HOME: join(toolRoot, ".xdg/config"),
      XDG_DATA_HOME: join(toolRoot, ".xdg/data"),
      XDG_STATE_HOME: join(toolRoot, ".xdg/state"),
    };
    if (
      !isDeepStrictEqual(explorer.value, {
        type: "local",
        command: [resolve(root, RUNTIME_PATH)],
        environment,
        enabled: true,
      })
    )
      return undefined;
  }
  return value as unknown as CapabilityOwnership;
}

async function readOwnership(root: string): Promise<{
  value: Ownership;
  content?: string;
  current?: CapabilityOwnership;
  legacy?: CapabilityOwnership;
  diagnostics: InstallerDiagnostic[];
}> {
  let content: string | undefined;
  try {
    content = await safeRead(root, OWNERSHIP_PATH);
  } catch {
    return {
      value: { version: 1, capabilities: {} },
      diagnostics: [
        issue(
          "installers.unsafe-path",
          "Setup ownership path contains a symlink",
          OWNERSHIP_PATH,
        ),
      ],
    };
  }
  if (content === undefined)
    return { value: { version: 1, capabilities: {} }, diagnostics: [] };
  try {
    const value = JSON.parse(content) as Ownership;
    if (value.version !== 1 || !isRecord(value.capabilities)) throw new Error();
    const currentValue =
      value.capabilities[FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.candidate];
    const legacyValue =
      value.capabilities[FLUTTER_AGENT_PLUGINS_RECIPE.candidate];
    const current = ownedRecord(currentValue, false, root);
    const legacy = ownedRecord(legacyValue, true);
    if (
      (current !== undefined && legacy !== undefined) ||
      (currentValue !== undefined && current === undefined) ||
      (legacyValue !== undefined && legacy === undefined)
    )
      throw new Error();
    return {
      value,
      content,
      ...(current === undefined ? {} : { current }),
      ...(legacy === undefined ? {} : { legacy }),
      diagnostics: [],
    };
  } catch {
    return {
      value: { version: 1, capabilities: {} },
      content,
      diagnostics: [
        issue(
          "installers.invalid-ownership",
          "Setup ownership file is invalid",
          OWNERSHIP_PATH,
        ),
      ],
    };
  }
}

async function walkSkill(
  source: string,
  targetRoot: string,
): Promise<{ files: Record<string, string>; aggregate: string }> {
  const sourceState = await lstat(source);
  if (!sourceState.isDirectory() || sourceState.isSymbolicLink())
    throw new Error("Skill source must be a real directory");
  const files: Record<string, string> = {};
  let totalBytes = 0;
  const visit = async (directory: string, relativePath = ""): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
        throw new Error("Skill contains an unsupported entry");
      const child = join(directory, entry.name);
      const childRelative = relativePath
        ? `${relativePath}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) await visit(child, childRelative);
      else {
        const bytes = await readFile(child);
        totalBytes += bytes.length;
        if (Object.keys(files).length >= 100 || totalBytes > 1_048_576)
          throw new Error("Skill exceeds file or size limits");
        const content = bytes.toString("utf8");
        if (!Buffer.from(content).equals(bytes))
          throw new Error("Skill files must be UTF-8");
        files[`${targetRoot}/${childRelative}`] = content;
      }
    }
  };
  await visit(source);
  if (!Object.keys(files).some((path) => path.endsWith("/SKILL.md")))
    throw new Error("Skill has no SKILL.md");
  const aggregate = boundHash(
    Object.entries(files)
      .map(
        ([path, content]) =>
          `${path.slice(targetRoot.length + 1)}\0${boundHash(content)}`,
      )
      .join("\n"),
  );
  return { files, aggregate };
}

async function packageRoots(root: string): Promise<Map<string, string>> {
  const configPath = join(root, ".dart_tool/package_config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    packages?: Array<{ name?: string; rootUri?: string }>;
  };
  const result = new Map<string, string>();
  for (const item of config.packages ?? []) {
    if (!item.name || !item.rootUri) continue;
    const path = fileURLToPath(
      new URL(item.rootUri, pathToFileURL(`${dirname(configPath)}/`)),
    );
    result.set(item.name, path);
  }
  return result;
}

async function lockedPackages(
  root: string,
): Promise<Map<string, { version: string; contentHash: string }>> {
  const values = new Map<string, { version: string; contentHash: string }>();
  const content = await readFile(join(root, "pubspec.lock"), "utf8");
  let name: string | undefined;
  let hosted = false;
  let contentHash: string | undefined;
  for (const line of content.split(/\r?\n/u)) {
    const packageMatch = /^  ([A-Za-z0-9_]+):\s*$/u.exec(line);
    if (packageMatch) {
      name = packageMatch[1];
      hosted = false;
      contentHash = undefined;
      continue;
    }
    if (!name) continue;
    if (/^    source: hosted\s*$/u.test(line)) hosted = true;
    const hashMatch = /^      sha256: ["']?([a-f0-9]{64})["']?\s*$/u.exec(line);
    if (hashMatch) contentHash = `sha256:${hashMatch[1]}`;
    const versionMatch = /^    version: ["']([^"']+)["']\s*$/u.exec(line);
    if (hosted && contentHash && versionMatch)
      values.set(name, { version: versionMatch[1]!, contentHash });
  }
  return values;
}

async function validToolPackageConfig(root: string): Promise<boolean> {
  const configPath = `${FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath}/.dart_tool/package_config.json`;
  const content = await safeRead(root, configPath).catch(() => undefined);
  if (content === undefined) return false;
  try {
    const config = JSON.parse(content) as {
      packages?: Array<{ name?: unknown; rootUri?: unknown }>;
    };
    const packages = new Map(
      (config.packages ?? [])
        .filter(
          (item): item is { name: string; rootUri: string } =>
            typeof item.name === "string" && typeof item.rootUri === "string",
        )
        .map((item) => [item.name, item.rootUri]),
    );
    for (const [name, version] of [
      [
        "dart_pubdev_mcp",
        FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.dartPubdevMcp.version,
      ],
      ["skills", FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.skillsCli.version],
    ] as const) {
      const rootUri = packages.get(name);
      if (rootUri === undefined) return false;
      const packageRoot = fileURLToPath(
        new URL(rootUri, pathToFileURL(resolve(root, configPath))),
      );
      const relativeRoot = relative(root, packageRoot).split(sep).join("/");
      if (
        !normalized(relativeRoot) ||
        !relativeRoot.startsWith(
          `${FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath}/.pub-cache/`,
        )
      )
        return false;
      const pubspec = await safeRead(root, `${relativeRoot}/pubspec.yaml`);
      if (
        pubspec === undefined ||
        !new RegExp(`^name:\\s*${escapeRegex(name)}\\s*$`, "mu").test(
          pubspec,
        ) ||
        !new RegExp(
          `^version:\\s*["']?${escapeRegex(version)}["']?\\s*$`,
          "mu",
        ).test(pubspec)
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function validateToolDirectory(
  root: string,
  diagnostics: InstallerDiagnostic[],
): Promise<void> {
  const relativeRoot = FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath;
  const absoluteRoot = resolve(root, relativeRoot);
  const state = await lstat(absoluteRoot).catch(() => undefined);
  if (state === undefined) return;
  if (!state.isDirectory() || state.isSymbolicLink()) {
    diagnostics.push(
      issue(
        "installers.unsafe-path",
        "Owned tool path is not a real directory",
        relativeRoot,
      ),
    );
    return;
  }
  const allowed = new Set([
    "pubspec.yaml",
    "pubspec.lock",
    ".dart_tool",
    ".pub-cache",
    ".runtime",
    ".home",
    ".xdg",
  ]);
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  for (const entry of entries)
    if (entry.isSymbolicLink() || !allowed.has(entry.name))
      diagnostics.push(
        issue(
          "installers.unowned-tool-entry",
          "Tool directory contains an unowned entry",
          `${relativeRoot}/${entry.name}`,
        ),
      );
  const runtimeDirectory = resolve(absoluteRoot, ".runtime");
  const runtimeState = await lstat(runtimeDirectory).catch(() => undefined);
  if (runtimeState !== undefined) {
    if (!runtimeState.isDirectory() || runtimeState.isSymbolicLink())
      diagnostics.push(
        issue(
          "installers.unsafe-path",
          "Generated runtime path is not a real directory",
          `${relativeRoot}/.runtime`,
        ),
      );
    else {
      const runtimeName = RUNTIME_PATH.split("/").at(-1)!;
      for (const entry of await readdir(runtimeDirectory, {
        withFileTypes: true,
      }))
        if (
          ![runtimeName, RUNTIME_STAGED_PATH.split("/").at(-1)!].includes(
            entry.name,
          ) ||
          !entry.isFile() ||
          entry.isSymbolicLink()
        )
          diagnostics.push(
            issue(
              "installers.unowned-tool-entry",
              "Runtime directory contains an unowned entry",
              `${relativeRoot}/.runtime/${entry.name}`,
            ),
          );
    }
  }
}

async function selectedFiles(
  root: string,
  recipe: FlutterPackageIntelligenceInstallRecipe,
  runner: ProcessRunner,
  dartPath: string,
  gitPath: string,
  temporaryDirectory: string,
  fetcher: typeof fetch,
): Promise<Record<string, string>> {
  const hasHosted = recipe.selectedSkills.some(
    ({ source }) => source === "hosted-package",
  );
  const roots = hasHosted
    ? await packageRoots(root)
    : new Map<string, string>();
  const locked = hasHosted
    ? await lockedPackages(root)
    : new Map<string, { version: string; contentHash: string }>();
  const files: Record<string, string> = {};
  for (const selection of recipe.selectedSkills) {
    const target = `.agents/skills/${selection.path.split("/").at(-1)}`;
    if (!/^\.agents\/skills\/[a-z0-9][a-z0-9._-]+$/u.test(target))
      throw new Error(`Selected skill path is invalid: ${selection.id}`);
    if (Object.keys(files).some((path) => path.startsWith(`${target}/`)))
      throw new Error(`Selected skills collide at ${target}`);
    let staged: Awaited<ReturnType<typeof walkSkill>>;
    if (selection.source === "hosted-package") {
      const packageLock = locked.get(selection.package);
      if (
        packageLock?.version !== selection.version ||
        packageLock.contentHash !== selection.packageContentHash
      )
        throw new Error(`Selected package lock changed: ${selection.package}`);
      if (!roots.has(selection.package))
        throw new Error(`Locked package is unavailable: ${selection.package}`);
      staged = await stageHostedSkill(
        selection,
        target,
        runner,
        dartPath,
        temporaryDirectory,
        fetcher,
      );
    } else {
      staged = await stageRegistrySkill(
        selection,
        target,
        runner,
        gitPath,
        temporaryDirectory,
      );
    }
    if (staged.aggregate !== selection.contentHash)
      throw new Error(`Selected skill content changed: ${selection.id}`);
    Object.assign(files, staged.files);
  }
  return files;
}

async function stageHostedSkill(
  selection: PackageSkillBinding,
  target: string,
  runner: ProcessRunner,
  dartPath: string,
  temporaryDirectory: string,
  fetcher: typeof fetch,
): Promise<Awaited<ReturnType<typeof walkSkill>>> {
  if (
    !/^[A-Za-z0-9_]+$/u.test(selection.package) ||
    !/^[0-9A-Za-z.+-]+$/u.test(selection.version) ||
    !normalized(selection.path)
  )
    throw new Error(`Hosted skill binding is invalid: ${selection.id}`);
  const archiveResponse = await fetcher(
    `https://pub.dev/api/archives/${selection.package}-${selection.version}.tar.gz`,
    { redirect: "follow", signal: AbortSignal.timeout(30_000) },
  );
  if (!archiveResponse.ok || archiveResponse.body === null)
    throw new Error(`Package archive fetch failed: ${archiveResponse.status}`);
  const chunks: Uint8Array[] = [];
  let archiveBytes = 0;
  const reader = archiveResponse.body.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    archiveBytes += chunk.value.byteLength;
    if (archiveBytes > 32 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("Package archive exceeds the size limit");
    }
    chunks.push(chunk.value);
  }
  const archive = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (boundHash(archive) !== selection.archiveHash)
    throw new Error("Downloaded package archive hash does not match the pin");
  const temporaryState = await lstat(temporaryDirectory);
  if (!temporaryState.isDirectory() || temporaryState.isSymbolicLink())
    throw new Error("Temporary directory must be a real directory");
  const temporary = await mkdtemp(join(temporaryDirectory, "loom-pub-skill-"));
  const output = join(temporary, "output");
  const home = join(temporary, "home");
  const cache = join(temporary, "pub-cache");
  await mkdir(output);
  await mkdir(home);
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    PUB_CACHE: cache,
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
  };
  try {
    const result = await runner({
      command: dartPath,
      args: [
        "pub",
        "unpack",
        `${selection.package}:${selection.version}`,
        "--no-resolve",
        "--output",
        output,
      ],
      cwd: temporary,
      env: environment,
      shell: false,
    });
    if (result.exitCode !== 0)
      throw new Error(`dart pub unpack failed: ${result.stderr.trim()}`);
    const packageRoot = join(
      output,
      `${selection.package}-${selection.version}`,
    );
    const pubspec = await readFile(join(packageRoot, "pubspec.yaml"), "utf8");
    if (
      !new RegExp(
        `^name:\\s*${escapeRegex(selection.package)}\\s*$`,
        "mu",
      ).test(pubspec) ||
      !new RegExp(
        `^version:\\s*["']?${escapeRegex(selection.version)}["']?\\s*$`,
        "mu",
      ).test(pubspec)
    )
      throw new Error("Unpacked package identity does not match the lock");
    return await walkSkill(join(packageRoot, selection.path), target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function authenticateHostedSkill(
  selection: PackageSkillBinding,
  target: string,
  runner: ProcessRunner,
  dartPath: string,
  temporaryDirectory: string,
): Promise<Awaited<ReturnType<typeof walkSkill>>> {
  if (
    !/^[A-Za-z0-9_]+$/u.test(selection.package) ||
    !/^[0-9A-Za-z.+-]+$/u.test(selection.version) ||
    !normalized(selection.path)
  )
    throw new Error(`Hosted skill binding is invalid: ${selection.id}`);
  const temporaryState = await lstat(temporaryDirectory);
  if (!temporaryState.isDirectory() || temporaryState.isSymbolicLink())
    throw new Error("Temporary directory must be a real directory");
  const temporary = await mkdtemp(join(temporaryDirectory, "loom-pub-auth-"));
  const home = join(temporary, "home");
  const cache = join(temporary, "pub-cache");
  await mkdir(home);
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    PUB_CACHE: cache,
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
  };
  try {
    const result = await runner({
      command: dartPath,
      args: [
        "pub",
        "cache",
        "add",
        selection.package,
        "--version",
        selection.version,
      ],
      cwd: temporary,
      env: environment,
      shell: false,
    });
    if (result.exitCode !== 0)
      throw new Error(`dart pub cache add failed: ${result.stderr.trim()}`);
    const archiveHash = (
      await readFile(
        join(
          cache,
          "hosted-hashes/pub.dev",
          `${selection.package}-${selection.version}.sha256`,
        ),
        "utf8",
      )
    ).trim();
    if (
      `sha256:${archiveHash}` !== selection.packageContentHash ||
      `sha256:${archiveHash}` !== selection.archiveHash
    )
      throw new Error("Downloaded package archive hash does not match the pin");
    const packageRoot = join(
      cache,
      "hosted/pub.dev",
      `${selection.package}-${selection.version}`,
    );
    const pubspec = await readFile(join(packageRoot, "pubspec.yaml"), "utf8");
    if (
      !new RegExp(
        `^name:\\s*${escapeRegex(selection.package)}\\s*$`,
        "mu",
      ).test(pubspec) ||
      !new RegExp(
        `^version:\\s*["']?${escapeRegex(selection.version)}["']?\\s*$`,
        "mu",
      ).test(pubspec)
    )
      throw new Error("Authenticated package identity does not match the pin");
    return await walkSkill(join(packageRoot, selection.path), target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function stageRegistrySkill(
  selection: RegistrySkillBinding,
  target: string,
  runner: ProcessRunner,
  gitPath: string,
  temporaryDirectory: string,
): Promise<Awaited<ReturnType<typeof walkSkill>>> {
  if (
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(
      selection.repository,
    ) ||
    !/^[a-f0-9]{40}$/u.test(selection.commit) ||
    !normalized(selection.path)
  )
    throw new Error(`Registry skill binding is invalid: ${selection.id}`);
  const temporaryState = await lstat(temporaryDirectory);
  if (!temporaryState.isDirectory() || temporaryState.isSymbolicLink())
    throw new Error("Temporary directory must be a real directory");
  const temporary = await mkdtemp(
    join(temporaryDirectory, "loom-registry-skill-"),
  );
  const repository = join(temporary, "repository");
  const home = join(temporary, "home");
  await mkdir(repository);
  await mkdir(home);
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
  };
  const commands = [
    ["init"],
    ["remote", "add", "origin", selection.repository],
    ["fetch", "--depth=1", "origin", selection.commit],
    ["fsck", "--strict", "--no-dangling"],
    ["checkout", "--detach", "FETCH_HEAD"],
    ["rev-parse", "HEAD"],
  ] as const;
  try {
    let head = "";
    for (const args of commands) {
      const result = await runner({
        command: gitPath,
        args,
        cwd: repository,
        env: environment,
        shell: false,
      });
      if (result.exitCode !== 0)
        throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
      if (args[0] === "rev-parse") head = result.stdout.trim();
    }
    if (head !== selection.commit)
      throw new Error("Registry checkout does not match the pinned commit");
    return await walkSkill(join(repository, selection.path), target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function authenticateSelectedFiles(
  recipe: FlutterPackageIntelligenceInstallRecipe,
  runner: ProcessRunner,
  dartPath: string,
  gitPath: string,
  temporaryDirectory: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const selection of recipe.selectedSkills) {
    const target = `.agents/skills/${selection.path.split("/").at(-1)}`;
    const staged =
      selection.source === "hosted-package"
        ? await authenticateHostedSkill(
            selection,
            target,
            runner,
            dartPath,
            temporaryDirectory,
          )
        : await stageRegistrySkill(
            selection,
            target,
            runner,
            gitPath,
            temporaryDirectory,
          );
    if (staged.aggregate !== selection.contentHash)
      throw new Error(`Authenticated skill content changed: ${selection.id}`);
    Object.assign(files, staged.files);
  }
  return files;
}

async function runHostedSkills(
  root: string,
  processRequest: ProcessRequest,
  runner: ProcessRunner,
): Promise<void> {
  const stage = processRequest.args[3];
  if (
    typeof stage !== "string" ||
    stage !==
      resolve(
        root,
        FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath,
        ".skills-stage",
      )
  )
    throw new Error("Invalid skills staging directory");
  const relativeStage = relative(root, stage).split(sep).join("/");
  if ((await safeRead(root, relativeStage)) !== undefined)
    throw new Error("Skills staging directory already exists");
  await mkdir(stage);
  try {
    const pubspec = await safeRead(root, "pubspec.yaml");
    const lockfile = await safeRead(root, "pubspec.lock");
    const packageConfig = await safeRead(
      root,
      ".dart_tool/package_config.json",
    );
    if (
      pubspec === undefined ||
      lockfile === undefined ||
      packageConfig === undefined
    )
      throw new Error("Hosted skill staging requires Dart project lock state");
    const parsed = JSON.parse(packageConfig) as {
      packages?: Array<Record<string, unknown>>;
    };
    const sourceConfig = resolve(root, ".dart_tool/package_config.json");
    const normalizedConfig = {
      ...parsed,
      packages: (parsed.packages ?? []).map((item) => ({
        ...item,
        ...(typeof item["rootUri"] === "string"
          ? {
              rootUri: new URL(item["rootUri"], pathToFileURL(sourceConfig))
                .href,
            }
          : {}),
      })),
    };
    await atomicWrite(join(stage, "pubspec.yaml"), pubspec);
    await atomicWrite(join(stage, "pubspec.lock"), lockfile);
    await atomicWrite(
      join(stage, ".dart_tool/package_config.json"),
      `${JSON.stringify(normalizedConfig, null, 2)}\n`,
    );
    const result = await runner(processRequest);
    if (result.exitCode !== 0)
      throw new Error(`skills get failed: ${result.stderr.trim()}`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export class CapabilityInstaller {
  readonly #dartPath: string;
  readonly #gitPath: string;
  readonly #temporaryDirectory: string;
  readonly #runner: ProcessRunner;
  readonly #fileOperations: InstallerFileOperations;
  readonly #fetch: typeof fetch;
  readonly #plans = new WeakSet<InstallerPlan>();
  readonly #rollbacks = new WeakMap<
    InstallerRollbackToken,
    InstallerRollbackState
  >();

  constructor(options: CapabilityInstallerOptions) {
    if (
      !isAbsolute(options.dartPath) ||
      resolve(options.dartPath) !== options.dartPath ||
      !isAbsolute(options.gitPath) ||
      resolve(options.gitPath) !== options.gitPath
    )
      throw new Error("dartPath and gitPath must be normalized absolute paths");
    this.#dartPath = options.dartPath;
    this.#gitPath = options.gitPath;
    this.#temporaryDirectory = resolve(options.temporaryDirectory ?? tmpdir());
    this.#runner = options.processRunner ?? defaultRunner;
    this.#fileOperations = options.fileOperations ?? {
      write: atomicWrite,
      remove: (path) => rm(path, { force: true }),
    };
    this.#fetch = options.fetch ?? fetch;
  }

  async #restore(state: InstallerRollbackState): Promise<string[]> {
    const failures: string[] = [];
    await rm(resolve(state.root, RUNTIME_STAGED_PATH), { force: true }).catch(
      () => failures.push(resolve(state.root, RUNTIME_STAGED_PATH)),
    );
    if (state.installedRuntime !== undefined)
      try {
        const current = await safeReadBytes(state.root, RUNTIME_PATH);
        if (current?.equals(state.installedRuntime.bytes) !== true)
          throw new Error("Runtime changed before rollback");
        const runtimePath = resolve(state.root, RUNTIME_PATH);
        if (state.installedRuntime.previous === undefined)
          await rm(runtimePath, { force: true });
        else {
          await atomicWrite(runtimePath, state.installedRuntime.previous);
          await chmod(
            runtimePath,
            state.installedRuntime.previousMode ?? 0o700,
          );
        }
      } catch {
        failures.push(resolve(state.root, RUNTIME_PATH));
      }
    const generatedPaths = state.effectsStarted
      ? state.generatedNames.map((name) => resolve(state.toolRoot, name))
      : state.generatedBackups.map(({ path }) => path);
    for (const path of generatedPaths)
      await rm(path, { recursive: true, force: true }).catch(() =>
        failures.push(path),
      );
    for (const { path, backup } of [...state.generatedBackups].reverse())
      await rename(backup, path).catch(() => failures.push(path));
    await rm(state.backupRoot, { recursive: true, force: true }).catch(() =>
      failures.push(state.backupRoot),
    );
    for (const entry of [...state.applied].reverse()) {
      try {
        const current = await safeReadBytes(state.root, entry.relative);
        const intended =
          entry.mutation.kind === "delete-file"
            ? undefined
            : Buffer.from(entry.mutation.content!);
        if (
          intended === undefined
            ? current !== undefined
            : current?.equals(intended) !== true
        )
          throw new Error("File changed before rollback");
        if (entry.previous === undefined)
          await rm(entry.mutation.path, { force: true });
        else {
          await atomicWrite(entry.mutation.path, entry.previous);
          await chmod(entry.mutation.path, entry.previousMode ?? 0o600);
        }
      } catch {
        failures.push(entry.mutation.path);
      }
    }
    const directories = new Set(
      state.applied
        .filter(({ previous }) => previous === undefined)
        .flatMap(({ mutation }) => {
          const values: string[] = [];
          let directory = dirname(mutation.path);
          while (directory !== state.root && directory.startsWith(state.root)) {
            values.push(directory);
            directory = dirname(directory);
          }
          return values;
        }),
    );
    directories.add(dirname(resolve(state.root, RUNTIME_PATH)));
    directories.add(state.toolRoot);
    for (const directory of [...directories].sort(
      (left, right) => right.length - left.length,
    ))
      await rmdir(directory).catch((cause: NodeJS.ErrnoException) => {
        if (!["ENOENT", "ENOTEMPTY"].includes(cause.code ?? ""))
          failures.push(directory);
      });
    return failures;
  }

  async rollback(token: InstallerRollbackToken): Promise<InstallerResult> {
    const state = this.#rollbacks.get(token);
    if (state === undefined)
      return {
        changed: [],
        skipped: [],
        diagnostics: [
          issue("installers.invalid-rollback", "Rollback token is not active"),
        ],
      };
    const failures = await this.#restore(state);
    this.#rollbacks.delete(token);
    return {
      changed: [],
      skipped: [],
      diagnostics:
        failures.length === 0
          ? []
          : [
              issue(
                "installers.rollback-failed",
                `Rollback failed for ${failures.join(", ")}`,
              ),
            ],
    };
  }

  async commit(token: InstallerRollbackToken): Promise<InstallerDiagnostic[]> {
    const state = this.#rollbacks.get(token);
    if (state === undefined)
      return [
        issue("installers.invalid-rollback", "Rollback token is not active"),
      ];
    try {
      await rm(state.backupRoot, { recursive: true, force: true });
      this.#rollbacks.delete(token);
      return [];
    } catch (cause) {
      return [
        issue(
          "installers.rollback-cleanup",
          cause instanceof Error ? cause.message : String(cause),
        ),
      ];
    }
  }

  #issue(plan: InstallerPlan): InstallerPlan {
    plan.mutations.forEach(Object.freeze);
    plan.diagnostics.forEach(Object.freeze);
    Object.freeze(plan.mutations);
    Object.freeze(plan.diagnostics);
    plan.recipe.selectedSkills.forEach(Object.freeze);
    Object.freeze(plan.recipe.selectedSkills);
    Object.freeze(plan.recipe.dartPubdevMcp);
    Object.freeze(plan.recipe.skillsCli);
    Object.freeze(plan.recipe);
    Object.freeze(plan.process.args);
    Object.freeze(plan.process.env);
    Object.freeze(plan.process);
    if (plan.compileProcess !== undefined) {
      Object.freeze(plan.compileProcess.args);
      Object.freeze(plan.compileProcess.env);
      Object.freeze(plan.compileProcess);
    }
    if (plan.skillsProcess !== undefined) {
      Object.freeze(plan.skillsProcess.args);
      Object.freeze(plan.skillsProcess.env);
      Object.freeze(plan.skillsProcess);
    }
    this.#plans.add(plan);
    return Object.freeze(plan);
  }

  async plan(
    root: string,
    recipe: FlutterPackageIntelligenceInstallRecipe = {
      kind: "flutter-package-intelligence",
      toolPath: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath,
      dartPubdevMcp: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.dartPubdevMcp,
      skillsCli: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.skillsCli,
      pubspecHash: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.pubspecHash,
      lockfileHash: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.lockfileHash,
      selectedSkills: [],
      selectionRationale: "No package skills selected",
    },
  ): Promise<InstallerPlan> {
    const projectRoot = resolve(root);
    const diagnostics: InstallerDiagnostic[] = [];
    const rootState = await lstat(projectRoot).catch(() => undefined);
    if (
      rootState === undefined ||
      !rootState.isDirectory() ||
      rootState.isSymbolicLink()
    )
      diagnostics.push(
        issue(
          "installers.invalid-root",
          "Project root must be a real directory",
          projectRoot,
        ),
      );
    if (
      recipe.toolPath !== FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath ||
      !isDeepStrictEqual(
        recipe.dartPubdevMcp,
        FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.dartPubdevMcp,
      ) ||
      !isDeepStrictEqual(
        recipe.skillsCli,
        FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.skillsCli,
      ) ||
      recipe.pubspecHash !== FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.pubspecHash ||
      recipe.lockfileHash !== FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.lockfileHash
    )
      diagnostics.push(
        issue(
          "installers.recipe-collision",
          "Package intelligence recipe is not pinned",
        ),
      );
    if (
      new Set(recipe.selectedSkills.map(({ id }) => id)).size !==
        recipe.selectedSkills.length ||
      recipe.selectedSkills.some(
        (selection) =>
          selection.reason.trim().length === 0 ||
          !/^sha256:[a-f0-9]{64}$/u.test(selection.contentHash),
      )
    )
      diagnostics.push(
        issue(
          "installers.invalid-selection",
          "Selected skills must be unique and exactly hashed",
        ),
      );
    const version = await this.#runner({
      command: this.#dartPath,
      args: ["--version"],
      cwd: projectRoot,
      env: {},
      shell: false,
    }).catch(() => undefined);
    const match = /Dart SDK version:\s*(\d+)\.(\d+)/u.exec(
      `${version?.stdout ?? ""} ${version?.stderr ?? ""}`,
    );
    if (
      !match ||
      Number(match[1]) < 3 ||
      (Number(match[1]) === 3 && Number(match[2]) < 11)
    )
      diagnostics.push(
        issue("installers.dart-version", "Dart >=3.11 is required"),
      );
    const state = await readOwnership(projectRoot);
    diagnostics.push(...state.diagnostics);
    await validateToolDirectory(projectRoot, diagnostics);
    const runtimeExpected = state.current?.files[RUNTIME_PATH];
    const runtimeBytes = await managedReadBytes(
      projectRoot,
      RUNTIME_PATH,
      diagnostics,
    );
    const compileRequired = runtimeExpected === undefined;
    if (
      runtimeExpected !== undefined &&
      (runtimeBytes === undefined || hash(runtimeBytes) !== runtimeExpected)
    )
      diagnostics.push(
        issue(
          "installers.modified-owned-runtime",
          "Owned package intelligence executable is missing or modified",
          RUNTIME_PATH,
        ),
      );
    if (runtimeExpected === undefined && runtimeBytes !== undefined)
      diagnostics.push(
        issue(
          "installers.runtime-collision",
          "Package intelligence executable exists without Loom ownership",
          RUNTIME_PATH,
        ),
      );
    const desiredFiles: Record<string, string> = {
      [`${recipe.toolPath}/pubspec.yaml`]: FLUTTER_TOOL_PUBSPEC,
      [`${recipe.toolPath}/pubspec.lock`]: FLUTTER_TOOL_LOCK,
      ...(diagnostics.length === 0 && recipe.selectedSkills.length > 0
        ? await selectedFiles(
            projectRoot,
            recipe,
            this.#runner,
            this.#dartPath,
            this.#gitPath,
            this.#temporaryDirectory,
            this.#fetch,
          ).catch((cause) => {
            diagnostics.push(
              issue(
                "installers.skill-stage",
                cause instanceof Error ? cause.message : String(cause),
              ),
            );
            return {};
          })
        : {}),
    };
    const mutations: InstallerMutation[] = [];
    const ownedFiles = state.current?.files ?? state.legacy?.files ?? {};
    for (const [path, content] of Object.entries(desiredFiles)) {
      const current = await managedRead(projectRoot, path, diagnostics);
      const currentHash = current === undefined ? undefined : hash(current);
      if (
        current !== undefined &&
        (ownedFiles[path] === undefined || ownedFiles[path] !== currentHash)
      )
        diagnostics.push(
          issue(
            "installers.file-collision",
            "Path exists without matching Loom ownership",
            path,
          ),
        );
      else if (current !== content)
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
    for (const [path, expectedHash] of Object.entries(
      state.current?.files ?? {},
    )) {
      if (path === RUNTIME_PATH) continue;
      if (path in desiredFiles) continue;
      const current = await managedRead(projectRoot, path, diagnostics);
      if (current === undefined || hash(current) !== expectedHash)
        diagnostics.push(
          issue(
            "installers.modified-owned-file",
            "Obsolete owned skill changed; refusing selective removal",
            path,
          ),
        );
      else
        mutations.push(
          mutation("delete-file", projectRoot, path, undefined, expectedHash),
        );
    }
    for (const [path, expectedHash] of Object.entries(
      state.legacy?.files ?? {},
    )) {
      if (path in desiredFiles) continue;
      const current = await managedRead(projectRoot, path, diagnostics);
      if (current === undefined || hash(current) !== expectedHash)
        diagnostics.push(
          issue(
            "installers.legacy-modified",
            "Legacy skill changed; refusing automatic migration",
            path,
          ),
        );
      else
        mutations.push(
          mutation("delete-file", projectRoot, path, undefined, expectedHash),
        );
    }
    const present = (
      await Promise.all(
        CONFIG_PATHS.map(
          async (path) =>
            [path, await managedRead(projectRoot, path, diagnostics)] as const,
        ),
      )
    ).filter(([, content]) => content !== undefined);
    const ownedPointers =
      state.current?.pointers ?? state.legacy?.pointers ?? {};
    if (present.length > 1 && Object.keys(ownedPointers).length === 0)
      diagnostics.push(
        issue(
          "installers.ambiguous-config",
          "Both OpenCode config files exist",
        ),
      );
    const configPath =
      Object.values(ownedPointers)[0]?.path ??
      present[0]?.[0] ??
      "opencode.jsonc";
    const configContent = await managedRead(
      projectRoot,
      configPath,
      diagnostics,
    );
    let configText = configContent ?? "{}\n";
    const parsed = parseJsonc(configText, configPath);
    diagnostics.push(...parsed.diagnostics);
    const toolRoot = resolve(projectRoot, recipe.toolPath);
    const localEnvironment = {
      PUB_CACHE: join(toolRoot, ".pub-cache"),
      HOME: join(toolRoot, ".home"),
      XDG_CACHE_HOME: join(toolRoot, ".xdg/cache"),
      XDG_CONFIG_HOME: join(toolRoot, ".xdg/config"),
      XDG_DATA_HOME: join(toolRoot, ".xdg/data"),
      XDG_STATE_HOME: join(toolRoot, ".xdg/state"),
    };
    const desiredPointers = {
      "dart-mcp-server": {
        type: "local",
        command: [this.#dartPath, "mcp-server"],
        enabled: true,
      },
      "dart-pubdev-explorer": {
        type: "local",
        command: [resolve(projectRoot, RUNTIME_PATH)],
        environment: localEnvironment,
        enabled: true,
      },
    };
    if (parsed.value) {
      if (parsed.value.mcp !== undefined && !isRecord(parsed.value.mcp))
        diagnostics.push(
          issue(
            "installers.mcp-collision",
            "OpenCode mcp value is not an object",
            configPath,
          ),
        );
      for (const [name, desired] of Object.entries(desiredPointers)) {
        const key = `mcp.${name}`;
        const current = pointerValue(parsed.value, name);
        const owned = ownedPointers[key];
        if (owned && !isDeepStrictEqual(current, owned.value))
          diagnostics.push(
            issue(
              "installers.modified-owned-pointer",
              `Owned ${key} was modified`,
              configPath,
            ),
          );
        else if (!owned && current !== undefined)
          diagnostics.push(
            issue(
              "installers.mcp-collision",
              `${key} is not owned by Loom`,
              configPath,
            ),
          );
        configText = setPointer(configText, name, desired);
      }
      if (configText !== configContent)
        mutations.push(
          mutation(
            configContent === undefined ? "create-file" : "update-file",
            projectRoot,
            configPath,
            configText,
            configContent === undefined ? undefined : hash(configContent),
          ),
        );
    }
    if (diagnostics.some(({ level }) => level === "error"))
      mutations.length = 0;
    const digest = recipeDigest(recipe);
    const nextOwnership = structuredClone(state.value);
    delete nextOwnership.capabilities[FLUTTER_AGENT_PLUGINS_RECIPE.candidate];
    nextOwnership.capabilities[FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.candidate] =
      {
        recipeDigest: digest,
        recipe,
        files: Object.fromEntries([
          ...Object.entries(desiredFiles).map(
            ([path, content]) => [path, hash(content)] as const,
          ),
          ...(runtimeExpected === undefined
            ? []
            : ([[RUNTIME_PATH, runtimeExpected]] as const)),
        ]),
        pointers: Object.fromEntries(
          Object.entries(desiredPointers).map(([name, value]) => [
            `mcp.${name}`,
            { path: configPath, value },
          ]),
        ),
      } satisfies CapabilityOwnership;
    const ownershipContent = `${JSON.stringify(nextOwnership, null, 2)}\n`;
    if (mutations.length > 0 || ownershipContent !== state.content)
      mutations.push(
        mutation(
          state.content === undefined ? "create-file" : "update-file",
          projectRoot,
          OWNERSHIP_PATH,
          ownershipContent,
          state.content === undefined ? undefined : hash(state.content),
        ),
      );
    const processRequest: ProcessRequest = {
      command: this.#dartPath,
      args: ["pub", "get", "--enforce-lockfile"],
      cwd: toolRoot,
      env: {
        ...localEnvironment,
        ...(globalThis.process.env.PATH === undefined
          ? {}
          : { PATH: globalThis.process.env.PATH }),
      },
      shell: false,
    };
    const compileProcess = compileRequired
      ? {
          command: this.#dartPath,
          args: [
            "compile",
            "exe",
            join(
              toolRoot,
              ".pub-cache/hosted/pub.dev/dart_pubdev_mcp-0.9.0/bin/dart_pubdev_mcp.dart",
            ),
            "-o",
            resolve(projectRoot, RUNTIME_STAGED_PATH),
          ],
          cwd: toolRoot,
          env: {
            ...localEnvironment,
            ...(globalThis.process.env.PATH === undefined
              ? {}
              : { PATH: globalThis.process.env.PATH }),
          },
          shell: false as const,
        }
      : undefined;
    const hostedSelections = recipe.selectedSkills.filter(
      (selection): selection is PackageSkillBinding =>
        selection.source === "hosted-package",
    );
    const skillsProcess =
      hostedSelections.length === 0
        ? undefined
        : {
            command: this.#dartPath,
            args: [
              "run",
              "skills:skills",
              "-C",
              join(toolRoot, ".skills-stage"),
              "get",
              "--agent",
              "generic",
              ...hostedSelections.flatMap((selection) => [
                "--package",
                selection.package,
              ]),
              ...hostedSelections.flatMap((selection) => [
                "--skill",
                selection.path.split("/").at(-1)!,
              ]),
            ],
            cwd: toolRoot,
            env: {
              ...localEnvironment,
              ...(globalThis.process.env.PATH === undefined
                ? {}
                : { PATH: globalThis.process.env.PATH }),
            },
            shell: false as const,
          };
    const executionRequired =
      compileRequired ||
      !(await validToolPackageConfig(projectRoot)) ||
      (await safeReadBytes(projectRoot, RUNTIME_STAGED_PATH)) !== undefined;
    return this.#issue({
      candidate: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.candidate,
      root: projectRoot,
      recipeDigest: digest,
      recipe,
      mutations: diagnostics.some(({ level }) => level === "error")
        ? []
        : mutations,
      diagnostics,
      executionRequired,
      process: processRequest,
      ...(compileProcess === undefined ? {} : { compileProcess }),
      ...(skillsProcess === undefined ? {} : { skillsProcess }),
    });
  }

  async apply(plan: InstallerPlan, dryRun = false): Promise<InstallerResult> {
    const diagnostics = [...plan.diagnostics];
    const toolRoot = resolve(plan.root, plan.recipe.toolPath);
    const expectedEnvironment = {
      PUB_CACHE: join(toolRoot, ".pub-cache"),
      HOME: join(toolRoot, ".home"),
      XDG_CACHE_HOME: join(toolRoot, ".xdg/cache"),
      XDG_CONFIG_HOME: join(toolRoot, ".xdg/config"),
      XDG_DATA_HOME: join(toolRoot, ".xdg/data"),
      XDG_STATE_HOME: join(toolRoot, ".xdg/state"),
    };
    const processIsValid =
      plan.process.command === this.#dartPath &&
      isDeepStrictEqual(plan.process.args, [
        "pub",
        "get",
        "--enforce-lockfile",
      ]) &&
      plan.process.cwd === toolRoot &&
      plan.process.shell === false &&
      Object.entries(expectedEnvironment).every(
        ([key, value]) => plan.process.env[key] === value,
      ) &&
      (plan.skillsProcess === undefined ||
        (plan.skillsProcess.command === this.#dartPath &&
          plan.skillsProcess.cwd === toolRoot &&
          plan.skillsProcess.shell === false &&
          plan.skillsProcess.args[0] === "run" &&
          plan.skillsProcess.args[1] === "skills:skills" &&
          !plan.skillsProcess.args.includes("--all") &&
          Object.entries(expectedEnvironment).every(
            ([key, value]) => plan.skillsProcess?.env[key] === value,
          ))) &&
      (plan.compileProcess === undefined ||
        (plan.compileProcess.command === this.#dartPath &&
          isDeepStrictEqual(plan.compileProcess.args, [
            "compile",
            "exe",
            join(
              toolRoot,
              ".pub-cache/hosted/pub.dev/dart_pubdev_mcp-0.9.0/bin/dart_pubdev_mcp.dart",
            ),
            "-o",
            resolve(plan.root, RUNTIME_STAGED_PATH),
          ]) &&
          plan.compileProcess.cwd === toolRoot &&
          plan.compileProcess.shell === false &&
          Object.entries(expectedEnvironment).every(
            ([key, value]) => plan.compileProcess?.env[key] === value,
          )));
    if (
      !this.#plans.has(plan) ||
      plan.recipeDigest !== recipeDigest(plan.recipe) ||
      !processIsValid
    )
      return {
        changed: [],
        skipped: [],
        diagnostics: [
          ...diagnostics,
          issue(
            "installers.invalid-plan",
            "Plan was not issued by this installer instance",
          ),
        ],
      };
    const pending: AppliedMutation[] = [];
    for (const item of plan.mutations) {
      const relativePath = relative(plan.root, item.path).split(sep).join("/");
      const allowed =
        normalized(relativePath) &&
        (relativePath === OWNERSHIP_PATH ||
          CONFIG_PATHS.includes(relativePath as never) ||
          relativePath.startsWith(`${plan.recipe.toolPath}/`) ||
          /^\.agents\/skills\/[a-z0-9._-]+\//u.test(relativePath));
      const currentBytes = allowed
        ? await safeReadBytes(plan.root, relativePath).catch(() => {
            diagnostics.push(
              issue(
                "installers.unsafe-path",
                "Mutation path contains a symlink",
                item.path,
              ),
            );
            return undefined;
          })
        : undefined;
      const current = currentBytes?.toString("utf8");
      if (
        !allowed ||
        (item.kind === "create-file"
          ? current !== undefined
          : current === undefined || hash(current) !== item.expectedHash)
      )
        diagnostics.push(
          issue(
            "installers.concurrent-change",
            "File changed after planning",
            item.path,
          ),
        );
      else
        pending.push({
          mutation: item,
          relative: relativePath,
          ...(currentBytes === undefined
            ? {}
            : {
                previous: currentBytes,
                previousMode: (await lstat(item.path)).mode & 0o777,
              }),
        });
    }
    if (diagnostics.some(({ level }) => level === "error"))
      return {
        changed: [],
        skipped: plan.mutations.map(({ path }) => path),
        diagnostics,
      };
    if (dryRun)
      return {
        changed: pending.map(({ mutation: item }) => item.path),
        skipped: [],
        diagnostics,
      };
    if (pending.length === 0 && !plan.executionRequired)
      return { changed: [], skipped: [], diagnostics };
    const ownershipEntry = pending.find(
      ({ relative: path }) => path === OWNERSHIP_PATH,
    );
    const fileEntries = pending.filter(
      ({ relative: path }) => path !== OWNERSHIP_PATH,
    );
    const applied: typeof pending = [];
    const generatedNames = [".pub-cache", ".dart_tool", ".home", ".xdg"];
    const backupRoot = resolve(
      plan.root,
      ".loom",
      `.installer-rollback-${randomUUID()}`,
    );
    const generatedBackups: Array<{ path: string; backup: string }> = [];
    let effectsStarted = false;
    let installedRuntime: { previous?: Buffer; bytes: Buffer } | undefined;
    try {
      for (const entry of fileEntries) {
        const current = await safeReadBytes(plan.root, entry.relative);
        const unchanged =
          entry.previous === undefined
            ? current === undefined
            : current?.equals(entry.previous) === true;
        if (!unchanged) throw new Error("File changed during apply");
        const parent = dirname(entry.mutation.path);
        try {
          if (entry.mutation.kind === "delete-file") {
            await assertSafeDirectory(plan.root, parent);
            await this.#fileOperations.remove(entry.mutation.path);
          } else {
            await mkdir(parent, { recursive: true });
            await assertSafeDirectory(plan.root, parent);
            await this.#fileOperations.write(
              entry.mutation.path,
              entry.mutation.content!,
            );
          }
        } catch (cause) {
          const after = await safeReadBytes(plan.root, entry.relative).catch(
            () => undefined,
          );
          const intended =
            entry.mutation.kind === "delete-file"
              ? undefined
              : Buffer.from(entry.mutation.content!);
          if (
            intended === undefined
              ? after === undefined
              : after?.equals(intended) === true
          )
            applied.push(entry);
          throw cause;
        }
        applied.push(entry);
      }
      await validateToolDirectory(plan.root, diagnostics);
      if (diagnostics.some(({ level }) => level === "error"))
        throw new Error(diagnostics.map(({ message }) => message).join("; "));
      const stagedPath = resolve(plan.root, RUNTIME_STAGED_PATH);
      const stagedBytes = await safeReadBytes(plan.root, RUNTIME_STAGED_PATH);
      if (stagedBytes !== undefined)
        applied.push({
          mutation: {
            kind: "delete-file",
            path: stagedPath,
            expectedHash: hash(stagedBytes),
          },
          relative: RUNTIME_STAGED_PATH,
          previous: stagedBytes,
          previousMode: (await lstat(stagedPath)).mode & 0o777,
        });
      await rm(stagedPath, { force: true });
      await mkdir(backupRoot, { recursive: true });
      await assertSafeDirectory(plan.root, backupRoot);
      for (const name of generatedNames) {
        const path = resolve(toolRoot, name);
        await assertSafeDirectory(plan.root, path);
        const state = await lstat(path).catch(() => undefined);
        if (state !== undefined) {
          if (!state.isDirectory() || state.isSymbolicLink())
            throw new Error(`Generated state path is unsafe: ${name}`);
          const backup = resolve(backupRoot, name);
          await rename(path, backup);
          generatedBackups.push({ path, backup });
        }
      }
      effectsStarted = true;
      await Promise.all(
        [
          plan.process.env["PUB_CACHE"],
          plan.process.env["HOME"],
          plan.process.env["XDG_CACHE_HOME"],
          plan.process.env["XDG_CONFIG_HOME"],
          plan.process.env["XDG_DATA_HOME"],
          plan.process.env["XDG_STATE_HOME"],
        ].map(async (path) => {
          if (
            typeof path !== "string" ||
            !path.startsWith(
              `${resolve(plan.root, plan.recipe.toolPath)}${sep}`,
            )
          )
            throw new Error("Invalid local Dart environment path");
          await assertSafeDirectory(plan.root, path);
          await mkdir(path, { recursive: true });
          await assertSafeDirectory(plan.root, path);
        }),
      );
      const result = await this.#runner(plan.process);
      if (result.exitCode !== 0)
        throw new Error(
          `dart pub get --enforce-lockfile failed: ${result.stderr.trim()}`,
        );
      let generatedRuntime: Buffer | undefined;
      if (plan.compileProcess !== undefined) {
        const runtimePath = resolve(plan.root, RUNTIME_PATH);
        const stagedPath = resolve(plan.root, RUNTIME_STAGED_PATH);
        await mkdir(dirname(runtimePath), { recursive: true });
        await assertSafeDirectory(plan.root, dirname(runtimePath));
        await rm(stagedPath, { force: true });
        const compileResult = await this.#runner(plan.compileProcess);
        if (compileResult.exitCode !== 0)
          throw new Error(
            `dart compile exe failed: ${compileResult.stderr.trim()}`,
          );
        generatedRuntime = await safeReadBytes(plan.root, RUNTIME_STAGED_PATH);
        if (generatedRuntime === undefined)
          throw new Error("Dart compiler did not create the local executable");
        const previous = await safeReadBytes(plan.root, RUNTIME_PATH);
        const previousMode =
          previous === undefined
            ? undefined
            : (await lstat(runtimePath)).mode & 0o777;
        await atomicWrite(runtimePath, generatedRuntime);
        await chmod(runtimePath, 0o700);
        await rm(stagedPath, { force: true });
        const installed = await safeReadBytes(plan.root, RUNTIME_PATH);
        if (installed === undefined || !installed.equals(generatedRuntime))
          throw new Error("Installed runtime does not match staged bytes");
        installedRuntime = {
          ...(previous === undefined ? {} : { previous }),
          ...(previousMode === undefined ? {} : { previousMode }),
          bytes: generatedRuntime,
        };
      }
      if (plan.skillsProcess !== undefined)
        await runHostedSkills(plan.root, plan.skillsProcess, this.#runner);
      if (generatedRuntime !== undefined) {
        const currentRuntime = await safeReadBytes(plan.root, RUNTIME_PATH);
        if (
          currentRuntime === undefined ||
          !currentRuntime.equals(generatedRuntime)
        )
          throw new Error("Generated runtime changed during skill setup");
      }
      if (ownershipEntry !== undefined) {
        const parsed = JSON.parse(
          ownershipEntry.mutation.content!,
        ) as Ownership;
        const capability = parsed.capabilities[
          FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.candidate
        ] as CapabilityOwnership;
        if (generatedRuntime !== undefined)
          capability.files[RUNTIME_PATH] = hash(generatedRuntime);
        if (
          ownedRecord(capability, false, plan.root) === undefined ||
          capability.recipeDigest !== plan.recipeDigest
        )
          throw new Error("Final ownership manifest is invalid");
        const finalContent = `${JSON.stringify(parsed, null, 2)}\n`;
        const ownershipCurrent = await safeReadBytes(plan.root, OWNERSHIP_PATH);
        if (
          ownershipEntry.previous === undefined
            ? ownershipCurrent !== undefined
            : ownershipCurrent?.equals(ownershipEntry.previous) !== true
        )
          throw new Error("Ownership changed before final commit");
        try {
          await this.#fileOperations.write(
            ownershipEntry.mutation.path,
            finalContent,
          );
        } catch (cause) {
          const after = await safeReadBytes(plan.root, OWNERSHIP_PATH).catch(
            () => undefined,
          );
          if (after?.equals(Buffer.from(finalContent)) === true)
            applied.push({
              ...ownershipEntry,
              mutation: { ...ownershipEntry.mutation, content: finalContent },
            });
          throw cause;
        }
        applied.push({
          ...ownershipEntry,
          mutation: { ...ownershipEntry.mutation, content: finalContent },
        });
        const finalOwnership = await safeRead(plan.root, OWNERSHIP_PATH);
        const finalState = await readOwnership(plan.root);
        if (
          finalOwnership !== finalContent ||
          finalState.current?.recipeDigest !== plan.recipeDigest ||
          finalState.diagnostics.length > 0
        )
          throw new Error("Ownership changed during final commit");
      }
      if (generatedRuntime !== undefined) {
        const finalRuntime = await safeReadBytes(plan.root, RUNTIME_PATH);
        if (
          finalRuntime === undefined ||
          hash(finalRuntime) !== hash(generatedRuntime)
        )
          throw new Error("Runtime changed before ownership commit completed");
      }
      const rollbackToken = Object.freeze({ id: randomUUID() });
      this.#rollbacks.set(rollbackToken, {
        root: plan.root,
        toolRoot,
        applied,
        generatedNames,
        generatedBackups,
        backupRoot,
        effectsStarted,
        ...(installedRuntime === undefined ? {} : { installedRuntime }),
      });
      return {
        changed: [
          ...pending.map(({ mutation: item }) => item.path),
          ...(generatedRuntime === undefined
            ? []
            : [resolve(plan.root, RUNTIME_PATH)]),
        ],
        skipped: [],
        diagnostics,
        rollbackToken,
      };
    } catch (cause) {
      const rollbackFailures = await this.#restore({
        root: plan.root,
        toolRoot,
        applied,
        generatedNames,
        generatedBackups,
        backupRoot,
        effectsStarted,
        ...(installedRuntime === undefined ? {} : { installedRuntime }),
      });
      return {
        changed: [],
        skipped: plan.mutations.map(({ path }) => path),
        diagnostics: [
          ...diagnostics,
          issue(
            "installers.apply-failed",
            `${cause instanceof Error ? cause.message : String(cause)}; ${rollbackFailures.length === 0 ? "all mutations rolled back" : `rollback failed for ${rollbackFailures.join(", ")}`}`,
          ),
        ],
      };
    }
  }

  async verify(root: string): Promise<InstallerDiagnostic[]> {
    const projectRoot = resolve(root);
    const state = await readOwnership(projectRoot);
    const diagnostics = [...state.diagnostics];
    if (!state.current)
      return [
        ...diagnostics,
        {
          level: "warning",
          code: "installers.not-installed",
          message: "Flutter package intelligence is not installed",
        },
      ];
    for (const [path, expected] of Object.entries(state.current.files)) {
      const content = await safeReadBytes(projectRoot, path).catch(
        () => undefined,
      );
      if (content === undefined || hash(content) !== expected)
        diagnostics.push(
          issue(
            content === undefined
              ? "installers.missing-owned-file"
              : "installers.modified-owned-file",
            "Owned file does not match",
            path,
          ),
        );
    }
    for (const [key, pointer] of Object.entries(state.current.pointers)) {
      const content = await safeRead(projectRoot, pointer.path);
      const parsed =
        content === undefined
          ? undefined
          : parseJsonc(content, pointer.path).value;
      if (
        !parsed ||
        !isDeepStrictEqual(pointerValue(parsed, key.slice(4)), pointer.value)
      )
        diagnostics.push(
          issue(
            "installers.modified-owned-pointer",
            "Owned MCP config does not match",
            pointer.path,
          ),
        );
    }
    if (!(await validToolPackageConfig(projectRoot)))
      diagnostics.push(
        issue(
          "installers.package-config-missing",
          "Local Dart tool package is not activated",
        ),
      );
    return diagnostics;
  }

  async uninstall(root: string, dryRun = false): Promise<InstallerResult> {
    const projectRoot = resolve(root);
    const state = await readOwnership(projectRoot);
    const owned = state.current ?? state.legacy;
    if (!owned)
      return { changed: [], skipped: [], diagnostics: state.diagnostics };
    const diagnostics = [...state.diagnostics];
    if (state.current !== undefined)
      await validateToolDirectory(projectRoot, diagnostics);
    if (
      state.current !== undefined &&
      state.current.recipe.selectedSkills.length
    ) {
      try {
        const authenticated = await authenticateSelectedFiles(
          state.current.recipe,
          this.#runner,
          this.#dartPath,
          this.#gitPath,
          this.#temporaryDirectory,
        );
        const ownedSkills = Object.fromEntries(
          Object.entries(state.current.files).filter(([path]) =>
            path.startsWith(".agents/skills/"),
          ),
        );
        const authenticatedHashes = Object.fromEntries(
          Object.entries(authenticated).map(([path, content]) => [
            path,
            hash(content),
          ]),
        );
        if (!isDeepStrictEqual(ownedSkills, authenticatedHashes))
          throw new Error(
            "Authenticated skill manifest does not match ownership",
          );
      } catch (cause) {
        diagnostics.push(
          issue(
            "installers.skill-authentication",
            cause instanceof Error ? cause.message : String(cause),
          ),
        );
      }
    }
    const mutations: InstallerMutation[] = [];
    for (const [path, expected] of Object.entries(owned.files ?? {})) {
      const content = await managedReadBytes(projectRoot, path, diagnostics);
      if (content === undefined || hash(content) !== expected)
        diagnostics.push(
          issue(
            "installers.modified-owned-file",
            "Owned file changed; refusing removal",
            path,
          ),
        );
      else
        mutations.push(
          mutation("delete-file", projectRoot, path, undefined, expected),
        );
    }
    const pointerFiles = new Map<
      string,
      { content: string; updated: string }
    >();
    for (const [key, pointer] of Object.entries(owned.pointers ?? {})) {
      const existing = pointerFiles.get(pointer.path);
      const content =
        existing?.content ??
        (await managedRead(projectRoot, pointer.path, diagnostics));
      const parsed =
        content === undefined
          ? undefined
          : parseJsonc(content, pointer.path).value;
      if (
        !content ||
        !parsed ||
        !isDeepStrictEqual(pointerValue(parsed, key.slice(4)), pointer.value)
      )
        diagnostics.push(
          issue(
            "installers.modified-owned-pointer",
            "Owned MCP config changed; refusing removal",
            pointer.path,
          ),
        );
      else {
        const updated = setPointer(
          existing?.updated ?? content,
          key.slice(4),
          undefined,
        );
        pointerFiles.set(pointer.path, { content, updated });
      }
    }
    for (const [path, { content, updated }] of pointerFiles)
      if (updated !== content)
        mutations.push(
          mutation("update-file", projectRoot, path, updated, hash(content)),
        );
    const nextOwnership = structuredClone(state.value);
    delete nextOwnership.capabilities[
      FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.candidate
    ];
    delete nextOwnership.capabilities[FLUTTER_AGENT_PLUGINS_RECIPE.candidate];
    if (state.content !== undefined) {
      if (Object.keys(nextOwnership.capabilities).length === 0)
        mutations.push(
          mutation(
            "delete-file",
            projectRoot,
            OWNERSHIP_PATH,
            undefined,
            hash(state.content),
          ),
        );
      else
        mutations.push(
          mutation(
            "update-file",
            projectRoot,
            OWNERSHIP_PATH,
            `${JSON.stringify(nextOwnership, null, 2)}\n`,
            hash(state.content),
          ),
        );
    }
    if (diagnostics.some(({ level }) => level === "error"))
      return {
        changed: [],
        skipped: mutations.map(({ path }) => path),
        diagnostics,
      };
    if (dryRun)
      return {
        changed: mutations.map(({ path }) => path),
        skipped: [],
        diagnostics,
      };
    const ownershipCurrent = await safeRead(projectRoot, OWNERSHIP_PATH);
    if (ownershipCurrent !== state.content)
      return {
        changed: [],
        skipped: mutations.map(({ path }) => path),
        diagnostics: [
          ...diagnostics,
          issue(
            "installers.concurrent-change",
            "Ownership changed during uninstall",
            OWNERSHIP_PATH,
          ),
        ],
      };
    for (const item of mutations) {
      const relativePath = relative(projectRoot, item.path)
        .split(sep)
        .join("/");
      const current = await safeReadBytes(projectRoot, relativePath).catch(
        () => undefined,
      );
      if (current === undefined || hash(current) !== item.expectedHash)
        return {
          changed: [],
          skipped: mutations.map(({ path }) => path),
          diagnostics: [
            ...diagnostics,
            issue(
              "installers.concurrent-change",
              "File changed during uninstall",
              item.path,
            ),
          ],
        };
    }
    const journal: Array<{ item: InstallerMutation; previous: Buffer }> = [];
    try {
      for (const item of mutations) {
        const relativePath = relative(projectRoot, item.path)
          .split(sep)
          .join("/");
        const previous = await safeReadBytes(projectRoot, relativePath);
        if (previous === undefined || hash(previous) !== item.expectedHash)
          throw new Error("File changed during uninstall");
        const parent = dirname(item.path);
        try {
          if (item.kind === "delete-file") {
            await assertSafeDirectory(projectRoot, parent);
            await this.#fileOperations.remove(item.path);
          } else {
            await assertSafeDirectory(projectRoot, parent);
            await this.#fileOperations.write(item.path, item.content!);
          }
        } catch (cause) {
          const current = await safeReadBytes(projectRoot, relativePath).catch(
            () => undefined,
          );
          const intended =
            item.kind === "delete-file"
              ? undefined
              : Buffer.from(item.content!);
          if (
            intended === undefined
              ? current === undefined
              : current?.equals(intended) === true
          )
            journal.push({ item, previous });
          throw cause;
        }
        journal.push({ item, previous });
      }
    } catch (cause) {
      const rollbackFailures: string[] = [];
      for (const { item, previous } of journal.reverse()) {
        try {
          const relativePath = relative(projectRoot, item.path)
            .split(sep)
            .join("/");
          const current = await safeReadBytes(projectRoot, relativePath);
          const intended =
            item.kind === "delete-file"
              ? undefined
              : Buffer.from(item.content!);
          if (
            intended === undefined
              ? current !== undefined
              : current?.equals(intended) !== true
          )
            throw new Error("Changed before rollback");
          await atomicWrite(item.path, previous);
        } catch {
          rollbackFailures.push(item.path);
        }
      }
      return {
        changed: [],
        skipped: mutations.map(({ path }) => path),
        diagnostics: [
          ...diagnostics,
          issue(
            "installers.uninstall-failed",
            `${cause instanceof Error ? cause.message : String(cause)}; ${rollbackFailures.length === 0 ? "all mutations rolled back" : `rollback failed for ${rollbackFailures.join(", ")}`}`,
          ),
        ],
      };
    }
    return {
      changed: mutations.map(({ path }) => path),
      skipped: [],
      diagnostics,
    };
  }
}

export default CapabilityInstaller;
