#!/usr/bin/env node

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";

import { AntigravityHarnessAdapter } from "@loom/antigravity";
import { ClaudeHarnessAdapter } from "@loom/claude";
import { CodexHarnessAdapter } from "@loom/codex";
import {
  ALL_CAPABILITIES,
  PROJECT_STATE_FILES,
  SCHEMA_VERSION,
  STATE_DIRECTORY,
  VERSION,
  createCapabilityLock,
  createSetupPlan,
  createSetupTransaction,
  canonicalJson,
  computeRecipeDigest,
  decodeSetupIntent,
  detectProject,
  loadEffectivePolicy,
  capabilityLockSchema,
  ownershipStateSchema,
  projectStateSchema,
  redactLockSecrets,
  redactSecrets,
  setupApprovalSchema,
  setupPlanSchema,
  setupTransactionSchema,
  sha256,
  resolveLoomPaths,
  writeJsonAtomic,
  type CapabilityCandidate,
  type CapabilityPlan,
  type Diagnostic,
  type HarnessAdapter,
  workflowStateSchema,
} from "@loom/core";
import {
  CapabilityInstaller,
  FLUTTER_PACKAGE_INTELLIGENCE_RECIPE,
  type FlutterPackageIntelligenceInstallRecipe,
  type InstallerRollbackToken,
} from "@loom/installers";
import { OpenCodeHarnessAdapter } from "@loom/opencode";
import { OmpHarnessAdapter } from "@loom/omp";
import {
  AtomicTtlCache,
  BuiltinRegistry,
  getXdgCacheDirectory,
  OfficialMcpRegistry,
  SkillsCliRegistry,
  planProject,
  syncRegistryCache,
  discoverFlutterSkills,
  flutterSkillBindingHash,
  type ProjectResolution,
  type RegistrySnapshot,
} from "@loom/registry";

const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_APPROVAL = 3;
const REGISTRY_KEY = "official-mcp";
const REGISTRY_TTL = 60 * 60 * 1_000;
const ENTRY_PATH = fileURLToPath(import.meta.url);
const AUTO_ENTRY_DISABLED =
  Reflect.get(globalThis, Symbol.for("loom.cli.disable-auto-entry")) === true;

interface CliRuntime {
  skillsPath: string;
  executablePath: string | undefined;
}

interface CliRuntimeOptions {
  skillsPath: string;
  executablePath?: string;
}

const cliRuntime: CliRuntime = {
  skillsPath: fileURLToPath(new URL("../../skills", import.meta.url)),
  executablePath: undefined,
};

export function configureCliRuntime(options: CliRuntimeOptions): void {
  cliRuntime.skillsPath = resolve(options.skillsPath);
  cliRuntime.executablePath =
    options.executablePath === undefined
      ? undefined
      : resolve(options.executablePath);
}

export interface CliWriter {
  write(value: string): unknown;
}

export interface RunCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: CliWriter;
  stderr?: CliWriter;
  now?: () => Date;
  isTTY?: boolean;
  confirm?: (prompt: string) => Promise<boolean>;
  installerFactory?: (dartPath: string, gitPath: string) => SetupInstaller;
  resolveExecutable?: (
    name: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<string | undefined>;
  afterSetupMetadataWrite?: () => Promise<void>;
}

interface SetupInstaller {
  plan(
    root: string,
    recipe: FlutterPackageIntelligenceInstallRecipe,
  ): ReturnType<CapabilityInstaller["plan"]>;
  apply(
    plan: Awaited<ReturnType<CapabilityInstaller["plan"]>>,
    dryRun?: boolean,
  ): ReturnType<CapabilityInstaller["apply"]>;
  verify(root: string): ReturnType<CapabilityInstaller["verify"]>;
  rollback?(
    token: InstallerRollbackToken,
  ): ReturnType<CapabilityInstaller["rollback"]>;
  commit?(
    token: InstallerRollbackToken,
  ): ReturnType<CapabilityInstaller["commit"]>;
  uninstall(
    root: string,
    dryRun?: boolean,
  ): ReturnType<CapabilityInstaller["uninstall"]>;
}

interface HarnessPreimage {
  path: string;
  previous?: Buffer;
  mode?: number;
  intended?: Buffer;
}

interface MetadataPreimage {
  path: string;
  previous?: Buffer;
  mode?: number;
}

async function metadataPreimages(
  paths: readonly string[],
): Promise<MetadataPreimage[]> {
  return Promise.all(
    [...new Set(paths)].map(async (path) => {
      const state = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return undefined;
        throw cause;
      });
      if (state === undefined) return { path };
      if (!state.isFile() || state.isSymbolicLink())
        throw new Error("Setup metadata path is unsafe");
      return {
        path,
        previous: await readFile(path),
        mode: state.mode & 0o777,
      };
    }),
  );
}

async function restoreMetadataPreimages(
  preimages: readonly MetadataPreimage[],
): Promise<string[]> {
  const failures: string[] = [];
  for (const preimage of [...preimages].reverse())
    try {
      if (preimage.previous === undefined)
        await rm(preimage.path, { force: true });
      else {
        const temporary = `${preimage.path}.${randomBytes(16).toString("hex")}.tmp`;
        try {
          await writeFile(temporary, preimage.previous, {
            mode: preimage.mode ?? 0o600,
          });
          await rename(temporary, preimage.path);
          await chmod(preimage.path, preimage.mode ?? 0o600);
        } finally {
          await rm(temporary, { force: true });
        }
      }
    } catch {
      failures.push(preimage.path);
    }
  return failures;
}

async function assertHarnessPath(root: string, path: string): Promise<void> {
  const pathFromRoot = relative(root, path);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`)
  )
    throw new Error("Harness mutation escapes the project root");
  let current = root;
  for (const part of pathFromRoot.split(sep)) {
    current = join(current, part);
    const state = await lstat(current).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return undefined;
      throw cause;
    });
    if (state === undefined) return;
    if (state.isSymbolicLink())
      throw new Error("Harness mutation path contains a symlink");
  }
}

async function harnessPreimages(
  root: string,
  plan: Awaited<ReturnType<HarnessAdapter["planInstall"]>>,
): Promise<HarnessPreimage[]> {
  return Promise.all(
    plan.mutations.map(async (mutation) => {
      const path = resolve(mutation.path);
      await assertHarnessPath(root, path);
      const state = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return undefined;
        throw cause;
      });
      if (state !== undefined && !state.isFile())
        throw new Error("Harness mutation path is not a file");
      return {
        path,
        ...(state === undefined
          ? {}
          : { previous: await readFile(path), mode: state.mode & 0o777 }),
        ...(mutation.kind === "delete-file"
          ? {}
          : { intended: Buffer.from(mutation.content ?? "") }),
      };
    }),
  );
}

async function restoreHarnessPreimages(
  root: string,
  preimages: readonly HarnessPreimage[],
): Promise<string[]> {
  const failures: string[] = [];
  for (const preimage of [...preimages].reverse()) {
    try {
      await assertHarnessPath(root, preimage.path);
      const current = await readFile(preimage.path).catch(
        (cause: NodeJS.ErrnoException) => {
          if (cause.code === "ENOENT") return undefined;
          throw cause;
        },
      );
      if (
        preimage.intended === undefined
          ? current !== undefined
          : current?.equals(preimage.intended) !== true
      )
        throw new Error("Harness file changed before rollback");
      if (preimage.previous === undefined)
        await rm(preimage.path, { force: true });
      else {
        await mkdir(dirname(preimage.path), { recursive: true });
        const temporary = `${preimage.path}.${randomBytes(16).toString("hex")}.tmp`;
        try {
          await writeFile(temporary, preimage.previous, {
            mode: preimage.mode ?? 0o600,
          });
          await rename(temporary, preimage.path);
        } finally {
          await rm(temporary, { force: true });
        }
      }
    } catch {
      failures.push(preimage.path);
    }
  }
  return failures;
}

interface ParsedArguments {
  positionals: string[];
  flags: Map<string, string[]>;
}

interface CommandContext {
  root: string;
  env: NodeJS.ProcessEnv;
  stdout: CliWriter;
  stderr: CliWriter;
  now: () => Date;
  isTTY: boolean;
  confirm: (prompt: string) => Promise<boolean>;
  installerFactory: (dartPath: string, gitPath: string) => SetupInstaller;
  resolveExecutable: (
    name: string,
    environment: NodeJS.ProcessEnv,
  ) => Promise<string | undefined>;
  afterSetupMetadataWrite?: () => Promise<void>;
}

interface Envelope {
  schemaVersion: number;
  version: string;
  command: string;
  ok: boolean;
  data?: unknown;
  warnings?: string[];
  error?: { code: string; message: string };
}

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = EXIT_ERROR,
  ) {
    super(message);
  }
}

const usage = `Usage: loom <command>

Commands:
  detect [--json]
  plan [--json] [--task <text>] [--harness opencode|codex|claude|omp|antigravity]
  explain
  discover mcp|skills <query>
  capabilities [--json]
  connect [--dry-run] [--harness opencode|codex|claude|omp|antigravity]
  setup --intent <loom1_token> [--dry-run]
  transactions
  rollback <transaction-id>
  recover
  apply [--dry-run] [--harness opencode|codex|claude|omp|antigravity] [--task <text>] [--approve <id>]
  remove [--dry-run] [--harness opencode|codex|claude|omp|antigravity]
  doctor [--json] [--harness opencode|codex|claude|omp|antigravity]
  registry sync|status
  upgrades
  upgrade --review
  mcp`;

function parseArguments(args: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const valueFlags = new Set(["approve", "harness", "intent", "task"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const [rawName, inline] = argument.slice(2).split(/=(.*)/su, 2);
    if (!rawName)
      throw new CliError("usage.invalid-option", argument, EXIT_USAGE);
    let value = inline ?? "true";
    if (valueFlags.has(rawName) && inline === undefined) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--"))
        throw new CliError(
          "usage.missing-option-value",
          `--${rawName} requires a value`,
          EXIT_USAGE,
        );
      value = next;
      index += 1;
    }
    flags.set(rawName, [...(flags.get(rawName) ?? []), value]);
  }
  return { positionals, flags };
}

function assertFlags(
  parsed: ParsedArguments,
  allowed: readonly string[],
): void {
  const accepted = new Set(allowed);
  const invalid = [...parsed.flags.keys()].filter(
    (flag) => !accepted.has(flag),
  );
  if (invalid.length > 0)
    throw new CliError(
      "usage.unknown-option",
      `Unknown option: --${invalid.sort()[0]}`,
      EXIT_USAGE,
    );
}

function flag(parsed: ParsedArguments, name: string): boolean {
  return parsed.flags.has(name);
}

function value(parsed: ParsedArguments, name: string): string | undefined {
  return parsed.flags.get(name)?.at(-1);
}

function jsonEnvelope(
  command: string,
  data: unknown,
  warnings: string[] = [],
): Envelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    version: VERSION,
    command,
    ok: true,
    data: safe(data),
    ...(warnings.length === 0 ? {} : { warnings: warnings.sort() }),
  };
}

function safe(value: unknown): unknown {
  return scrubStrings(redactSecrets(value));
}

function scrubStrings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubStrings);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubStrings(item)]),
    );
  if (typeof value !== "string") return value;
  return value
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/giu, "$1[REDACTED]@")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/giu, "$1[REDACTED]")
    .replace(
      /\b(password|secret|token|api[-_]?key)=([^\s&]+)/giu,
      "$1=[REDACTED]",
    );
}

function printJson(writer: CliWriter, envelope: Envelope): void {
  writer.write(`${JSON.stringify(safe(envelope), null, 2)}\n`);
}

function printLines(writer: CliWriter, lines: readonly string[]): void {
  writer.write(`${lines.join("\n")}\n`);
}

function adapterFor(id: string | undefined): HarnessAdapter {
  const harness = id ?? "opencode";
  const executable = cliRuntime.executablePath;
  if (harness === "opencode")
    return new OpenCodeHarnessAdapter({
      command: executable
        ? [executable, "mcp"]
        : [process.execPath, ENTRY_PATH, "mcp"],
      skillsSource: cliRuntime.skillsPath,
    });
  if (harness === "codex")
    return new CodexHarnessAdapter({
      command: executable ?? ENTRY_PATH,
      skillsSource: cliRuntime.skillsPath,
    });
  if (harness === "claude")
    return new ClaudeHarnessAdapter({
      command: executable ?? process.execPath,
      args: executable ? ["mcp"] : [ENTRY_PATH, "mcp"],
      skillsSource: cliRuntime.skillsPath,
    });
  if (harness === "omp")
    return new OmpHarnessAdapter({
      command: executable ?? process.execPath,
      args: executable ? ["mcp"] : [ENTRY_PATH, "mcp"],
      skillsSource: cliRuntime.skillsPath,
    });
  if (harness === "antigravity")
    return new AntigravityHarnessAdapter({
      command: executable ?? process.execPath,
      args: executable ? ["mcp"] : [ENTRY_PATH, "mcp"],
      skillsSource: cliRuntime.skillsPath,
    });
  throw new CliError(
    "usage.invalid-harness",
    `Unsupported harness: ${harness}`,
    EXIT_USAGE,
  );
}

function projectLines(project: ReturnType<typeof detectProject>): string[] {
  return [
    "Project",
    `  lifecycle        ${project.lifecycle}`,
    `  languages        ${project.languages.join(", ") || "none"}`,
    `  frameworks       ${project.frameworks.join(", ") || "none"}`,
    `  package managers ${project.packageManagers.join(", ") || "none"}`,
    `  services         ${project.services.join(", ") || "none"}`,
    `  monorepo         ${project.monorepo ? "yes" : "no"}`,
  ];
}

function planLines(resolution: ProjectResolution): string[] {
  const selected = resolution.plan.selected.map((item) => item.candidate.id);
  const approvals = resolution.plan.requiredApprovals.map(
    (item) => item.capabilityId,
  );
  return [
    ...projectLines(resolution.project),
    "Plan",
    `  task             ${resolution.task.summary ?? "project defaults"}`,
    `  selected         ${selected.join(", ") || "none"}`,
    `  uncovered        ${resolution.plan.uncovered.join(", ") || "none"}`,
    `  approvals        ${approvals.join(", ") || "none"}`,
  ];
}

async function resolvePlan(
  root: string,
  task?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProjectResolution> {
  return planProject(root, {
    ...(task === undefined ? {} : { task }),
    policy: await loadEffectivePolicy(root, environment),
  });
}

async function detectCommand(
  parsed: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  assertFlags(parsed, ["json"]);
  if (parsed.positionals.length !== 0) throw usageError();
  const project = detectProject(context.root);
  if (flag(parsed, "json"))
    printJson(context.stdout, jsonEnvelope("detect", project));
  else printLines(context.stdout, projectLines(project));
  return 0;
}

async function planCommand(
  parsed: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  assertFlags(parsed, ["harness", "json", "task"]);
  if (parsed.positionals.length !== 0) throw usageError();
  const resolution = await resolvePlan(
    context.root,
    value(parsed, "task"),
    context.env,
  );
  const adapter =
    value(parsed, "harness") === undefined
      ? undefined
      : adapterFor(value(parsed, "harness"));
  const harnessPlan = adapter
    ? await adapter.planInstall(context.root, resolution.plan)
    : undefined;
  const data = {
    ...resolution,
    ...(harnessPlan === undefined
      ? {}
      : {
          harnessPlan: {
            ...harnessPlan,
            mutations: harnessPlan.mutations.map(
              ({ content: _content, ...mutation }) => mutation,
            ),
          },
        }),
  };
  if (flag(parsed, "json"))
    printJson(context.stdout, jsonEnvelope("plan", data));
  else {
    const lines = planLines(resolution);
    if (harnessPlan)
      lines.push(
        "Harness",
        `  id               ${harnessPlan.harness}`,
        `  mutations        ${harnessPlan.mutations.length}`,
        `  errors           ${harnessPlan.diagnostics.filter((item) => item.level === "error").length}`,
      );
    printLines(context.stdout, lines);
  }
  return harnessPlan?.diagnostics.some((item) => item.level === "error")
    ? EXIT_ERROR
    : 0;
}

async function explainCommand(
  parsed: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  assertFlags(parsed, []);
  if (parsed.positionals.length !== 0) throw usageError();
  const resolution = await resolvePlan(context.root, undefined, context.env);
  const lines = [...planLines(resolution), "Decisions"];
  for (const item of resolution.plan.selected)
    lines.push(
      `  select ${item.candidate.id}: ${item.reasons.join("; ") || "required coverage"}`,
    );
  for (const item of resolution.plan.rejected)
    lines.push(`  reject ${item.capability.candidate.id}: ${item.reason}`);
  printLines(context.stdout, lines);
  return 0;
}

async function discoverCommand(
  parsed: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  assertFlags(parsed, []);
  const [kind, ...queryParts] = parsed.positionals;
  const query = queryParts.join(" ").trim();
  if ((kind !== "mcp" && kind !== "skills") || query.length === 0)
    throw usageError();
  const warnings: string[] = [];
  let candidates: CapabilityCandidate[];
  if (kind === "mcp") {
    const builtin = new BuiltinRegistry();
    const local = await builtin.search({
      text: query,
      kinds: ["mcp"],
      limit: 30,
    });
    try {
      const remote = await new OfficialMcpRegistry().search({
        text: query,
        kinds: ["mcp"],
        limit: 30,
      });
      candidates = [...local, ...remote];
    } catch (error) {
      warnings.push(`Official MCP registry unavailable: ${message(error)}`);
      candidates = local;
    }
  } else {
    try {
      candidates = await new SkillsCliRegistry().search({
        text: query,
        kinds: ["skill"],
        limit: 30,
      });
      if (candidates.length === 0)
        warnings.push(
          "Skills registry returned no results; its discovery command may be unavailable",
        );
    } catch (error) {
      warnings.push(`Skills registry unavailable: ${message(error)}`);
      candidates = [];
    }
  }
  const unique = [
    ...new Map(candidates.map((item) => [item.id, item])).values(),
  ].sort((a, b) => a.id.localeCompare(b.id));
  printLines(context.stdout, [
    `Discovery (${kind})`,
    ...unique.map((item) => `  ${item.id}  ${item.name}  ${item.trustTier}`),
    ...(unique.length === 0 ? ["  no candidates"] : []),
    ...warnings.map((item) => `Warning: ${item}`),
  ]);
  return 0;
}

async function capabilitiesCommand(
  parsed: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  assertFlags(parsed, ["json"]);
  if (parsed.positionals.length !== 0) throw usageError();
  const capabilities = [...ALL_CAPABILITIES].sort();
  if (flag(parsed, "json"))
    printJson(context.stdout, jsonEnvelope("capabilities", { capabilities }));
  else
    printLines(context.stdout, [
      "Capabilities",
      ...capabilities.map((item) => `  ${item}`),
    ]);
  return 0;
}

function approvalError(
  plan: CapabilityPlan,
  approved: readonly string[],
): CliError | undefined {
  const supplied = new Set(approved);
  const requested = new Set(
    plan.requiredApprovals.map((item) => item.capabilityId),
  );
  const unknown = [...supplied].filter((id) => !requested.has(id)).sort();
  if (unknown.length > 0)
    return new CliError(
      "approval.unknown",
      `Approvals were not requested: ${unknown.join(", ")}`,
      EXIT_USAGE,
    );
  const missing = plan.requiredApprovals
    .map((item) => item.capabilityId)
    .filter((id) => !supplied.has(id));
  return missing.length === 0
    ? undefined
    : new CliError(
        "approval.required",
        `Required approvals not supplied: ${missing.join(", ")}`,
        EXIT_APPROVAL,
      );
}

async function connectCommand(
  parsed: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  assertFlags(parsed, ["dry-run", "harness"]);
  if (parsed.positionals.length !== 0) throw usageError();
  const adapter = adapterFor(value(parsed, "harness"));
  const resolution = await resolvePlan(context.root, undefined, context.env);
  const mutationPlan = await adapter.planInstall(context.root, resolution.plan);
  const result = await adapter.apply(mutationPlan, flag(parsed, "dry-run"));
  printLines(context.stdout, [
    flag(parsed, "dry-run")
      ? `Connect preview (${adapter.id})`
      : `Connect (${adapter.id})`,
    `  changed ${result.changed.length}`,
    `  skipped ${result.skipped.length}`,
    ...result.diagnostics.map(
      (item) => `  ${item.level} ${item.code}: ${item.message}`,
    ),
  ]);
  return hasErrors(result.diagnostics) ? EXIT_ERROR : 0;
}

async function executablePath(
  name: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

async function readSetupApproval(
  root: string,
  environment: NodeJS.ProcessEnv,
): Promise<ReturnType<typeof setupApprovalSchema.parse> | undefined> {
  const path = await setupApprovalPath(root, environment);
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as {
      approval?: unknown;
      mac?: unknown;
    };
    const approval = setupApprovalSchema.parse(value.approval);
    if (typeof value.mac !== "string")
      throw new Error("Invalid setup approval");
    const expected = approvalMac(
      await approvalKey(environment),
      root,
      approval,
    );
    const actualBytes = Buffer.from(value.mac, "hex");
    const expectedBytes = Buffer.from(expected, "hex");
    if (
      actualBytes.length !== expectedBytes.length ||
      !timingSafeEqual(actualBytes, expectedBytes)
    )
      throw new Error("Setup approval authentication failed");
    return approval;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

async function approvalKey(environment: NodeJS.ProcessEnv): Promise<Buffer> {
  const state = resolveLoomPaths(environment).state;
  await mkdir(state, { recursive: true, mode: 0o700 });
  const info = await lstat(state);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Loom state directory is unsafe");
  const path = join(state, "approval.key");
  try {
    await writeFile(path, randomBytes(32), { flag: "wx", mode: 0o600 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
  const key = await readFile(path);
  if (key.length !== 32) throw new Error("Invalid Loom approval key");
  return key;
}

async function setupApprovalPath(
  root: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const directory = join(resolveLoomPaths(environment).state, "approvals");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Loom approval directory is unsafe");
  return join(directory, `${sha256(resolve(root)).slice(7)}.json`);
}

function approvalMac(
  key: Buffer,
  root: string,
  approval: ReturnType<typeof setupApprovalSchema.parse>,
): string {
  return createHmac("sha256", key)
    .update(canonicalJson({ root: resolve(root), approval }))
    .digest("hex");
}

async function writeSetupApproval(
  root: string,
  environment: NodeJS.ProcessEnv,
  approval: ReturnType<typeof setupApprovalSchema.parse>,
): Promise<void> {
  const key = await approvalKey(environment);
  await writeJsonAtomic(await setupApprovalPath(root, environment), {
    approval,
    mac: approvalMac(key, root, approval),
  });
}

async function removeSetupApproval(
  root: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await rm(await setupApprovalPath(root, environment), { force: true });
}

async function assertSafeSetupState(root: string): Promise<void> {
  const directory = join(root, STATE_DIRECTORY);
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Project .loom state directory is unsafe");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    await mkdir(directory, { mode: 0o700 });
  }
}

async function setupCommand(
  parsed: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  assertFlags(parsed, ["dry-run", "intent"]);
  if (parsed.positionals.length !== 0) throw usageError();
  const encoded = value(parsed, "intent");
  if (encoded === undefined)
    throw new CliError(
      "setup.intent-required",
      "--intent is required",
      EXIT_USAGE,
    );
  const intent = decodeSetupIntent(encoded);
  if (intent.mode !== "apply")
    throw new CliError("setup.invalid-mode", "Setup intent is not applicable");
  if (intent.harness !== "opencode")
    throw new CliError(
      "setup.unsupported-harness",
      "The first audited setup recipe supports OpenCode only",
    );
  await assertSafeSetupState(context.root);
  const actualRoot = await realpath(context.root);
  if (intent.root !== actualRoot)
    throw new CliError(
      "setup.intent-root-mismatch",
      "The setup command was generated for a different project root",
    );
  const adapter = adapterFor(intent.harness);
  const harnessState = await adapter.inspect(context.root);
  if (!harnessState.installed)
    throw new CliError(
      "setup.not-connected",
      "Run loom connect --harness opencode and restart OpenCode before setup",
    );
  const policy = await loadEffectivePolicy(context.root, context.env);
  const resolution = await planProject(context.root, {
    ...(intent.task === undefined ? {} : { task: intent.task }),
    policy,
  });
  if (resolution.plan.uncovered.length > 0)
    throw new CliError(
      "plan.uncovered",
      `Required capabilities are uncovered: ${resolution.plan.uncovered.join(", ")}`,
    );
  const selected = resolution.plan.selected.map((item) => item.candidate.id);
  const resolvedCapabilities = [
    ...new Set(resolution.plan.selected.flatMap((item) => item.coverage)),
  ].sort();
  if (
    canonicalJson([...intent.requestedCapabilities].sort()) !==
    canonicalJson(resolvedCapabilities)
  )
    throw new CliError(
      "setup.intent-stale",
      "The generated setup intent no longer matches the resolved capabilities",
    );
  const unsupported = selected.filter(
    (id) =>
      id !== FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.candidate &&
      id !== "builtin:dart-flutter-mcp",
  );
  if (unsupported.length > 0)
    throw new CliError(
      "setup.recipe-unavailable",
      `No audited install recipe is available for: ${unsupported.join(", ")}`,
    );
  const skillSearch =
    intent.selectedSkills.length === 0
      ? { candidates: [] }
      : await discoverFlutterSkills(
          context.root,
          resolution.project,
          resolution.task,
        );
  const availableSkills = new Map(
    skillSearch.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const selectedSkills = intent.selectedSkills.map((selection) => {
    const candidate = availableSkills.get(selection.id);
    if (candidate === undefined)
      throw new CliError(
        "setup.skill-stale",
        `Selected skill is unrelated or stale: ${selection.id}`,
      );
    if (selection.bindingHash !== flutterSkillBindingHash(candidate))
      throw new CliError(
        "setup.skill-stale",
        `Selected skill binding changed: ${selection.id}`,
      );
    if (
      candidate.source === "hosted-package" &&
      candidate.package !== undefined &&
      candidate.packageVersion !== undefined &&
      candidate.packageContentHash !== undefined &&
      candidate.archiveHash !== undefined &&
      candidate.contentHash !== undefined
    ) {
      return {
        source: candidate.source,
        id: candidate.id,
        reason: selection.reason,
        package: candidate.package,
        version: candidate.packageVersion,
        packageContentHash: candidate.packageContentHash,
        archiveHash: candidate.archiveHash,
        path: candidate.path,
        contentHash: candidate.contentHash,
      } as const;
    }
    if (
      candidate.source === "skills-registry" &&
      candidate.repository !== undefined &&
      candidate.commit !== undefined &&
      candidate.contentHash !== undefined
    ) {
      return {
        source: candidate.source,
        id: candidate.id,
        reason: selection.reason,
        repository: candidate.repository,
        commit: candidate.commit,
        path: candidate.path,
        contentHash: candidate.contentHash,
      } as const;
    }
    throw new CliError(
      "setup.skill-unpinned",
      `Selected skill is not exactly pinned: ${selection.id}`,
    );
  });
  const recipe: FlutterPackageIntelligenceInstallRecipe = {
    kind: "flutter-package-intelligence",
    toolPath: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.toolPath,
    dartPubdevMcp: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.dartPubdevMcp,
    skillsCli: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.skillsCli,
    pubspecHash: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.pubspecHash,
    lockfileHash: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.lockfileHash,
    selectedSkills,
    ...(intent.selectionRationale === undefined
      ? {}
      : { selectionRationale: intent.selectionRationale }),
  };
  const candidates = resolution.project.frameworks.some(
    (name) => name === "flutter" || name === "dart",
  )
    ? [
        {
          id: FLUTTER_PACKAGE_INTELLIGENCE_RECIPE.candidate,
          capabilities: resolvedCapabilities,
          recipe,
          recipeDigest: computeRecipeDigest(recipe),
        },
      ]
    : [];
  const {
    detectionSignals: _detectionSignals,
    existingAgentConfigs: _existingAgentConfigs,
    ...projectBinding
  } = resolution.project;
  const projectFingerprint = sha256(canonicalJson(projectBinding));
  if (intent.projectFingerprint !== projectFingerprint)
    throw new CliError(
      "setup.intent-stale",
      "The project changed after this setup command was generated",
    );
  const now = context.now();
  const safeTask =
    intent.task === undefined ? undefined : String(safe(intent.task));
  const dart =
    candidates.length === 0
      ? undefined
      : await context.resolveExecutable("dart", context.env);
  if (candidates.length > 0 && dart === undefined)
    throw new CliError(
      "setup.dart-unavailable",
      "The audited Flutter recipe requires an executable dart SDK on PATH",
    );
  const dartDigest =
    dart === undefined ? undefined : sha256(await readFile(dart));
  const git =
    candidates.length === 0
      ? undefined
      : await context.resolveExecutable("git", context.env);
  if (candidates.length > 0 && git === undefined)
    throw new CliError(
      "setup.git-unavailable",
      "The audited Flutter recipe requires an executable git on PATH",
    );
  const gitDigest = git === undefined ? undefined : sha256(await readFile(git));
  const activationBinding =
    dart === undefined || git === undefined
      ? { loomVersion: VERSION }
      : {
          loomVersion: VERSION,
          installerVersion: VERSION,
          dart: { path: dart, digest: dartDigest },
          git: { path: git, digest: gitDigest },
          command: [dart, "mcp-server"],
          packageTool: recipe,
        };
  let setupPlan = createSetupPlan({
    schemaVersion: 1,
    root: actualRoot,
    projectFingerprint,
    harness: adapter.id,
    ...(safeTask === undefined ? {} : { task: safeTask }),
    mode: "apply",
    candidates,
    policyHash: sha256(canonicalJson(policy)),
    inputHash: sha256(
      canonicalJson({
        projectBinding,
        activationBinding,
        pubspec: await readFile(
          join(context.root, "pubspec.yaml"),
          "utf8",
        ).catch(() => ""),
        lockfile: await readFile(
          join(context.root, "pubspec.lock"),
          "utf8",
        ).catch(() => ""),
        packageConfig: await readFile(
          join(context.root, ".dart_tool/package_config.json"),
          "utf8",
        ).catch(() => ""),
        selectedSkills,
      }),
    ),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
  });
  const installer =
    dart === undefined || git === undefined
      ? undefined
      : context.installerFactory(dart, git);
  const harnessPlan = await adapter.planInstall(context.root, resolution.plan);
  const installerPlan =
    installer === undefined
      ? undefined
      : await installer.plan(context.root, recipe);
  if (installerPlan && hasErrors(installerPlan.diagnostics))
    throw new CliError(
      "setup.install-plan-invalid",
      installerPlan.diagnostics.map((item) => item.message).join("; "),
    );
  const {
    planId: _basePlanId,
    inputHash: baseInputHash,
    ...basePlan
  } = setupPlan;
  setupPlan = createSetupPlan({
    ...basePlan,
    inputHash: sha256(
      canonicalJson({
        baseInputHash,
        installerPlan:
          installerPlan === undefined
            ? null
            : {
                recipeDigest: installerPlan.recipeDigest,
                executionRequired: installerPlan.executionRequired,
                mutations: installerPlan.mutations.map((item) => ({
                  kind: item.kind,
                  path: item.path,
                  ...(item.content === undefined
                    ? {}
                    : { contentHash: sha256(item.content) }),
                  ...(item.expectedHash === undefined
                    ? {}
                    : { expectedHash: item.expectedHash }),
                })),
                process: installerPlan.process,
                ...(installerPlan.compileProcess === undefined
                  ? {}
                  : { compileProcess: installerPlan.compileProcess }),
                ...(installerPlan.skillsProcess === undefined
                  ? {}
                  : { skillsProcess: installerPlan.skillsProcess }),
              },
        harnessMutations: harnessPlan.mutations.map((item) => ({
          kind: item.kind,
          path: item.path,
          ...(item.content === undefined
            ? {}
            : { contentHash: sha256(item.content) }),
          ...(item.expectedHash === undefined
            ? {}
            : { expectedHash: item.expectedHash }),
        })),
      }),
    ),
  });
  const previousApproval = await readSetupApproval(context.root, context.env);
  const recipeDigests = candidates.map((item) => item.recipeDigest).sort();
  const approvalReusable =
    previousApproval !== undefined &&
    (previousApproval.planId === setupPlan.planId ||
      ((installerPlan?.mutations.length ?? 0) === 0 &&
        installerPlan?.executionRequired !== true &&
        harnessPlan.mutations.length === 0)) &&
    canonicalJson([...previousApproval.approvedRecipeDigests].sort()) ===
      canonicalJson(recipeDigests) &&
    Date.parse(previousApproval.expiresAt) > now.getTime();
  const dryRun = flag(parsed, "dry-run");
  printLines(context.stdout, [
    dryRun ? "Setup preview" : "Setup",
    `  plan             ${setupPlan.planId}`,
    `  harness          ${adapter.id}`,
    `  capabilities     ${selected.join(", ") || "none"}`,
    "  source           dart_pubdev_mcp@0.9.0 + skills@1.0.0",
    `  activation       ${dart ?? "none"} mcp-server + dart-pubdev-explorer`,
    `  skill paths      ${selectedSkills.length} explicitly selected under .agents/skills`,
    `  installer files  ${installerPlan?.mutations.length ?? 0}`,
    `  harness changes  ${harnessPlan.mutations.length}`,
    `  approval         ${approvalReusable ? "reused" : "required once"}`,
  ]);
  if (dryRun) return 0;
  if (!approvalReusable && candidates.length > 0) {
    if (!context.isTTY)
      throw new CliError(
        "setup.confirmation-required",
        "Run loom setup in an interactive terminal to review and confirm the exact plan",
        EXIT_APPROVAL,
      );
    if (!(await context.confirm("Install and activate this exact setup plan?")))
      throw new CliError(
        "setup.cancelled",
        "Setup was not approved",
        EXIT_APPROVAL,
      );
  }
  if (
    (dart !== undefined && sha256(await readFile(dart)) !== dartDigest) ||
    (git !== undefined && sha256(await readFile(git)) !== gitDigest)
  )
    throw new CliError(
      "setup.executable-drift",
      "Dart or Git changed after setup review; generate a new setup command",
    );
  if (
    approvalReusable &&
    (installerPlan?.mutations.length ?? 0) === 0 &&
    installerPlan?.executionRequired !== true &&
    harnessPlan.mutations.length === 0
  ) {
    printLines(context.stdout, ["Setup complete", "  no changes"]);
    return 0;
  }
  const transaction = createSetupTransaction(setupPlan, now);
  let installerRollback: InstallerRollbackToken | undefined;
  let harnessChanged = false;
  let harnessRollback: HarnessPreimage[] = [];
  let metadataRollback: MetadataPreimage[] = [];
  try {
    if (installer && installerPlan) {
      const result = await installer.apply(installerPlan);
      if (hasErrors(result.diagnostics))
        throw new Error(
          result.diagnostics.map((item) => item.message).join("; "),
        );
      installerRollback = result.rollbackToken;
    }
    harnessRollback = await harnessPreimages(context.root, harnessPlan);
    const harnessResult = await adapter.apply(harnessPlan);
    if (hasErrors(harnessResult.diagnostics))
      throw new Error(
        harnessResult.diagnostics.map((item) => item.message).join("; "),
      );
    harnessChanged = harnessResult.changed.length > 0;
    const verification = [
      ...(installer ? await installer.verify(context.root) : []),
      ...(await adapter.verify(context.root)),
    ];
    if (hasErrors(verification))
      throw new Error(verification.map((item) => item.message).join("; "));
    const loomState = resolveLoomPaths(context.env).state;
    metadataRollback = await metadataPreimages([
      ...Object.values(PROJECT_STATE_FILES).map((name) =>
        join(context.root, STATE_DIRECTORY, name),
      ),
      join(loomState, "approval.key"),
      join(
        loomState,
        "approvals",
        `${sha256(resolve(context.root)).slice(7)}.json`,
      ),
    ]);
    await writeJsonAtomic(
      join(context.root, STATE_DIRECTORY, PROJECT_STATE_FILES.setupPlan),
      setupPlan,
    );
    await writeJsonAtomic(
      join(context.root, STATE_DIRECTORY, PROJECT_STATE_FILES.setupTransaction),
      transaction,
    );
    await writeState(context, adapter.id, resolution, selected);
    await writeJsonAtomic(
      join(context.root, STATE_DIRECTORY, PROJECT_STATE_FILES.setupPlan),
      setupPlanSchema.parse(setupPlan),
    );
    if (candidates.length > 0)
      await writeSetupApproval(
        context.root,
        context.env,
        setupApprovalSchema.parse({
          schemaVersion: 1,
          planId: setupPlan.planId,
          approvedRecipeDigests: recipeDigests,
          approvedAt: now.toISOString(),
          expiresAt: new Date(
            now.getTime() + 365 * 24 * 60 * 60_000,
          ).toISOString(),
        }),
      );
    const finishedAt = context.now().toISOString();
    await writeJsonAtomic(
      join(context.root, STATE_DIRECTORY, PROJECT_STATE_FILES.setupTransaction),
      setupTransactionSchema.parse({
        ...transaction,
        status: "succeeded",
        updatedAt: finishedAt,
        receipt: {
          schemaVersion: 1,
          transactionId: transaction.transactionId,
          planId: setupPlan.planId,
          status: "succeeded",
          startedAt: transaction.createdAt,
          finishedAt,
          items: candidates.map((item) => ({
            candidateId: item.id,
            recipeDigest: item.recipeDigest,
            status: "installed",
          })),
        },
      }),
    );
    await context.afterSetupMetadataWrite?.();
    if (installerRollback !== undefined) {
      if (installer?.commit === undefined)
        throw new Error("Installer rollback commit is unavailable");
      const commitDiagnostics = await installer.commit(installerRollback);
      if (hasErrors(commitDiagnostics))
        throw new Error(
          commitDiagnostics.map(({ message }) => message).join("; "),
        );
      installerRollback = undefined;
    }
  } catch (cause) {
    const rollbackErrors: string[] = [];
    if (harnessChanged)
      rollbackErrors.push(
        ...(await restoreHarnessPreimages(context.root, harnessRollback)),
      );
    if (installerRollback !== undefined && installer) {
      try {
        if (installer.rollback === undefined)
          throw new Error("Installer rollback is unavailable");
        const result = await installer.rollback(installerRollback);
        rollbackErrors.push(
          ...result.diagnostics
            .filter(({ level }) => level === "error")
            .map(({ message }) => message),
        );
      } catch (rollbackCause) {
        rollbackErrors.push(message(rollbackCause));
      }
    }
    rollbackErrors.push(...(await restoreMetadataPreimages(metadataRollback)));
    const failure = [message(cause), ...rollbackErrors].join("; ");
    if (rollbackErrors.length === 0) throw cause;
    throw new Error(failure, { cause });
  }
  printLines(context.stdout, [
    "Setup complete",
    `  plan             ${setupPlan.planId}`,
    `  transaction      ${transaction.transactionId}`,
    "  doctor           ok",
  ]);
  return 0;
}

async function readSetupTransaction(root: string) {
  await assertSafeSetupState(root);
  try {
    return setupTransactionSchema.parse(
      JSON.parse(
        await readFile(
          join(root, STATE_DIRECTORY, PROJECT_STATE_FILES.setupTransaction),
          "utf8",
        ),
      ) as unknown,
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

async function transactionsCommand(
  parsed: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  assertFlags(parsed, []);
  if (parsed.positionals.length !== 0) throw usageError();
  const transaction = await readSetupTransaction(context.root);
  printLines(context.stdout, [
    "Transactions",
    ...(transaction
      ? [
          `  ${transaction.transactionId} ${transaction.status} ${transaction.planId}`,
        ]
      : ["  none"]),
  ]);
  return 0;
}

async function rollbackSetup(
  context: CommandContext,
  transaction: NonNullable<Awaited<ReturnType<typeof readSetupTransaction>>>,
): Promise<void> {
  const plan = setupPlanSchema.parse(
    JSON.parse(
      await readFile(
        join(context.root, STATE_DIRECTORY, PROJECT_STATE_FILES.setupPlan),
        "utf8",
      ),
    ) as unknown,
  );
  if (
    plan.planId !== transaction.planId ||
    plan.root !== (await realpath(context.root)) ||
    canonicalJson(plan.candidates.map((item) => item.recipeDigest).sort()) !==
      canonicalJson([...transaction.recipeDigests].sort())
  )
    throw new CliError(
      "setup.rollback-binding-mismatch",
      "Transaction and setup plan bindings do not match",
    );
  const installer = context.installerFactory(
    (await context.resolveExecutable("dart", context.env)) ?? process.execPath,
    (await context.resolveExecutable("git", context.env)) ?? process.execPath,
  );
  const result = await installer.uninstall(context.root);
  if (hasErrors(result.diagnostics))
    throw new CliError(
      "setup.rollback-failed",
      result.diagnostics.map((item) => item.message).join("; "),
    );
  await Promise.all(
    [PROJECT_STATE_FILES.setupApproval, PROJECT_STATE_FILES.setupPlan].map(
      (name) => rm(join(context.root, STATE_DIRECTORY, name), { force: true }),
    ),
  );
  await removeSetupApproval(context.root, context.env);
  const finishedAt = context.now().toISOString();
  await writeJsonAtomic(
    join(context.root, STATE_DIRECTORY, PROJECT_STATE_FILES.setupTransaction),
    setupTransactionSchema.parse({
      ...transaction,
      status: "rolled-back",
      updatedAt: finishedAt,
      receipt: {
        schemaVersion: 1,
        transactionId: transaction.transactionId,
        planId: transaction.planId,
        status: "rolled-back",
        startedAt: transaction.createdAt,
        finishedAt,
        items: plan.candidates.map((item) => ({
          candidateId: item.id,
          recipeDigest: item.recipeDigest,
          status: "rolled-back",
        })),
      },
    }),
  );
}

async function rollbackCommand(
  parsed: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  assertFlags(parsed, []);
  const [id] = parsed.positionals;
  if (parsed.positionals.length !== 1 || id === undefined) throw usageError();
  const transaction = await readSetupTransaction(context.root);
  if (transaction === undefined || transaction.transactionId !== id)
    throw new CliError(
      "setup.transaction-not-found",
      `Unknown transaction: ${id}`,
    );
  await rollbackSetup(context, transaction);
  printLines(context.stdout, [`Rolled back ${id}`]);
  return 0;
}

async function recoverCommand(
  parsed: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  assertFlags(parsed, []);
  if (parsed.positionals.length !== 0) throw usageError();
  const transaction = await readSetupTransaction(context.root);
  if (
    transaction === undefined ||
    !["pending", "running", "failed"].includes(transaction.status)
  ) {
    printLines(context.stdout, ["Recovery", "  nothing to recover"]);
    return 0;
  }
  await rollbackSetup(context, transaction);
  printLines(context.stdout, [
    "Recovery",
    `  rolled back ${transaction.transactionId}`,
  ]);
  return 0;
}

async function applyCommand(
  parsed: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  assertFlags(parsed, ["approve", "dry-run", "harness", "task"]);
  if (parsed.positionals.length !== 0) throw usageError();
  const adapter = adapterFor(value(parsed, "harness"));
  const resolution = await resolvePlan(
    context.root,
    value(parsed, "task"),
    context.env,
  );
  if (resolution.plan.uncovered.length > 0)
    throw new CliError(
      "plan.uncovered",
      `Required capabilities are uncovered: ${resolution.plan.uncovered.join(", ")}`,
    );
  const unresolved = resolution.plan.selected
    .filter((item) => item.candidate.version === undefined)
    .map((item) => item.candidate.id)
    .sort();
  if (unresolved.length > 0)
    throw new CliError(
      "plan.unresolved-version",
      `Selected capabilities lack exact versions or revisions: ${unresolved.join(", ")}`,
    );
  const approval = approvalError(
    resolution.plan,
    parsed.flags.get("approve") ?? [],
  );
  if (approval) throw approval;
  const mutationPlan = await adapter.planInstall(context.root, resolution.plan);
  const result = await adapter.apply(mutationPlan, flag(parsed, "dry-run"));
  if (hasErrors(result.diagnostics)) {
    renderApply(context.stdout, adapter.id, flag(parsed, "dry-run"), result);
    return EXIT_ERROR;
  }
  if (!flag(parsed, "dry-run"))
    await writeState(
      context,
      adapter.id,
      resolution,
      parsed.flags.get("approve") ?? [],
    );
  renderApply(context.stdout, adapter.id, flag(parsed, "dry-run"), result);
  return 0;
}

function renderApply(
  writer: CliWriter,
  harness: string,
  dryRun: boolean,
  result: { changed: string[]; skipped: string[]; diagnostics: Diagnostic[] },
): void {
  printLines(writer, [
    dryRun ? `Apply preview (${harness})` : `Apply (${harness})`,
    `  changed ${result.changed.length}`,
    `  skipped ${result.skipped.length}`,
    ...result.diagnostics.map(
      (item) => `  ${item.level} ${item.code}: ${item.message}`,
    ),
  ]);
}

async function writeState(
  context: CommandContext,
  harness: string,
  resolution: ProjectResolution,
  approvals: readonly string[],
): Promise<void> {
  const directory = join(context.root, STATE_DIRECTORY);
  const project = projectStateSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    version: VERSION,
    project: safe(resolution.project),
  });
  const workflow = workflowStateSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    version: VERSION,
    harnesses: {
      ...(await readWorkflowHarnesses(directory)),
      [harness]: {
        task: safe(resolution.task),
        selected: resolution.plan.selected
          .map((item) => item.candidate.id)
          .sort(),
        approvals: [...approvals].sort(),
      },
    },
  });
  const lockablePlan: CapabilityPlan = resolution.plan;
  const states = Object.fromEntries(
    lockablePlan.selected.map((item) => [
      item.candidate.id,
      "approved" as const,
    ]),
  );
  const currentLock = createCapabilityLock(lockablePlan, {
    generatedAt: context.now(),
    states,
  });
  const harnesses = {
    ...(await readLockHarnesses(directory)),
    [harness]: currentLock.entries,
  };
  const lock = capabilityLockSchema.parse({
    ...currentLock,
    entries: [
      ...new Map(
        Object.values(harnesses)
          .flat()
          .map((entry) => [`${entry.id}@${entry.version}`, entry]),
      ).values(),
    ].sort((left, right) => left.id.localeCompare(right.id)),
    harnesses,
  });
  await writeJsonAtomic(join(directory, PROJECT_STATE_FILES.project), project);
  await writeJsonAtomic(
    join(directory, PROJECT_STATE_FILES.workflow),
    workflow,
  );
  await writeJsonAtomic(
    join(directory, PROJECT_STATE_FILES.lock),
    redactLockSecrets(lock),
  );
}

async function removeCommand(
  parsed: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  assertFlags(parsed, ["dry-run", "harness"]);
  if (parsed.positionals.length !== 0) throw usageError();
  const adapter = adapterFor(value(parsed, "harness"));
  const dryRun = flag(parsed, "dry-run");
  const setupOwnership = join(
    context.root,
    STATE_DIRECTORY,
    "setup-ownership.json",
  );
  const hasSetupOwnership = await access(setupOwnership)
    .then(() => true)
    .catch(() => false);
  const installerResult =
    hasSetupOwnership && adapter.id === "opencode"
      ? await context
          .installerFactory(
            (await context.resolveExecutable("dart", context.env)) ??
              process.execPath,
            (await context.resolveExecutable("git", context.env)) ??
              process.execPath,
          )
          .uninstall(context.root, dryRun)
      : { changed: [], skipped: [], diagnostics: [] };
  if (hasErrors(installerResult.diagnostics)) {
    printLines(context.stdout, [
      `Remove (${adapter.id})`,
      `  changed ${installerResult.changed.length}`,
      `  skipped ${installerResult.skipped.length}`,
      ...installerResult.diagnostics.map(
        (item) => `  ${item.level} ${item.code}: ${item.message}`,
      ),
    ]);
    return EXIT_ERROR;
  }
  const result = await adapter.uninstallOwned(context.root, dryRun);
  if (!dryRun && !hasErrors(result.diagnostics)) {
    await removeSetupApproval(context.root, context.env);
    if (await hasOwnedHarnesses(context.root)) {
      await removeWorkflowHarness(context.root, adapter.id);
      await removeLockHarness(context.root, adapter.id, context.now());
    } else {
      await Promise.all(
        [
          PROJECT_STATE_FILES.project,
          PROJECT_STATE_FILES.workflow,
          PROJECT_STATE_FILES.lock,
          PROJECT_STATE_FILES.setupApproval,
          PROJECT_STATE_FILES.setupPlan,
          PROJECT_STATE_FILES.setupTransaction,
        ].map((name) =>
          rm(join(context.root, STATE_DIRECTORY, name), { force: true }),
        ),
      );
    }
  }
  printLines(context.stdout, [
    dryRun ? `Remove preview (${adapter.id})` : `Remove (${adapter.id})`,
    `  changed ${result.changed.length + installerResult.changed.length}`,
    `  skipped ${result.skipped.length + installerResult.skipped.length}`,
    ...installerResult.diagnostics.map(
      (item) => `  ${item.level} ${item.code}: ${item.message}`,
    ),
    ...result.diagnostics.map(
      (item) => `  ${item.level} ${item.code}: ${item.message}`,
    ),
  ]);
  return hasErrors(result.diagnostics) ? EXIT_ERROR : 0;
}

async function readLockHarnesses(
  directory: string,
): Promise<
  Record<string, ReturnType<typeof capabilityLockSchema.parse>["entries"]>
> {
  try {
    return capabilityLockSchema.parse(
      JSON.parse(
        await readFile(join(directory, PROJECT_STATE_FILES.lock), "utf8"),
      ) as unknown,
    ).harnesses;
  } catch {
    return {};
  }
}

async function removeLockHarness(
  root: string,
  harness: string,
  now: Date,
): Promise<void> {
  const directory = join(root, STATE_DIRECTORY);
  const path = join(directory, PROJECT_STATE_FILES.lock);
  try {
    const lock = capabilityLockSchema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
    delete lock.harnesses[harness];
    lock.entries = [
      ...new Map(
        Object.values(lock.harnesses)
          .flat()
          .map((entry) => [`${entry.id}@${entry.version}`, entry]),
      ).values(),
    ].sort((left, right) => left.id.localeCompare(right.id));
    lock.generatedAt = now.toISOString();
    await writeJsonAtomic(path, lock);
  } catch {
    return;
  }
}

async function readWorkflowHarnesses(
  directory: string,
): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(
      await readFile(join(directory, PROJECT_STATE_FILES.workflow), "utf8"),
    ) as Record<string, unknown>;
    if (isRecord(value.harnesses)) return value.harnesses;
    if (typeof value.harness === "string") {
      return {
        [value.harness]: {
          task: value.task,
          selected: value.selected,
          approvals: value.approvals,
        },
      };
    }
  } catch {
    return {};
  }
  return {};
}

async function removeWorkflowHarness(
  root: string,
  harness: string,
): Promise<void> {
  const directory = join(root, STATE_DIRECTORY);
  const harnesses = await readWorkflowHarnesses(directory);
  delete harnesses[harness];
  await writeJsonAtomic(join(directory, PROJECT_STATE_FILES.workflow), {
    schemaVersion: SCHEMA_VERSION,
    version: VERSION,
    harnesses,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function hasOwnedHarnesses(root: string): Promise<boolean> {
  try {
    const value = ownershipStateSchema.parse(
      JSON.parse(
        await readFile(
          join(root, STATE_DIRECTORY, PROJECT_STATE_FILES.ownership),
          "utf8",
        ),
      ) as unknown,
    );
    return Object.keys(value.harnesses).length > 0;
  } catch {
    return false;
  }
}

async function doctorCommand(
  parsed: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  assertFlags(parsed, ["harness", "json"]);
  if (parsed.positionals.length !== 0) throw usageError();
  const adapter = adapterFor(value(parsed, "harness"));
  const state = await adapter.inspect(context.root);
  const diagnostics = [
    ...state.diagnostics,
    ...(await adapter.verify(context.root)),
  ];
  const setupOwnership = join(
    context.root,
    STATE_DIRECTORY,
    "setup-ownership.json",
  );
  if (
    await access(setupOwnership)
      .then(() => true)
      .catch(() => false)
  )
    diagnostics.push(
      ...(await context
        .installerFactory(
          (await context.resolveExecutable("dart", context.env)) ??
            process.execPath,
          (await context.resolveExecutable("git", context.env)) ??
            process.execPath,
        )
        .verify(context.root)),
    );
  const stateNames = [
    PROJECT_STATE_FILES.project,
    PROJECT_STATE_FILES.workflow,
    PROJECT_STATE_FILES.lock,
  ];
  const statePaths = stateNames.map((name) =>
    join(context.root, STATE_DIRECTORY, name),
  );
  const anyStateFile = (
    await Promise.all(
      statePaths.map(async (path) => {
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      }),
    )
  ).some(Boolean);
  for (const [index, name] of stateNames.entries()) {
    const path = statePaths[index]!;
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      const schema =
        name === PROJECT_STATE_FILES.project
          ? projectStateSchema
          : name === PROJECT_STATE_FILES.workflow
            ? workflowStateSchema
            : capabilityLockSchema;
      schema.parse(value);
    } catch (error) {
      if (!anyStateFile && (error as NodeJS.ErrnoException).code === "ENOENT")
        continue;
      diagnostics.push({
        level: "error",
        code: "loom.state-invalid",
        message: "State file is missing or invalid",
        path,
      });
    }
  }
  const data = {
    harness: state,
    diagnostics: diagnostics.sort((a, b) => a.code.localeCompare(b.code)),
  };
  if (flag(parsed, "json"))
    printJson(context.stdout, jsonEnvelope("doctor", data));
  else
    printLines(context.stdout, [
      `Doctor (${adapter.id})`,
      `  installed ${state.installed ? "yes" : "no"}`,
      ...data.diagnostics.map(
        (item) => `  ${item.level} ${item.code}: ${item.message}`,
      ),
      ...(data.diagnostics.length === 0 ? ["  ok"] : []),
    ]);
  return hasErrors(diagnostics) ? EXIT_ERROR : 0;
}

async function registryCommand(
  parsed: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  assertFlags(parsed, []);
  const [action] = parsed.positionals;
  if (
    parsed.positionals.length !== 1 ||
    (action !== "sync" && action !== "status")
  )
    throw usageError();
  const cache = new AtomicTtlCache(
    getXdgCacheDirectory("loom", context.env),
    () => context.now().getTime(),
  );
  if (action === "sync") {
    try {
      const result = await syncRegistryCache(
        cache,
        REGISTRY_KEY,
        new OfficialMcpRegistry(),
        { limit: 100, version: "latest" },
        {
          ttlMs: REGISTRY_TTL,
          force: true,
          maxPages: 10,
        },
      );
      printLines(context.stdout, [
        "Registry sync",
        `  source ${result.source}`,
        `  candidates ${result.value?.candidates.length ?? 0}`,
        `  synced ${result.value?.syncedAt ?? "never"}`,
        `  complete ${result.value?.complete === true ? "yes" : "no"}`,
      ]);
    } catch (error) {
      printLines(context.stdout, [
        "Registry sync",
        `  warning unavailable: ${message(error)}`,
      ]);
    }
    return 0;
  }
  const entry = await cache.read<RegistrySnapshot>(REGISTRY_KEY);
  printLines(context.stdout, [
    "Registry status",
    `  cached ${entry === null ? "no" : "yes"}`,
    `  candidates ${entry?.value.candidates.length ?? 0}`,
    `  synced ${entry?.value.syncedAt ?? "never"}`,
    `  complete ${entry?.value.complete === true ? "yes" : "no"}`,
  ]);
  return 0;
}

async function readLock(root: string): Promise<{
  entries?: Array<{
    id: string;
    version: string;
    source: { registry: string };
  }>;
}> {
  const path = join(root, STATE_DIRECTORY, PROJECT_STATE_FILES.lock);
  try {
    return JSON.parse(await readFile(path, "utf8")) as {
      entries?: Array<{
        id: string;
        version: string;
        source: { registry: string };
      }>;
    };
  } catch {
    throw new CliError(
      "loom.lock-missing",
      "Capability lock is missing or invalid",
    );
  }
}

async function upgradesCommand(
  parsed: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  assertFlags(parsed, []);
  if (parsed.positionals.length !== 0) throw usageError();
  const lock = await readLock(context.root);
  const entries = [...(lock.entries ?? [])].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  printLines(context.stdout, [
    "Upgrades",
    ...entries.map((item) => `  ${item.id} ${item.version} review required`),
    ...(entries.length === 0 ? ["  none"] : []),
  ]);
  return 0;
}

async function upgradeCommand(
  parsed: ParsedArguments,
  context: CommandContext,
): Promise<number> {
  assertFlags(parsed, ["review"]);
  if (parsed.positionals.length !== 0 || !flag(parsed, "review"))
    throw usageError();
  const lock = await readLock(context.root);
  const entries = [...(lock.entries ?? [])].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  printLines(context.stdout, [
    "Upgrade review",
    "  no changes applied",
    ...entries.map(
      (item) => `  ${item.id} ${item.version} (${item.source.registry})`,
    ),
    ...(entries.length === 0 ? ["  none"] : []),
  ]);
  return 0;
}

async function mcpCommand(parsed: ParsedArguments): Promise<number> {
  assertFlags(parsed, []);
  if (parsed.positionals.length !== 0) throw usageError();
  const module = (await import("@loom/mcp")) as Record<string, unknown>;
  const entry = [
    module.runLoomMcpServer,
    module.runMcp,
    module.runMcpServer,
    module.startMcpServer,
    module.main,
    module.default,
  ].find(
    (candidate): candidate is (...args: unknown[]) => unknown =>
      typeof candidate === "function",
  );
  if (!entry)
    throw new CliError(
      "mcp.entry-missing",
      "@loom/mcp does not export a runnable entry point",
    );
  const result = await entry();
  return typeof result === "number" ? result : 0;
}

function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((item) => item.level === "error");
}

function message(error: unknown): string {
  return scrubStrings(
    error instanceof Error ? error.message : String(error),
  ) as string;
}

function usageError(): CliError {
  return new CliError("usage.invalid-arguments", usage, EXIT_USAGE);
}

async function confirmInTerminal(prompt: string): Promise<boolean> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await terminal.question(`${prompt} [y/N] `);
    return /^(?:y|yes)$/iu.test(answer.trim());
  } finally {
    terminal.close();
  }
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  options: RunCliOptions = {},
): Promise<number> {
  const context: CommandContext = {
    root: resolve(options.cwd ?? process.cwd()),
    env: options.env ?? process.env,
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    now: options.now ?? (() => new Date()),
    isTTY: options.isTTY ?? process.stdin.isTTY === true,
    confirm: options.confirm ?? confirmInTerminal,
    installerFactory:
      options.installerFactory ??
      ((dartPath, gitPath) => new CapabilityInstaller({ dartPath, gitPath })),
    resolveExecutable: options.resolveExecutable ?? executablePath,
    ...(options.afterSetupMetadataWrite === undefined
      ? {}
      : { afterSetupMetadataWrite: options.afterSetupMetadataWrite }),
  };
  let command = args[0] ?? "";
  try {
    if (command === "" || command === "help" || command === "--help") {
      printLines(context.stdout, [usage]);
      return command === "" ? EXIT_USAGE : 0;
    }
    const parsed = parseArguments(args.slice(1));
    switch (command) {
      case "detect":
        return await detectCommand(parsed, context);
      case "plan":
        return await planCommand(parsed, context);
      case "explain":
        return await explainCommand(parsed, context);
      case "discover":
        return await discoverCommand(parsed, context);
      case "capabilities":
        return await capabilitiesCommand(parsed, context);
      case "connect":
        return await connectCommand(parsed, context);
      case "setup":
        return await setupCommand(parsed, context);
      case "transactions":
        return await transactionsCommand(parsed, context);
      case "rollback":
        return await rollbackCommand(parsed, context);
      case "recover":
        return await recoverCommand(parsed, context);
      case "apply":
        return await applyCommand(parsed, context);
      case "remove":
        return await removeCommand(parsed, context);
      case "doctor":
        return await doctorCommand(parsed, context);
      case "registry":
        return await registryCommand(parsed, context);
      case "upgrades":
        return await upgradesCommand(parsed, context);
      case "upgrade":
        return await upgradeCommand(parsed, context);
      case "mcp":
        return await mcpCommand(parsed);
      default:
        throw new CliError(
          "usage.unknown-command",
          `Unknown command: ${command}\n${usage}`,
          EXIT_USAGE,
        );
    }
  } catch (error) {
    const failure =
      error instanceof CliError
        ? error
        : new CliError("loom.internal", message(error));
    const json = args.includes("--json");
    if (json)
      printJson(context.stderr, {
        schemaVersion: SCHEMA_VERSION,
        version: VERSION,
        command: command || "unknown",
        ok: false,
        error: { code: failure.code, message: message(failure) },
      });
    else
      printLines(context.stderr, [
        `Error [${failure.code}]: ${message(failure)}`,
      ]);
    return failure.exitCode;
  }
}

const invokedPath =
  process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (
  !AUTO_ENTRY_DISABLED &&
  invokedPath !== undefined &&
  pathToFileURL(invokedPath).href === import.meta.url
) {
  process.exitCode = await runCli();
}

export { EXIT_APPROVAL, EXIT_ERROR, EXIT_USAGE };
