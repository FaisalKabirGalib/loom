import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "@loom/core";
import type {
  ApplyResult,
  CapabilityPlan,
  ConfigMutation,
  ConfigMutationPlan,
  Diagnostic,
  HarnessAdapter,
  HarnessState,
  LoomResources,
} from "@loom/core";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

const PLUGIN_PATH = ".opencode/plugins/loom.ts";
const OWNERSHIP_PATH = ".loom/ownership.json";
const CONFIG_NAMES = ["opencode.jsonc", "opencode.json"] as const;
const DEFAULT_COMMAND = ["loom", "mcp"];
const AGENT_BROWSER_POINTER = "mcp.agent-browser";
const MCP_VALUE = (
  command: readonly string[],
  env?: Readonly<Record<string, string>>,
) => ({
  type: "local",
  command: [...command],
  enabled: true,
  ...(env === undefined ? {} : { environment: { ...env } }),
});

const PLUGIN_SOURCE = `import type { Plugin } from "@opencode-ai/plugin";

export const LoomPlugin = (async () => ({
  config: (config) => {
    config.command ??= {};
    config.command["loom:start"] ??= {
      description: "Start a project with Loom",
      template: "Use the loom-project-start skill for this request: $ARGUMENTS",
    };
    config.command["loom:hydrate"] ??= {
      description: "Hydrate Loom project context",
      template: "Use the loom-project-hydrate skill for this request: $ARGUMENTS",
    };
    config.command["loom:verify"] ??= {
      description: "Run the Loom verification loop",
      template: "Use the loom-verification-loop skill for this request: $ARGUMENTS",
    };
    config.command["loom:setup"] ??= {
      description: "Recommend a complete project setup with Loom",
      template: "Use the loom-project-setup skill for this request: $ARGUMENTS",
    };
  },
})) satisfies Plugin;
`;

interface OwnedPointer {
  path: string;
  value: unknown;
}

interface HarnessOwnership {
  files: Record<string, string>;
  pointers: Record<string, OwnedPointer>;
}

interface Ownership {
  version: 1;
  harnesses: Record<string, HarnessOwnership>;
}

export interface OpenCodeHarnessAdapterOptions {
  command?: readonly string[];
  skillsSource?: string;
  fileOperations?: OpenCodeFileOperations;
}

export interface OpenCodeFileOperations {
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function error(code: string, message: string, path?: string): Diagnostic {
  return path === undefined
    ? { level: "error", code, message }
    : { level: "error", code, message, path };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function isNormalizedRelative(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function isSkillPath(path: string): boolean {
  const parts = path.split("/");
  return (
    parts.length >= 4 &&
    parts[0] === ".agents" &&
    parts[1] === "skills" &&
    /^loom-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(parts[2] ?? "")
  );
}

function isOwnedFilePath(path: unknown): path is string {
  return (
    isNormalizedRelative(path) && (path === PLUGIN_PATH || isSkillPath(path))
  );
}

function isConfigPath(path: unknown): path is (typeof CONFIG_NAMES)[number] {
  return typeof path === "string" && CONFIG_NAMES.includes(path as never);
}

function isMutationPath(path: string): boolean {
  return (
    path === OWNERSHIP_PATH ||
    path === PLUGIN_PATH ||
    isSkillPath(path) ||
    isConfigPath(path)
  );
}

async function assertNoSymlink(root: string, path: string): Promise<void> {
  const candidate = relative(root, path);
  if (
    candidate === "" ||
    candidate === ".." ||
    candidate.startsWith(`..${sep}`) ||
    resolve(path) !== path
  ) {
    throw new Error(`Path is outside the project root: ${path}`);
  }
  let current = root;
  const parts = candidate.split(sep);
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) current = resolve(current, parts[index]!);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`Symlink path component is not allowed: ${current}`);
      }
    } catch (cause) {
      if (isRecord(cause) && cause.code === "ENOENT") return;
      throw cause;
    }
  }
}

async function safeReadOptional(
  root: string,
  path: string,
): Promise<string | undefined> {
  const absolute = resolve(root, path);
  await assertNoSymlink(root, absolute);
  return readOptional(absolute);
}

async function safeReadOptionalBytes(
  root: string,
  path: string,
): Promise<Buffer | undefined> {
  const absolute = resolve(root, path);
  await assertNoSymlink(root, absolute);
  try {
    return await readFile(absolute);
  } catch (cause) {
    if (isRecord(cause) && cause.code === "ENOENT") return undefined;
    throw cause;
  }
}

async function writeBytesAtomic(
  path: string,
  content: Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

function sameBytes(
  left: Buffer | undefined,
  right: Buffer | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right?.equals(left) === true;
}

async function readProjectOptional(
  root: string,
  path: string,
  diagnostics: Diagnostic[],
): Promise<string | undefined> {
  try {
    return await safeReadOptional(root, path);
  } catch {
    diagnostics.push(
      error(
        "opencode.unsafe-path",
        "Path contains a symlink or escapes the project root",
        path,
      ),
    );
    return undefined;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (isRecord(cause) && cause.code === "ENOENT") return undefined;
    throw cause;
  }
}

function parseJsonc(
  text: string,
  path: string,
): { value?: Record<string, unknown>; diagnostics: Diagnostic[] } {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || !isRecord(value)) {
    return {
      diagnostics: [
        error(
          "opencode.invalid-config",
          "OpenCode config is not a valid JSON object",
          path,
        ),
      ],
    };
  }
  return { value, diagnostics: [] };
}

function formatting(text: string): {
  insertSpaces: boolean;
  tabSize: number;
  eol: string;
} {
  const indentation = text.match(/\n([\t ]+)\S/u)?.[1];
  return {
    insertSpaces: !indentation?.includes("\t"),
    tabSize: indentation?.includes("\t") ? 1 : (indentation?.length ?? 2),
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

function setMcp(text: string, name: string, value: unknown): string {
  return applyEdits(
    text,
    modify(text, ["mcp", name], value, {
      formattingOptions: formatting(text),
    }),
  );
}

function mutation(
  kind: ConfigMutation["kind"],
  path: string,
  description: string,
  content?: string,
  expectedHash?: string,
): ConfigMutation {
  return {
    kind,
    path,
    description,
    ...(content === undefined ? {} : { content }),
    ...(expectedHash === undefined ? {} : { expectedHash }),
  };
}

function emptyOwnership(): Ownership {
  return { version: 1, harnesses: {} };
}

function otherHarnessOwnsFile(
  ownership: Ownership,
  harness: string,
  path: string,
  hash: string,
): boolean {
  return Object.entries(ownership.harnesses).some(([id, value]) => {
    if (id === harness || !isRecord(value) || !("files" in value)) return false;
    const files = value.files;
    if (Array.isArray(files)) {
      return files.some(
        (file) => isRecord(file) && file.path === path && file.sha256 === hash,
      );
    }
    return isRecord(files) && files[path] === hash;
  });
}

async function readOwnership(root: string): Promise<{
  ownership: Ownership;
  content?: string;
  diagnostics: Diagnostic[];
}> {
  let content: string | undefined;
  try {
    content = await safeReadOptional(root, OWNERSHIP_PATH);
  } catch {
    return {
      ownership: emptyOwnership(),
      diagnostics: [
        error(
          "opencode.unsafe-path",
          "Loom ownership path contains a symlink or escapes the project root",
          OWNERSHIP_PATH,
        ),
      ],
    };
  }
  if (content === undefined)
    return { ownership: emptyOwnership(), diagnostics: [] };
  try {
    const value: unknown = JSON.parse(content);
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.harnesses))
      throw new Error();
    const harness = value.harnesses.opencode;
    if (harness !== undefined) {
      if (
        !isRecord(harness) ||
        !isRecord(harness.files) ||
        !isRecord(harness.pointers)
      )
        throw new Error();
      for (const [ownedPath, hash] of Object.entries(harness.files)) {
        if (!isOwnedFilePath(ownedPath) || typeof hash !== "string")
          throw new Error();
      }
      const pointers = Object.entries(harness.pointers);
      if (
        pointers.some(
          ([key, pointer]) =>
            (key !== "mcp.loom" && key !== AGENT_BROWSER_POINTER) ||
            !isRecord(pointer) ||
            !isConfigPath(pointer.path) ||
            !("value" in pointer),
        )
      )
        throw new Error();
    }
    return {
      ownership: value as unknown as Ownership,
      content,
      diagnostics: [],
    };
  } catch {
    return {
      ownership: emptyOwnership(),
      content,
      diagnostics: [
        error(
          "opencode.invalid-ownership",
          "Loom ownership file is invalid",
          OWNERSHIP_PATH,
        ),
      ],
    };
  }
}

async function collectSkills(source: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const sourceRelative = relative(source, path);
        const skillName = sourceRelative.split(sep)[0];
        if (!skillName?.startsWith("loom-")) continue;
        result[`.agents/skills/${sourceRelative.split(sep).join("/")}`] =
          await readFile(path, "utf8");
      }
    }
  }
  await visit(source);
  return result;
}

function pointerValue(config: Record<string, unknown>, name = "loom"): unknown {
  const mcp = config.mcp;
  return isRecord(mcp) ? mcp[name] : undefined;
}

function allowedMutationRelative(
  root: string,
  path: unknown,
): string | undefined {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path)
    return undefined;
  const candidate = relative(root, path).split(sep).join("/");
  return isNormalizedRelative(candidate) && isMutationPath(candidate)
    ? candidate
    : undefined;
}

export class OpenCodeHarnessAdapter implements HarnessAdapter {
  readonly id = "opencode";
  readonly #command: readonly string[];
  readonly #skillsSource: string;
  readonly #fileOperations: OpenCodeFileOperations;
  readonly #issuedPlans = new WeakSet<ConfigMutationPlan>();

  constructor(options: OpenCodeHarnessAdapterOptions = {}) {
    this.#command = options.command ?? DEFAULT_COMMAND;
    this.#skillsSource = resolve(
      options.skillsSource ??
        fileURLToPath(new URL("../../../packages/skills", import.meta.url)),
    );
    this.#fileOperations =
      options.fileOperations ??
      ({
        write: writeFileAtomic,
        remove: unlink,
      } satisfies OpenCodeFileOperations);
  }

  async inspect(root: string): Promise<HarnessState> {
    const projectRoot = resolve(root);
    const ownership = await readOwnership(projectRoot);
    const configPaths: string[] = [];
    for (const name of CONFIG_NAMES) {
      try {
        await assertNoSymlink(projectRoot, resolve(projectRoot, name));
        if (await exists(resolve(projectRoot, name))) configPaths.push(name);
      } catch {
        ownership.diagnostics.push(
          error(
            "opencode.unsafe-path",
            "OpenCode config path contains a symlink",
            name,
          ),
        );
      }
    }
    return {
      id: this.id,
      installed: ownership.ownership.harnesses[this.id] !== undefined,
      configPaths,
      diagnostics: ownership.diagnostics,
    };
  }

  #issuePlan(plan: ConfigMutationPlan): ConfigMutationPlan {
    for (const mutation of plan.mutations) Object.freeze(mutation);
    for (const diagnostic of plan.diagnostics) Object.freeze(diagnostic);
    Object.freeze(plan.mutations);
    Object.freeze(plan.diagnostics);
    this.#issuedPlans.add(plan);
    return Object.freeze(plan);
  }

  async planInstall(
    root: string,
    plan: CapabilityPlan,
    resources?: LoomResources,
  ): Promise<ConfigMutationPlan> {
    void plan;
    const projectRoot = resolve(root);
    const diagnostics: Diagnostic[] = [];
    const mutations: ConfigMutation[] = [];
    const ownershipState = await readOwnership(projectRoot);
    diagnostics.push(...ownershipState.diagnostics);
    const previous = ownershipState.ownership.harnesses[this.id];
    const ownedFiles = previous?.files ?? {};
    const ownedPointer = previous?.pointers["mcp.loom"];
    const ownedAgentBrowser = previous?.pointers[AGENT_BROWSER_POINTER];
    const presentConfigs: string[] = [];
    for (const name of CONFIG_NAMES) {
      const content = await readProjectOptional(projectRoot, name, diagnostics);
      if (content !== undefined) presentConfigs.push(name);
    }
    if (presentConfigs.length > 1 && ownedPointer === undefined) {
      diagnostics.push(
        error(
          "opencode.ambiguous-config",
          "Both opencode.json and opencode.jsonc exist; Loom cannot safely choose one",
        ),
      );
    }
    const configPath =
      ownedPointer?.path ?? presentConfigs[0] ?? "opencode.json";
    const absoluteConfig = resolve(projectRoot, configPath);
    const existingConfig = isConfigPath(configPath)
      ? await readProjectOptional(projectRoot, configPath, diagnostics)
      : undefined;
    if (!isConfigPath(configPath)) {
      diagnostics.push(
        error(
          "opencode.invalid-ownership",
          "Owned OpenCode config path is not allowed",
          configPath,
        ),
      );
    }
    const configText = existingConfig ?? "{}\n";
    const parsed = parseJsonc(configText, configPath);
    diagnostics.push(...parsed.diagnostics);
    const desiredMcp = MCP_VALUE(this.#command);
    if (parsed.value !== undefined) {
      const mcp = parsed.value.mcp;
      if (mcp !== undefined && !isRecord(mcp)) {
        diagnostics.push(
          error(
            "opencode.mcp-collision",
            "OpenCode mcp config is not an object",
            configPath,
          ),
        );
      } else {
        const current = pointerValue(parsed.value);
        if (ownedPointer !== undefined) {
          if (
            ownedPointer.path !== configPath ||
            !sameValue(current, ownedPointer.value)
          ) {
            diagnostics.push(
              error(
                "opencode.modified-owned-pointer",
                "Owned mcp.loom config was modified; refusing to overwrite it",
                configPath,
              ),
            );
          }
        } else if (current !== undefined) {
          diagnostics.push(
            error(
              "opencode.mcp-collision",
              "mcp.loom already exists and is not owned by Loom",
              configPath,
            ),
          );
        }
      }
    }

    let desiredFiles: Record<string, string> = { [PLUGIN_PATH]: PLUGIN_SOURCE };
    try {
      desiredFiles = {
        ...desiredFiles,
        ...(await collectSkills(this.#skillsSource)),
        ...(resources?.skill === undefined
          ? {}
          : {
              [`.agents/skills/${resources.skill.name}/SKILL.md`]:
                resources.skill.content,
            }),
      };
    } catch {
      diagnostics.push(
        error(
          "opencode.skills-source",
          "Unable to read the Loom skills source",
          this.#skillsSource,
        ),
      );
    }

    for (const [path, content] of Object.entries(desiredFiles)) {
      const current = await readProjectOptional(projectRoot, path, diagnostics);
      const ownedHash = ownedFiles[path];
      const currentHash = current === undefined ? undefined : sha256(current);
      const sharedOwner =
        currentHash !== undefined &&
        otherHarnessOwnsFile(
          ownershipState.ownership,
          this.id,
          path,
          currentHash,
        );
      if (ownedHash !== undefined) {
        if (current === undefined || sha256(current) !== ownedHash) {
          diagnostics.push(
            error(
              "opencode.modified-owned-file",
              "Owned file was modified; refusing to overwrite it",
              path,
            ),
          );
        }
      } else if (
        current !== undefined &&
        !otherHarnessOwnsFile(
          ownershipState.ownership,
          this.id,
          path,
          sha256(current),
        )
      ) {
        diagnostics.push(
          error(
            "opencode.file-collision",
            "Install path already exists and is not owned by Loom",
            path,
          ),
        );
      }
      if (current !== undefined && current !== content && sharedOwner) {
        diagnostics.push(
          error(
            "opencode.shared-version-collision",
            "A different harness owns the current shared file version",
            path,
          ),
        );
      }
      if (current !== content) {
        mutations.push(
          mutation(
            current === undefined ? "create-file" : "update-file",
            resolve(projectRoot, path),
            `Install ${path}`,
            content,
            current === undefined ? undefined : sha256(current),
          ),
        );
      }
    }

    for (const [path, ownedHash] of Object.entries(ownedFiles)) {
      if (desiredFiles[path] !== undefined) continue;
      const current = await readProjectOptional(projectRoot, path, diagnostics);
      if (current !== undefined && sha256(current) !== ownedHash) {
        diagnostics.push(
          error(
            "opencode.modified-owned-file",
            "Owned file was modified; refusing to remove it",
            path,
          ),
        );
      } else if (current !== undefined) {
        mutations.push(
          mutation(
            "delete-file",
            resolve(projectRoot, path),
            `Remove obsolete ${path}`,
            undefined,
            ownedHash,
          ),
        );
      }
    }

    if (parsed.value !== undefined) {
      const desiredAgentBrowser =
        resources?.mcp === undefined
          ? undefined
          : MCP_VALUE(
              [resources.mcp.command, ...resources.mcp.args],
              resources.mcp.env,
            );
      const currentAgentBrowser = pointerValue(parsed.value, "agent-browser");
      if (
        ownedAgentBrowser !== undefined &&
        (ownedAgentBrowser.path !== configPath ||
          !sameValue(currentAgentBrowser, ownedAgentBrowser.value))
      )
        diagnostics.push(
          error(
            "opencode.modified-owned-pointer",
            "Owned mcp.agent-browser config was modified; refusing to overwrite it",
            configPath,
          ),
        );
      else if (
        desiredAgentBrowser !== undefined &&
        ownedAgentBrowser === undefined &&
        currentAgentBrowser !== undefined
      )
        diagnostics.push(
          error(
            "opencode.mcp-collision",
            "mcp.agent-browser already exists and is not owned by Loom",
            configPath,
          ),
        );
      const updatedConfig = setMcp(
        setMcp(configText, "loom", desiredMcp),
        "agent-browser",
        desiredAgentBrowser ??
          (ownedAgentBrowser === undefined ? currentAgentBrowser : undefined),
      );
      if (updatedConfig !== configText) {
        mutations.push(
          mutation(
            existingConfig === undefined ? "create-file" : "update-file",
            absoluteConfig,
            "Configure the Loom MCP server",
            updatedConfig,
            existingConfig === undefined ? undefined : sha256(existingConfig),
          ),
        );
      }
    }

    if (diagnostics.some((item) => item.level === "error")) {
      return this.#issuePlan({
        harness: this.id,
        root: projectRoot,
        mutations: [],
        diagnostics,
      });
    }

    const nextOwnership: Ownership = structuredClone(ownershipState.ownership);
    nextOwnership.harnesses[this.id] = {
      files: Object.fromEntries(
        Object.entries(desiredFiles).map(([path, content]) => [
          path,
          sha256(content),
        ]),
      ),
      pointers: {
        "mcp.loom": { path: configPath, value: desiredMcp },
        ...(resources?.mcp === undefined
          ? {}
          : {
              [AGENT_BROWSER_POINTER]: {
                path: configPath,
                value: MCP_VALUE(
                  [resources.mcp.command, ...resources.mcp.args],
                  resources.mcp.env,
                ),
              },
            }),
      },
    };
    const ownershipContent = `${JSON.stringify(nextOwnership, null, 2)}\n`;
    if (ownershipState.content !== ownershipContent) {
      mutations.push(
        mutation(
          ownershipState.content === undefined ? "create-file" : "update-file",
          resolve(projectRoot, OWNERSHIP_PATH),
          "Record Loom-owned OpenCode resources",
          ownershipContent,
          ownershipState.content === undefined
            ? undefined
            : sha256(ownershipState.content),
        ),
      );
    }
    return this.#issuePlan({
      harness: this.id,
      root: projectRoot,
      mutations,
      diagnostics,
    });
  }

  async apply(plan: ConfigMutationPlan, dryRun = false): Promise<ApplyResult> {
    if (!this.#issuedPlans.has(plan)) {
      return {
        changed: [],
        skipped: [],
        diagnostics: [
          error(
            "opencode.invalid-mutation",
            "Plan was not issued by this OpenCode adapter instance",
          ),
        ],
      };
    }
    const root = resolve(plan.root);
    const diagnostics = [...plan.diagnostics];
    if (!isAbsolute(plan.root) || root !== plan.root) {
      diagnostics.push(
        error(
          "opencode.invalid-plan-root",
          "Plan root must be a normalized absolute path",
        ),
      );
    }
    if (plan.harness !== this.id) {
      diagnostics.push(
        error("opencode.wrong-plan", `Cannot apply a ${plan.harness} plan`),
      );
      return {
        changed: [],
        skipped: plan.mutations.map((item) => item.path),
        diagnostics,
      };
    }
    const pending: Array<{
      mutation: ConfigMutation;
      relativePath: string;
      previous: string | undefined;
      previousBytes: Buffer | undefined;
    }> = [];
    const skipped: string[] = [];
    for (const item of plan.mutations) {
      const relativePath = allowedMutationRelative(root, item.path);
      const kind: unknown = item.kind;
      if (
        relativePath === undefined ||
        (kind !== "create-file" &&
          kind !== "update-file" &&
          kind !== "delete-file") ||
        ((kind === "update-file" || kind === "delete-file") &&
          typeof item.expectedHash !== "string") ||
        ((kind === "create-file" || kind === "update-file") &&
          typeof item.content !== "string")
      ) {
        diagnostics.push(
          error(
            "opencode.invalid-mutation",
            "Mutation path, kind, content, or expected hash is not allowed",
            item.path,
          ),
        );
        skipped.push(item.path);
        continue;
      }
      let current: string | undefined;
      let currentBytes: Buffer | undefined;
      try {
        currentBytes = await safeReadOptionalBytes(root, relativePath);
        current = currentBytes?.toString("utf8");
      } catch {
        diagnostics.push(
          error(
            "opencode.unsafe-path",
            "Mutation path contains a symlink",
            item.path,
          ),
        );
        skipped.push(item.path);
        continue;
      }
      if (item.kind === "delete-file") {
        if (current === undefined) {
          skipped.push(item.path);
        } else if (
          item.expectedHash === undefined ||
          sha256(current) !== item.expectedHash
        ) {
          diagnostics.push(
            error(
              "opencode.concurrent-change",
              "File changed after planning",
              item.path,
            ),
          );
          skipped.push(item.path);
        } else {
          pending.push({
            mutation: item,
            relativePath,
            previous: current,
            previousBytes: currentBytes,
          });
        }
      } else if (current === item.content) {
        skipped.push(item.path);
      } else if (
        (item.kind === "create-file" && current !== undefined) ||
        (item.kind === "update-file" &&
          (current === undefined ||
            item.expectedHash === undefined ||
            sha256(current) !== item.expectedHash))
      ) {
        diagnostics.push(
          error(
            "opencode.concurrent-change",
            "File changed after planning",
            item.path,
          ),
        );
        skipped.push(item.path);
      } else {
        pending.push({
          mutation: item,
          relativePath,
          previous: current,
          previousBytes: currentBytes,
        });
      }
    }
    if (diagnostics.some((item) => item.level === "error")) {
      return {
        changed: [],
        skipped: [
          ...new Set([
            ...skipped,
            ...pending.map(({ mutation }) => mutation.path),
          ]),
        ],
        diagnostics,
      };
    }
    const changed: string[] = [];
    if (!dryRun) {
      const journal: typeof pending = [];
      for (const entry of pending) {
        const { mutation: item, relativePath } = entry;
        try {
          await assertNoSymlink(root, resolve(root, relativePath));
          if (
            !sameBytes(
              await safeReadOptionalBytes(root, relativePath),
              entry.previousBytes,
            )
          )
            throw new Error("File changed after preflight");
          if (item.kind === "delete-file") {
            await this.#fileOperations.remove(item.path);
          } else {
            await this.#fileOperations.write(item.path, item.content ?? "");
          }
          journal.push(entry);
          changed.push(item.path);
        } catch (cause) {
          const intended =
            item.kind === "delete-file" ? undefined : item.content;
          try {
            if ((await safeReadOptional(root, relativePath)) === intended)
              journal.push(entry);
          } catch {}
          const rollbackFailures: string[] = [];
          for (const applied of journal.reverse()) {
            const rollbackPath = allowedMutationRelative(
              root,
              applied.mutation.path,
            );
            try {
              if (rollbackPath === undefined)
                throw new Error("Path is not allowed");
              await assertNoSymlink(root, resolve(root, rollbackPath));
              const expected =
                applied.mutation.kind === "delete-file"
                  ? undefined
                  : applied.mutation.content;
              const expectedBytes =
                expected === undefined ? undefined : Buffer.from(expected);
              if (
                !sameBytes(
                  await safeReadOptionalBytes(root, rollbackPath),
                  expectedBytes,
                )
              )
                throw new Error("File changed before rollback");
              if (applied.previous === undefined)
                await this.#fileOperations.remove(applied.mutation.path);
              else
                await writeBytesAtomic(
                  applied.mutation.path,
                  applied.previousBytes!,
                );
            } catch {
              rollbackFailures.push(applied.mutation.path);
            }
          }
          diagnostics.push(
            error(
              "opencode.apply-failed",
              `Apply failed at ${item.path}: ${cause instanceof Error ? cause.message : String(cause)}; ${rollbackFailures.length === 0 ? "all earlier mutations were rolled back" : `rollback failed for ${rollbackFailures.join(", ")}`}`,
              item.path,
            ),
          );
          return {
            changed: [],
            skipped: pending.map(({ mutation }) => mutation.path),
            diagnostics,
          };
        }
      }
    }
    return {
      changed: dryRun ? pending.map(({ mutation }) => mutation.path) : changed,
      skipped,
      diagnostics,
    };
  }

  async verify(root: string): Promise<Diagnostic[]> {
    const projectRoot = resolve(root);
    const state = await readOwnership(projectRoot);
    const diagnostics = [...state.diagnostics];
    const owned = state.ownership.harnesses[this.id];
    if (owned === undefined) {
      diagnostics.push({
        level: "warning",
        code: "opencode.not-installed",
        message: "Loom OpenCode integration is not installed",
      });
      return diagnostics;
    }
    for (const [path, expectedHash] of Object.entries(owned.files)) {
      const content = await readProjectOptional(projectRoot, path, diagnostics);
      if (content === undefined) {
        diagnostics.push(
          error("opencode.missing-owned-file", "Owned file is missing", path),
        );
      } else if (sha256(content) !== expectedHash) {
        diagnostics.push(
          error(
            "opencode.modified-owned-file",
            "Owned file was modified",
            path,
          ),
        );
      }
    }
    if (owned.pointers["mcp.loom"] === undefined) {
      diagnostics.push(
        error(
          "opencode.missing-pointer",
          "Ownership record is missing mcp.loom",
        ),
      );
    } else
      for (const [key, pointer] of Object.entries(owned.pointers)) {
        const content = await readProjectOptional(
          projectRoot,
          pointer.path,
          diagnostics,
        );
        if (content === undefined) {
          diagnostics.push(
            error(
              "opencode.missing-config",
              "Owned OpenCode config is missing",
              pointer.path,
            ),
          );
        } else {
          const parsed = parseJsonc(content, pointer.path);
          diagnostics.push(...parsed.diagnostics);
          if (
            parsed.value !== undefined &&
            !sameValue(
              pointerValue(parsed.value, key.split(".")[1]!),
              pointer.value,
            )
          ) {
            diagnostics.push(
              error(
                "opencode.modified-owned-pointer",
                "Owned mcp.loom config was modified",
                pointer.path,
              ),
            );
          }
        }
      }
    return diagnostics;
  }

  async uninstallOwned(root: string, dryRun = false): Promise<ApplyResult> {
    const projectRoot = resolve(root);
    const state = await readOwnership(projectRoot);
    const diagnostics = [...state.diagnostics];
    const owned = state.ownership.harnesses[this.id];
    if (
      owned === undefined ||
      diagnostics.some((item) => item.level === "error")
    ) {
      return { changed: [], skipped: [], diagnostics };
    }
    const uninstallPaths = [
      ...Object.keys(owned.files),
      ...Object.values(owned.pointers).map((pointer) => pointer.path),
      OWNERSHIP_PATH,
    ];
    for (const path of uninstallPaths) {
      try {
        await assertNoSymlink(projectRoot, resolve(projectRoot, path));
      } catch {
        diagnostics.push(
          error(
            "opencode.unsafe-path",
            "Uninstall path contains a symlink",
            path,
          ),
        );
      }
    }
    if (diagnostics.some((item) => item.level === "error")) {
      return {
        changed: [],
        skipped: uninstallPaths.map((path) => resolve(projectRoot, path)),
        diagnostics,
      };
    }
    const changed: string[] = [];
    const skipped: string[] = [];
    const remainingFiles: Record<string, string> = {};
    for (const [path, expectedHash] of Object.entries(owned.files)) {
      const absolute = resolve(projectRoot, path);
      const content = await readProjectOptional(projectRoot, path, diagnostics);
      if (content === undefined) {
        skipped.push(absolute);
      } else if (sha256(content) !== expectedHash) {
        diagnostics.push(
          error(
            "opencode.modified-owned-file",
            "Owned file was modified; refusing to remove it",
            path,
          ),
        );
        skipped.push(absolute);
        remainingFiles[path] = expectedHash;
      } else if (
        otherHarnessOwnsFile(state.ownership, this.id, path, expectedHash)
      ) {
        skipped.push(absolute);
      } else {
        changed.push(absolute);
        if (!dryRun) {
          try {
            await assertNoSymlink(projectRoot, absolute);
            await unlink(absolute);
          } catch {
            changed.pop();
            skipped.push(absolute);
            diagnostics.push(
              error(
                "opencode.unsafe-path",
                "Owned file path contains a symlink",
                path,
              ),
            );
            remainingFiles[path] = expectedHash;
          }
        }
      }
    }

    const remainingPointers: Record<string, OwnedPointer> = {};
    if (Object.keys(owned.pointers).length > 0) {
      const pointer = owned.pointers["mcp.loom"]!;
      const absolute = resolve(projectRoot, pointer.path);
      const content = await readProjectOptional(
        projectRoot,
        pointer.path,
        diagnostics,
      );
      if (content === undefined) {
        skipped.push(absolute);
      } else {
        const parsed = parseJsonc(content, pointer.path);
        diagnostics.push(...parsed.diagnostics);
        if (
          parsed.value === undefined ||
          !sameValue(pointerValue(parsed.value), pointer.value)
        ) {
          diagnostics.push(
            error(
              "opencode.modified-owned-pointer",
              "Owned mcp.loom config was modified; refusing to remove it",
              pointer.path,
            ),
          );
          skipped.push(absolute);
          remainingPointers["mcp.loom"] = pointer;
        } else {
          const updated = Object.keys(owned.pointers).reduce(
            (text, key) => setMcp(text, key.split(".")[1]!, undefined),
            content,
          );
          if (updated !== content) {
            changed.push(absolute);
            if (!dryRun) {
              try {
                await assertNoSymlink(projectRoot, absolute);
                await writeFileAtomic(absolute, updated);
              } catch {
                changed.pop();
                skipped.push(absolute);
                diagnostics.push(
                  error(
                    "opencode.unsafe-path",
                    "OpenCode config path contains a symlink",
                    pointer.path,
                  ),
                );
                remainingPointers["mcp.loom"] = pointer;
              }
            }
          }
        }
      }
    }

    const nextOwnership: Ownership = structuredClone(state.ownership);
    if (
      Object.keys(remainingFiles).length > 0 ||
      Object.keys(remainingPointers).length > 0
    ) {
      nextOwnership.harnesses[this.id] = {
        files: remainingFiles,
        pointers: remainingPointers,
      };
    } else {
      delete nextOwnership.harnesses[this.id];
    }
    const ownershipAbsolute = resolve(projectRoot, OWNERSHIP_PATH);
    if (Object.keys(nextOwnership.harnesses).length === 0) {
      changed.push(ownershipAbsolute);
      if (!dryRun) {
        try {
          await assertNoSymlink(projectRoot, ownershipAbsolute);
          await rm(ownershipAbsolute, { force: true });
        } catch {
          changed.pop();
          skipped.push(ownershipAbsolute);
          diagnostics.push(
            error(
              "opencode.unsafe-path",
              "Ownership path contains a symlink",
              OWNERSHIP_PATH,
            ),
          );
        }
      }
    } else {
      const nextContent = `${JSON.stringify(nextOwnership, null, 2)}\n`;
      if (nextContent !== state.content) {
        changed.push(ownershipAbsolute);
        if (!dryRun) {
          try {
            await assertNoSymlink(projectRoot, ownershipAbsolute);
            await writeFileAtomic(ownershipAbsolute, nextContent);
          } catch {
            changed.pop();
            skipped.push(ownershipAbsolute);
            diagnostics.push(
              error(
                "opencode.unsafe-path",
                "Ownership path contains a symlink",
                OWNERSHIP_PATH,
              ),
            );
          }
        }
      }
    }
    return {
      changed: [...new Set(changed)],
      skipped: [...new Set(skipped)],
      diagnostics,
    };
  }
}

export default OpenCodeHarnessAdapter;
