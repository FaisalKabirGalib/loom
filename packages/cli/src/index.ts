#!/usr/bin/env node

import { access, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  detectProject,
  loadEffectivePolicy,
  capabilityLockSchema,
  ownershipStateSchema,
  projectStateSchema,
  redactLockSecrets,
  redactSecrets,
  writeJsonAtomic,
  type CapabilityCandidate,
  type CapabilityPlan,
  type Diagnostic,
  type HarnessAdapter,
  workflowStateSchema,
} from "@loom/core";
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
  const valueFlags = new Set(["approve", "harness", "task"]);
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
  const result = await adapter.uninstallOwned(context.root, dryRun);
  if (!dryRun && !hasErrors(result.diagnostics)) {
    if (await hasOwnedHarnesses(context.root)) {
      await removeWorkflowHarness(context.root, adapter.id);
      await removeLockHarness(context.root, adapter.id, context.now());
    } else {
      await Promise.all(
        [
          PROJECT_STATE_FILES.project,
          PROJECT_STATE_FILES.workflow,
          PROJECT_STATE_FILES.lock,
        ].map((name) =>
          rm(join(context.root, STATE_DIRECTORY, name), { force: true }),
        ),
      );
    }
  }
  printLines(context.stdout, [
    dryRun ? `Remove preview (${adapter.id})` : `Remove (${adapter.id})`,
    `  changed ${result.changed.length}`,
    `  skipped ${result.skipped.length}`,
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
      if (
        !state.installed &&
        !anyStateFile &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
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
