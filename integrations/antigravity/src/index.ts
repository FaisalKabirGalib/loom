import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  writeFileAtomic,
  type ApplyResult,
  type CapabilityPlan,
  type ConfigMutation,
  type ConfigMutationPlan,
  type Diagnostic,
  type HarnessAdapter,
  type HarnessState,
  type LoomResources,
} from "@loom/core";

export const ANTIGRAVITY_VERSION = "2.9.1";
export const ANTIGRAVITY_CLI_VERSION = "1.1.17";
export const ANTIGRAVITY_CONFIG_PATH = ".agents/mcp_config.json";

const OWNERSHIP_PATH = ".loom/ownership.json";
const POINTER_KEY = "mcpServers.loom";
const AGENT_BROWSER_POINTER_KEY = "mcpServers.agent-browser";

interface OwnedPointer {
  path: typeof ANTIGRAVITY_CONFIG_PATH;
  value: ServerValue;
  created: boolean;
}

interface AntigravityOwnership {
  files: Record<string, string>;
  pointers: Record<typeof POINTER_KEY, OwnedPointer> &
    Partial<Record<typeof AGENT_BROWSER_POINTER_KEY, OwnedPointer>>;
}

interface OwnershipManifest {
  version: 1;
  harnesses: Record<string, unknown> & {
    antigravity?: AntigravityOwnership;
  };
}

interface ServerValue {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AntigravityAdapterOptions {
  command?: string;
  args?: readonly string[];
  source?: string;
  skillsSource?: string;
  fileOperations?: AntigravityFileOperations;
}

export type AntigravityHarnessAdapterOptions = AntigravityAdapterOptions;

export interface AntigravityFileOperations {
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

interface PendingMutation {
  mutation: ConfigMutation;
  relativePath: string;
  previous: string | undefined;
  previousBytes: Buffer | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sameValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function diagnostic(code: string, message: string, path?: string): Diagnostic {
  return path === undefined
    ? { level: "error", code, message }
    : { level: "error", code, message, path };
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

function isSkillPath(path: unknown): path is string {
  if (!isNormalizedRelative(path)) return false;
  const parts = path.split("/");
  return (
    parts.length === 4 &&
    parts[0] === ".agents" &&
    parts[1] === "skills" &&
    /^loom-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(parts[2] ?? "") &&
    parts[3] === "SKILL.md"
  );
}

function isMutationPath(path: string): boolean {
  return (
    path === OWNERSHIP_PATH ||
    path === ANTIGRAVITY_CONFIG_PATH ||
    isSkillPath(path)
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
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return;
      throw error;
    }
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
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
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
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
      diagnostic(
        "antigravity.unsafe-path",
        "Path contains a symlink or escapes the project root",
        path,
      ),
    );
    return undefined;
  }
}

function parseObject(content: string, path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (!isRecord(value)) throw new Error(`${path} must contain a JSON object`);
  return value;
}

function parseOwnership(content: string | undefined): OwnershipManifest {
  if (content === undefined) return { version: 1, harnesses: {} };
  const value = parseObject(content, OWNERSHIP_PATH);
  if (value.version !== 1 || !isRecord(value.harnesses)) {
    throw new Error("Unsupported Loom ownership manifest version");
  }
  const owned = value.harnesses.antigravity;
  if (owned !== undefined) {
    if (
      !isRecord(owned) ||
      !isRecord(owned.files) ||
      !isRecord(owned.pointers)
    ) {
      throw new Error("Invalid Antigravity ownership manifest");
    }
    for (const [path, hash] of Object.entries(owned.files)) {
      if (
        !isSkillPath(path) ||
        typeof hash !== "string" ||
        !/^[a-f0-9]{64}$/u.test(hash)
      ) {
        throw new Error("Invalid Antigravity owned file");
      }
    }
    if (
      Object.keys(owned.pointers).some(
        (key) => key !== POINTER_KEY && key !== AGENT_BROWSER_POINTER_KEY,
      )
    ) {
      throw new Error("Invalid Antigravity owned pointer");
    }
    if (owned.pointers[POINTER_KEY] === undefined)
      throw new Error("Invalid Antigravity owned pointer");
    for (const pointer of Object.values(owned.pointers))
      if (
        !isRecord(pointer) ||
        pointer.path !== ANTIGRAVITY_CONFIG_PATH ||
        typeof pointer.created !== "boolean" ||
        !isServerValue(pointer.value)
      )
        throw new Error("Invalid Antigravity owned pointer");
  }
  return value as unknown as OwnershipManifest;
}

function isServerValue(value: unknown): value is ServerValue {
  return (
    isRecord(value) &&
    typeof value.command === "string" &&
    Array.isArray(value.args) &&
    value.args.every((argument) => typeof argument === "string") &&
    Object.keys(value).every((key) => key === "command" || key === "args")
  );
}

function pointerValue(config: Record<string, unknown>, name: string): unknown {
  return isRecord(config.mcpServers) ? config.mcpServers[name] : undefined;
}

function setPointer(
  config: Record<string, unknown>,
  name: string,
  value: ServerValue | undefined,
): Record<string, unknown> {
  const next = structuredClone(config);
  const servers = isRecord(next.mcpServers) ? { ...next.mcpServers } : {};
  if (value === undefined) delete servers[name];
  else servers[name] = value;
  if (Object.keys(servers).length === 0) delete next.mcpServers;
  else next.mcpServers = servers;
  return next;
}

function stringify(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function otherHarnessOwnsFile(
  ownership: OwnershipManifest,
  harness: string,
  path: string,
  hash: string,
): boolean {
  return Object.entries(ownership.harnesses).some(([id, entry]) => {
    if (id === harness || !isRecord(entry)) return false;
    const files = entry.files;
    if (Array.isArray(files)) {
      return files.some(
        (file) => isRecord(file) && file.path === path && file.sha256 === hash,
      );
    }
    return isRecord(files) && files[path] === hash;
  });
}

async function collectSkills(source: string): Promise<Record<string, string>> {
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Skills source must be a real directory");
  }
  const result: Record<string, string> = {};
  const entries = (await readdir(source, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    if (!entry.name.startsWith("loom-")) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Unsupported skill source entry: ${entry.name}`);
    }
    if (!/^loom-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.name)) {
      throw new Error(`Invalid skill name: ${entry.name}`);
    }
    const skillPath = resolve(source, entry.name, "SKILL.md");
    const skillStat = await lstat(skillPath);
    if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
      throw new Error(`Skill must be a regular file: ${entry.name}/SKILL.md`);
    }
    result[`.agents/skills/${entry.name}/SKILL.md`] = await readFile(
      skillPath,
      "utf8",
    );
  }
  return result;
}

function mutation(
  kind: ConfigMutation["kind"],
  root: string,
  path: string,
  description: string,
  content?: string,
  expectedHash?: string,
): ConfigMutation {
  return {
    kind,
    path: resolve(root, path),
    description,
    ...(content === undefined ? {} : { content }),
    ...(expectedHash === undefined ? {} : { expectedHash }),
  };
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

export class AntigravityHarnessAdapter implements HarnessAdapter {
  readonly id = "antigravity";
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #source: string;
  readonly #fileOperations: AntigravityFileOperations;
  readonly #issuedPlans = new WeakSet<ConfigMutationPlan>();

  constructor(options: AntigravityAdapterOptions = {}) {
    this.#command = options.command ?? "loom";
    this.#args = options.args ?? ["mcp"];
    if (
      this.#command.length === 0 ||
      this.#command.includes("\0") ||
      this.#args.some((argument) => argument.includes("\0"))
    ) {
      throw new Error(
        "Antigravity command and args must be non-empty, NUL-free strings",
      );
    }
    this.#source = resolve(
      options.source ??
        options.skillsSource ??
        fileURLToPath(new URL("../../../packages/skills", import.meta.url)),
    );
    this.#fileOperations =
      options.fileOperations ??
      ({
        write: writeFileAtomic,
        remove: rm,
      } satisfies AntigravityFileOperations);
  }

  #issuePlan(plan: ConfigMutationPlan): ConfigMutationPlan {
    for (const item of plan.mutations) Object.freeze(item);
    for (const item of plan.diagnostics) Object.freeze(item);
    Object.freeze(plan.mutations);
    Object.freeze(plan.diagnostics);
    this.#issuedPlans.add(plan);
    return Object.freeze(plan);
  }

  async inspect(root: string): Promise<HarnessState> {
    const projectRoot = resolve(root);
    const diagnostics: Diagnostic[] = [];
    const ownershipContent = await readProjectOptional(
      projectRoot,
      OWNERSHIP_PATH,
      diagnostics,
    );
    let installed = false;
    try {
      installed =
        parseOwnership(ownershipContent).harnesses.antigravity !== undefined;
    } catch (error) {
      diagnostics.push(
        diagnostic(
          "antigravity.ownership-invalid",
          (error as Error).message,
          OWNERSHIP_PATH,
        ),
      );
    }
    await readProjectOptional(
      projectRoot,
      ANTIGRAVITY_CONFIG_PATH,
      diagnostics,
    );
    return {
      id: this.id,
      installed,
      configPaths: [resolve(projectRoot, ANTIGRAVITY_CONFIG_PATH)],
      diagnostics,
    };
  }

  async planInstall(
    root: string,
    _plan: CapabilityPlan,
    resources?: LoomResources,
  ): Promise<ConfigMutationPlan> {
    const projectRoot = resolve(root);
    const diagnostics: Diagnostic[] = [];
    const mutations: ConfigMutation[] = [];
    const ownershipContent = await readProjectOptional(
      projectRoot,
      OWNERSHIP_PATH,
      diagnostics,
    );
    let ownership: OwnershipManifest;
    try {
      ownership = parseOwnership(ownershipContent);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          "antigravity.ownership-invalid",
          (error as Error).message,
          OWNERSHIP_PATH,
        ),
      );
      return this.#issuePlan({
        harness: this.id,
        root: projectRoot,
        mutations: [],
        diagnostics,
      });
    }
    const previous = ownership.harnesses.antigravity;
    let desiredFiles: Record<string, string> = {};
    try {
      desiredFiles = await collectSkills(this.#source);
      if (resources?.skill !== undefined) {
        const path = `.agents/skills/${resources.skill.name}/SKILL.md`;
        if (!isSkillPath(path)) throw new Error("Invalid Loom resource skill");
        desiredFiles[path] = resources.skill.content;
      }
    } catch (error) {
      diagnostics.push(
        diagnostic(
          "antigravity.skills-source",
          (error as Error).message,
          this.#source,
        ),
      );
    }
    for (const [path, content] of Object.entries(desiredFiles)) {
      const existing = await readProjectOptional(
        projectRoot,
        path,
        diagnostics,
      );
      const existingHash =
        existing === undefined ? undefined : sha256(existing);
      const previousHash = previous?.files[path];
      const shared =
        existingHash !== undefined &&
        otherHarnessOwnsFile(ownership, this.id, path, existingHash);
      if (previousHash !== undefined && existingHash !== previousHash) {
        diagnostics.push(
          diagnostic(
            "antigravity.owned-file-modified",
            "Refusing to overwrite a modified owned skill file",
            path,
          ),
        );
      } else if (
        previousHash === undefined &&
        existing !== undefined &&
        !shared
      ) {
        diagnostics.push(
          diagnostic(
            "antigravity.skill-collision",
            "Skill file already exists and is not owned by Loom",
            path,
          ),
        );
      } else if (shared && existing !== content) {
        diagnostics.push(
          diagnostic(
            "antigravity.shared-version-collision",
            "A different harness owns another version of this shared skill",
            path,
          ),
        );
      } else if (existing !== content) {
        mutations.push(
          mutation(
            existing === undefined ? "create-file" : "update-file",
            projectRoot,
            path,
            `Install ${path}`,
            content,
            existingHash,
          ),
        );
      }
    }
    for (const [path, expectedHash] of Object.entries(previous?.files ?? {})) {
      if (path in desiredFiles) continue;
      const existing = await readProjectOptional(
        projectRoot,
        path,
        diagnostics,
      );
      if (existing === undefined) continue;
      if (sha256(existing) !== expectedHash) {
        diagnostics.push(
          diagnostic(
            "antigravity.owned-file-modified",
            "Refusing to remove a modified obsolete skill file",
            path,
          ),
        );
      } else if (
        !otherHarnessOwnsFile(ownership, this.id, path, expectedHash)
      ) {
        mutations.push(
          mutation(
            "delete-file",
            projectRoot,
            path,
            `Remove obsolete ${path}`,
            undefined,
            expectedHash,
          ),
        );
      }
    }

    const desiredServer: ServerValue = {
      command: this.#command,
      args: [...this.#args],
    };
    const configContent = await readProjectOptional(
      projectRoot,
      ANTIGRAVITY_CONFIG_PATH,
      diagnostics,
    );
    let config: Record<string, unknown> | undefined;
    try {
      config = parseObject(configContent ?? "{}", ANTIGRAVITY_CONFIG_PATH);
      if (config.mcpServers !== undefined && !isRecord(config.mcpServers)) {
        throw new Error("mcpServers must be a JSON object");
      }
    } catch (error) {
      diagnostics.push(
        diagnostic(
          "antigravity.config-invalid",
          (error as Error).message,
          ANTIGRAVITY_CONFIG_PATH,
        ),
      );
    }
    const ownedPointer = previous?.pointers[POINTER_KEY];
    if (config !== undefined) {
      const current = pointerValue(config, "loom");
      if (
        ownedPointer !== undefined &&
        !sameValue(current, ownedPointer.value)
      ) {
        diagnostics.push(
          diagnostic(
            "antigravity.owned-pointer-modified",
            "Refusing to overwrite modified owned mcpServers.loom config",
            ANTIGRAVITY_CONFIG_PATH,
          ),
        );
      } else if (ownedPointer === undefined && current !== undefined) {
        diagnostics.push(
          diagnostic(
            "antigravity.mcp-collision",
            "mcpServers.loom already exists and is not owned by Loom",
            ANTIGRAVITY_CONFIG_PATH,
          ),
        );
      } else {
        const ownedAgentBrowser = previous?.pointers[AGENT_BROWSER_POINTER_KEY];
        const desiredAgentBrowser =
          resources?.mcp === undefined
            ? undefined
            : {
                command: resources.mcp.command,
                args: [...resources.mcp.args],
                env: { ...resources.mcp.env },
              };
        const currentAgentBrowser = pointerValue(config, "agent-browser");
        if (
          ownedAgentBrowser !== undefined &&
          !sameValue(currentAgentBrowser, ownedAgentBrowser.value)
        )
          diagnostics.push(
            diagnostic(
              "antigravity.owned-pointer-modified",
              "Refusing to overwrite modified owned mcpServers.agent-browser config",
              ANTIGRAVITY_CONFIG_PATH,
            ),
          );
        else if (
          desiredAgentBrowser !== undefined &&
          ownedAgentBrowser === undefined &&
          currentAgentBrowser !== undefined
        )
          diagnostics.push(
            diagnostic(
              "antigravity.mcp-collision",
              "mcpServers.agent-browser already exists and is not owned by Loom",
              ANTIGRAVITY_CONFIG_PATH,
            ),
          );
        const nextConfig = stringify(
          setPointer(
            setPointer(config, "loom", desiredServer),
            "agent-browser",
            desiredAgentBrowser ??
              (ownedAgentBrowser === undefined
                ? (currentAgentBrowser as ServerValue | undefined)
                : undefined),
          ),
        );
        if (nextConfig !== configContent) {
          mutations.push(
            mutation(
              configContent === undefined ? "create-file" : "update-file",
              projectRoot,
              ANTIGRAVITY_CONFIG_PATH,
              "Configure the Loom MCP server for Antigravity",
              nextConfig,
              configContent === undefined ? undefined : sha256(configContent),
            ),
          );
        }
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
    ownership.harnesses.antigravity = {
      files: Object.fromEntries(
        Object.entries(desiredFiles).map(([path, content]) => [
          path,
          sha256(content),
        ]),
      ),
      pointers: {
        [POINTER_KEY]: {
          path: ANTIGRAVITY_CONFIG_PATH,
          value: desiredServer,
          created:
            previous?.pointers[POINTER_KEY]?.created ??
            configContent === undefined,
        },
        ...(resources?.mcp === undefined
          ? {}
          : {
              [AGENT_BROWSER_POINTER_KEY]: {
                path: ANTIGRAVITY_CONFIG_PATH,
                value: {
                  command: resources.mcp.command,
                  args: [...resources.mcp.args],
                  env: { ...resources.mcp.env },
                },
                created:
                  previous?.pointers[AGENT_BROWSER_POINTER_KEY]?.created ??
                  configContent === undefined,
              },
            }),
      },
    };
    const nextOwnership = `${JSON.stringify(ownership, null, 2)}\n`;
    if (nextOwnership !== ownershipContent) {
      mutations.push(
        mutation(
          ownershipContent === undefined ? "create-file" : "update-file",
          projectRoot,
          OWNERSHIP_PATH,
          "Record Antigravity integration ownership",
          nextOwnership,
          ownershipContent === undefined ? undefined : sha256(ownershipContent),
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
          diagnostic(
            "antigravity.invalid-mutation",
            "Plan was not issued by this Antigravity adapter instance",
          ),
        ],
      };
    }
    const root = resolve(plan.root);
    const diagnostics = [...plan.diagnostics];
    if (!isAbsolute(plan.root) || root !== plan.root) {
      diagnostics.push(
        diagnostic(
          "antigravity.invalid-plan-root",
          "Plan root must be a normalized absolute path",
        ),
      );
    }
    if (plan.harness !== this.id) {
      diagnostics.push(
        diagnostic(
          "antigravity.wrong-plan",
          `Cannot apply a ${plan.harness} plan`,
        ),
      );
    }
    const pending: PendingMutation[] = [];
    const skipped: string[] = [];
    for (const item of plan.mutations) {
      const relativePath = allowedMutationRelative(root, item.path);
      if (
        relativePath === undefined ||
        !["create-file", "update-file", "delete-file"].includes(item.kind) ||
        ((item.kind === "update-file" || item.kind === "delete-file") &&
          typeof item.expectedHash !== "string") ||
        ((item.kind === "create-file" || item.kind === "update-file") &&
          typeof item.content !== "string")
      ) {
        diagnostics.push(
          diagnostic(
            "antigravity.invalid-mutation",
            "Mutation path, kind, content, or expected hash is not allowed",
            item.path,
          ),
        );
        skipped.push(item.path);
        continue;
      }
      let previousBytes: Buffer | undefined;
      try {
        previousBytes = await safeReadOptionalBytes(root, relativePath);
      } catch {
        diagnostics.push(
          diagnostic(
            "antigravity.unsafe-path",
            "Mutation path contains a symlink",
            item.path,
          ),
        );
        skipped.push(item.path);
        continue;
      }
      const previous = previousBytes?.toString("utf8");
      if (item.kind !== "delete-file" && previous === item.content) {
        skipped.push(item.path);
      } else if (item.kind === "delete-file" && previous === undefined) {
        skipped.push(item.path);
      } else if (
        (item.kind === "create-file" && previous !== undefined) ||
        ((item.kind === "update-file" || item.kind === "delete-file") &&
          (previous === undefined || sha256(previous) !== item.expectedHash))
      ) {
        diagnostics.push(
          diagnostic(
            "antigravity.concurrent-change",
            "File changed after planning",
            item.path,
          ),
        );
        skipped.push(item.path);
      } else {
        pending.push({ mutation: item, relativePath, previous, previousBytes });
      }
    }
    if (diagnostics.some((item) => item.level === "error")) {
      return {
        changed: [],
        skipped: [
          ...new Set([
            ...skipped,
            ...pending.map(({ mutation: item }) => item.path),
          ]),
        ],
        diagnostics,
      };
    }
    if (dryRun) {
      return {
        changed: pending.map(({ mutation: item }) => item.path),
        skipped,
        diagnostics,
      };
    }
    const journal: PendingMutation[] = [];
    const changed: string[] = [];
    for (const entry of pending) {
      const { mutation: item, relativePath } = entry;
      try {
        await assertNoSymlink(root, resolve(root, relativePath));
        if (
          !sameBytes(
            await safeReadOptionalBytes(root, relativePath),
            entry.previousBytes,
          )
        ) {
          throw new Error("File changed after preflight");
        }
        if (item.kind === "delete-file")
          await this.#fileOperations.remove(item.path);
        else await this.#fileOperations.write(item.path, item.content!);
        journal.push(entry);
        changed.push(item.path);
      } catch (error) {
        const intended = item.kind === "delete-file" ? undefined : item.content;
        try {
          if ((await safeReadOptional(root, relativePath)) === intended)
            journal.push(entry);
        } catch {}
        const rollbackFailures: string[] = [];
        for (const applied of journal.reverse()) {
          try {
            await assertNoSymlink(root, resolve(root, applied.relativePath));
            const expected =
              applied.mutation.kind === "delete-file"
                ? undefined
                : applied.mutation.content;
            if (
              !sameBytes(
                await safeReadOptionalBytes(root, applied.relativePath),
                expected === undefined ? undefined : Buffer.from(expected),
              )
            ) {
              throw new Error("File changed before rollback");
            }
            if (applied.previousBytes === undefined) {
              await this.#fileOperations.remove(applied.mutation.path);
            } else {
              await writeBytesAtomic(
                applied.mutation.path,
                applied.previousBytes,
              );
            }
          } catch {
            rollbackFailures.push(applied.mutation.path);
          }
        }
        diagnostics.push(
          diagnostic(
            "antigravity.apply-failed",
            `Apply failed at ${item.path}: ${error instanceof Error ? error.message : String(error)}; ${rollbackFailures.length === 0 ? "all earlier mutations were rolled back" : `rollback failed for ${rollbackFailures.join(", ")}`}`,
            item.path,
          ),
        );
        return {
          changed: [],
          skipped: pending.map(({ mutation: pendingItem }) => pendingItem.path),
          diagnostics,
        };
      }
    }
    return { changed, skipped, diagnostics };
  }

  async verify(root: string): Promise<Diagnostic[]> {
    const projectRoot = resolve(root);
    const diagnostics: Diagnostic[] = [];
    let ownership: OwnershipManifest;
    try {
      ownership = parseOwnership(
        await readProjectOptional(projectRoot, OWNERSHIP_PATH, diagnostics),
      );
    } catch (error) {
      return [
        ...diagnostics,
        diagnostic(
          "antigravity.ownership-invalid",
          (error as Error).message,
          OWNERSHIP_PATH,
        ),
      ];
    }
    const owned = ownership.harnesses.antigravity;
    if (owned === undefined) {
      return [
        ...diagnostics,
        diagnostic(
          "antigravity.not-installed",
          "Antigravity integration is not owned by Loom",
        ),
      ];
    }
    for (const [path, hash] of Object.entries(owned.files)) {
      const content = await readProjectOptional(projectRoot, path, diagnostics);
      if (content === undefined || sha256(content) !== hash) {
        diagnostics.push(
          diagnostic(
            "antigravity.owned-file-modified",
            "Owned skill is missing or modified",
            path,
          ),
        );
      }
    }
    const pointer = owned.pointers[POINTER_KEY];
    const configContent = await readProjectOptional(
      projectRoot,
      pointer.path,
      diagnostics,
    );
    if (configContent === undefined) {
      diagnostics.push(
        diagnostic(
          "antigravity.config-modified",
          "Owned MCP config is missing",
          pointer.path,
        ),
      );
    } else {
      try {
        const config = parseObject(configContent, pointer.path);
        if (
          Object.entries(owned.pointers).some(
            ([key, ownedPointer]) =>
              !sameValue(
                pointerValue(config, key.split(".")[1]!),
                ownedPointer.value,
              ),
          )
        ) {
          diagnostics.push(
            diagnostic(
              "antigravity.config-modified",
              "Owned MCP config is modified",
              pointer.path,
            ),
          );
        }
      } catch (error) {
        diagnostics.push(
          diagnostic(
            "antigravity.config-invalid",
            (error as Error).message,
            pointer.path,
          ),
        );
      }
    }
    return diagnostics;
  }

  async uninstallOwned(root: string, dryRun = false): Promise<ApplyResult> {
    const projectRoot = resolve(root);
    const diagnostics: Diagnostic[] = [];
    const ownershipContent = await readProjectOptional(
      projectRoot,
      OWNERSHIP_PATH,
      diagnostics,
    );
    let ownership: OwnershipManifest;
    try {
      ownership = parseOwnership(ownershipContent);
    } catch (error) {
      return {
        changed: [],
        skipped: [resolve(projectRoot, OWNERSHIP_PATH)],
        diagnostics: [
          ...diagnostics,
          diagnostic(
            "antigravity.ownership-invalid",
            (error as Error).message,
            OWNERSHIP_PATH,
          ),
        ],
      };
    }
    const owned = ownership.harnesses.antigravity;
    if (owned === undefined || ownershipContent === undefined) {
      return { changed: [], skipped: [], diagnostics };
    }
    const mutations: ConfigMutation[] = [];
    for (const [path, hash] of Object.entries(owned.files)) {
      const content = await readProjectOptional(projectRoot, path, diagnostics);
      if (content === undefined) continue;
      if (sha256(content) !== hash) {
        diagnostics.push(
          diagnostic(
            "antigravity.owned-file-modified",
            "Refusing to remove a modified owned skill",
            path,
          ),
        );
      } else if (!otherHarnessOwnsFile(ownership, this.id, path, hash)) {
        mutations.push(
          mutation(
            "delete-file",
            projectRoot,
            path,
            `Remove ${path}`,
            undefined,
            hash,
          ),
        );
      }
    }
    const pointer = owned.pointers[POINTER_KEY];
    const configContent = await readProjectOptional(
      projectRoot,
      pointer.path,
      diagnostics,
    );
    if (configContent !== undefined) {
      try {
        const config = parseObject(configContent, pointer.path);
        if (
          Object.entries(owned.pointers).some(
            ([key, ownedPointer]) =>
              !sameValue(
                pointerValue(config, key.split(".")[1]!),
                ownedPointer.value,
              ),
          )
        ) {
          diagnostics.push(
            diagnostic(
              "antigravity.config-modified",
              "Refusing to remove modified owned mcpServers.loom config",
              pointer.path,
            ),
          );
        } else {
          const nextConfig = Object.keys(owned.pointers).reduce(
            (next, key) => setPointer(next, key.split(".")[1]!, undefined),
            config,
          );
          if (pointer.created && Object.keys(nextConfig).length === 0) {
            mutations.push(
              mutation(
                "delete-file",
                projectRoot,
                pointer.path,
                "Remove Loom-created Antigravity config",
                undefined,
                sha256(configContent),
              ),
            );
          } else {
            mutations.push(
              mutation(
                "update-file",
                projectRoot,
                pointer.path,
                "Remove the Loom MCP server from Antigravity",
                stringify(nextConfig),
                sha256(configContent),
              ),
            );
          }
        }
      } catch (error) {
        diagnostics.push(
          diagnostic(
            "antigravity.config-invalid",
            (error as Error).message,
            pointer.path,
          ),
        );
      }
    }
    if (diagnostics.some((item) => item.level === "error")) {
      return {
        changed: [],
        skipped: [
          ...Object.keys(owned.files),
          pointer.path,
          OWNERSHIP_PATH,
        ].map((path) => resolve(projectRoot, path)),
        diagnostics,
      };
    }
    delete ownership.harnesses.antigravity;
    if (Object.keys(ownership.harnesses).length === 0) {
      mutations.push(
        mutation(
          "delete-file",
          projectRoot,
          OWNERSHIP_PATH,
          "Remove empty Loom ownership manifest",
          undefined,
          sha256(ownershipContent),
        ),
      );
    } else {
      mutations.push(
        mutation(
          "update-file",
          projectRoot,
          OWNERSHIP_PATH,
          "Remove Antigravity integration ownership",
          `${JSON.stringify(ownership, null, 2)}\n`,
          sha256(ownershipContent),
        ),
      );
    }
    const plan = this.#issuePlan({
      harness: this.id,
      root: projectRoot,
      mutations,
      diagnostics,
    });
    return this.apply(plan, dryRun);
  }
}

export { AntigravityHarnessAdapter as AntigravityAdapter };
export default AntigravityHarnessAdapter;
