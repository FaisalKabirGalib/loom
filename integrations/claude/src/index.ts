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
import { writeFileAtomic } from "@loom/core";
import type {
  ApplyResult,
  CapabilityPlan,
  ConfigMutation,
  ConfigMutationPlan,
  Diagnostic,
  HarnessAdapter as CoreHarnessAdapter,
  HarnessState,
} from "@loom/core";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

const CONFIG_PATH = ".mcp.json";
const OWNERSHIP_PATH = ".loom/ownership.json";
const POINTER = "mcpServers.loom";

interface OwnedPointer {
  path: string;
  value: unknown;
}

interface ClaudeOwnership {
  files: Record<string, string>;
  pointers: Record<string, OwnedPointer>;
}

interface Ownership {
  version: 1;
  harnesses: Record<string, unknown> & { claude?: ClaudeOwnership };
}

export interface ClaudeFileOperations {
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface ClaudeHarnessAdapterOptions {
  command?: string;
  args?: readonly string[];
  skillsSource?: string;
  fileOperations?: ClaudeFileOperations;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    parts[0] === ".claude" &&
    parts[1] === "skills" &&
    /^loom-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(parts[2] ?? "") &&
    parts[3] === "SKILL.md"
  );
}

function isMutationPath(path: string): boolean {
  return path === CONFIG_PATH || path === OWNERSHIP_PATH || isSkillPath(path);
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
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

async function safeRead(
  root: string,
  path: string,
): Promise<string | undefined> {
  const absolute = resolve(root, path);
  await assertNoSymlink(root, absolute);
  return readOptional(absolute);
}

async function safeReadBytes(
  root: string,
  path: string,
): Promise<Buffer | undefined> {
  const absolute = resolve(root, path);
  await assertNoSymlink(root, absolute);
  try {
    return await readFile(absolute);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

async function projectRead(
  root: string,
  path: string,
  diagnostics: Diagnostic[],
): Promise<string | undefined> {
  try {
    return await safeRead(root, path);
  } catch {
    diagnostics.push(
      diagnostic(
        "claude.unsafe-path",
        "Path contains a symlink or escapes the project root",
        path,
      ),
    );
    return undefined;
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

function parseConfig(text: string): {
  value?: Record<string, unknown>;
  diagnostics: Diagnostic[];
} {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || !isRecord(value)) {
    return {
      diagnostics: [
        diagnostic(
          "claude.invalid-config",
          "Claude MCP config is not a valid JSON object",
          CONFIG_PATH,
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

function setPointer(text: string, value: unknown): string {
  return applyEdits(
    text,
    modify(text, ["mcpServers", "loom"], value, {
      formattingOptions: formatting(text),
    }),
  );
}

function pointerValue(config: Record<string, unknown>): unknown {
  return isRecord(config.mcpServers) ? config.mcpServers.loom : undefined;
}

function emptyOwnership(): Ownership {
  return { version: 1, harnesses: {} };
}

async function readOwnership(root: string): Promise<{
  ownership: Ownership;
  content?: string;
  diagnostics: Diagnostic[];
}> {
  let content: string | undefined;
  try {
    content = await safeRead(root, OWNERSHIP_PATH);
  } catch {
    return {
      ownership: emptyOwnership(),
      diagnostics: [
        diagnostic(
          "claude.unsafe-path",
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
    const owned = value.harnesses.claude;
    if (owned !== undefined) {
      if (
        !isRecord(owned) ||
        !isRecord(owned.files) ||
        !isRecord(owned.pointers)
      )
        throw new Error();
      for (const [path, expectedHash] of Object.entries(owned.files)) {
        if (!isSkillPath(path) || typeof expectedHash !== "string")
          throw new Error();
      }
      const pointers = Object.entries(owned.pointers);
      if (
        pointers.some(
          ([key, pointer]) =>
            key !== POINTER ||
            !isRecord(pointer) ||
            pointer.path !== CONFIG_PATH ||
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
        diagnostic(
          "claude.invalid-ownership",
          "Loom ownership file is invalid",
          OWNERSHIP_PATH,
        ),
      ],
    };
  }
}

function otherHarnessOwnsFile(
  ownership: Ownership,
  path: string,
  expectedHash: string,
): boolean {
  return Object.entries(ownership.harnesses).some(([id, value]) => {
    if (id === "claude" || !isRecord(value)) return false;
    const files = value.files;
    if (Array.isArray(files)) {
      return files.some(
        (file) =>
          isRecord(file) && file.path === path && file.sha256 === expectedHash,
      );
    }
    return isRecord(files) && files[path] === expectedHash;
  });
}

async function collectSkills(source: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const sourceStat = await lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())
    throw new Error("Invalid skills source");
  const entries = (await readdir(source, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    if (!entry.name.startsWith("loom-")) continue;
    if (
      !entry.isDirectory() ||
      !/^loom-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.name)
    )
      throw new Error(`Unsupported skill entry: ${entry.name}`);
    const directory = resolve(source, entry.name);
    const skillPath = resolve(directory, "SKILL.md");
    const directoryStat = await lstat(directory);
    const skillStat = await lstat(skillPath);
    if (
      directoryStat.isSymbolicLink() ||
      skillStat.isSymbolicLink() ||
      !skillStat.isFile()
    )
      throw new Error(`Unsupported skill entry: ${entry.name}`);
    result[`.claude/skills/${entry.name}/SKILL.md`] = await readFile(
      skillPath,
      "utf8",
    );
  }
  return result;
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

export class ClaudeHarnessAdapter implements CoreHarnessAdapter {
  readonly id = "claude";
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #skillsSource: string;
  readonly #fileOperations: ClaudeFileOperations;
  readonly #issuedPlans = new WeakSet<ConfigMutationPlan>();

  constructor(options: ClaudeHarnessAdapterOptions = {}) {
    this.#command = options.command ?? "loom";
    this.#args = options.args ?? ["mcp"];
    this.#skillsSource = resolve(
      options.skillsSource ??
        fileURLToPath(new URL("../../../packages/skills", import.meta.url)),
    );
    this.#fileOperations =
      options.fileOperations ??
      ({ write: writeFileAtomic, remove: rm } satisfies ClaudeFileOperations);
  }

  async inspect(root: string): Promise<HarnessState> {
    const projectRoot = resolve(root);
    const state = await readOwnership(projectRoot);
    const diagnostics = [...state.diagnostics];
    await projectRead(projectRoot, CONFIG_PATH, diagnostics);
    return {
      id: this.id,
      installed: state.ownership.harnesses.claude !== undefined,
      configPaths: [resolve(projectRoot, CONFIG_PATH)],
      diagnostics,
    };
  }

  #issue(plan: ConfigMutationPlan): ConfigMutationPlan {
    for (const item of plan.mutations) Object.freeze(item);
    for (const item of plan.diagnostics) Object.freeze(item);
    Object.freeze(plan.mutations);
    Object.freeze(plan.diagnostics);
    this.#issuedPlans.add(plan);
    return Object.freeze(plan);
  }

  async planInstall(
    root: string,
    _plan: CapabilityPlan,
  ): Promise<ConfigMutationPlan> {
    const projectRoot = resolve(root);
    const diagnostics: Diagnostic[] = [];
    const mutations: ConfigMutation[] = [];
    const state = await readOwnership(projectRoot);
    diagnostics.push(...state.diagnostics);
    const previous = state.ownership.harnesses.claude;
    const ownedFiles = previous?.files ?? {};
    const ownedPointer = previous?.pointers[POINTER];
    let desiredFiles: Record<string, string> = {};
    try {
      desiredFiles = await collectSkills(this.#skillsSource);
    } catch {
      diagnostics.push(
        diagnostic(
          "claude.skills-source",
          "Unable to read the Loom skills source",
          this.#skillsSource,
        ),
      );
    }

    for (const [path, content] of Object.entries(desiredFiles)) {
      const current = await projectRead(projectRoot, path, diagnostics);
      const currentHash = current === undefined ? undefined : hash(current);
      const ownedHash = ownedFiles[path];
      const shared =
        currentHash !== undefined &&
        otherHarnessOwnsFile(state.ownership, path, currentHash);
      if (
        ownedHash !== undefined &&
        (currentHash === undefined || currentHash !== ownedHash)
      ) {
        diagnostics.push(
          diagnostic(
            "claude.modified-owned-file",
            "Owned skill was modified; refusing to overwrite it",
            path,
          ),
        );
      } else if (ownedHash === undefined && current !== undefined && !shared) {
        diagnostics.push(
          diagnostic(
            "claude.file-collision",
            "Skill already exists and is not owned by Loom",
            path,
          ),
        );
      }
      if (current !== undefined && current !== content && shared) {
        diagnostics.push(
          diagnostic(
            "claude.shared-version-collision",
            "A different harness owns the current shared skill version",
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
            currentHash,
          ),
        );
      }
    }

    for (const [path, ownedHash] of Object.entries(ownedFiles)) {
      if (desiredFiles[path] !== undefined) continue;
      const current = await projectRead(projectRoot, path, diagnostics);
      if (current !== undefined && hash(current) !== ownedHash) {
        diagnostics.push(
          diagnostic(
            "claude.modified-owned-file",
            "Owned obsolete skill was modified; refusing to remove it",
            path,
          ),
        );
      } else if (
        current !== undefined &&
        !otherHarnessOwnsFile(state.ownership, path, ownedHash)
      ) {
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

    const config = await projectRead(projectRoot, CONFIG_PATH, diagnostics);
    const configText = config ?? "{}\n";
    const parsed = parseConfig(configText);
    diagnostics.push(...parsed.diagnostics);
    const desiredPointer = {
      type: "stdio",
      command: this.#command,
      args: [...this.#args],
    };
    if (parsed.value !== undefined) {
      if (
        parsed.value.mcpServers !== undefined &&
        !isRecord(parsed.value.mcpServers)
      ) {
        diagnostics.push(
          diagnostic(
            "claude.mcp-collision",
            "mcpServers is not an object",
            CONFIG_PATH,
          ),
        );
      } else {
        const current = pointerValue(parsed.value);
        if (
          ownedPointer !== undefined &&
          (ownedPointer.path !== CONFIG_PATH ||
            !sameValue(current, ownedPointer.value))
        ) {
          diagnostics.push(
            diagnostic(
              "claude.modified-owned-pointer",
              "Owned mcpServers.loom was modified; refusing to overwrite it",
              CONFIG_PATH,
            ),
          );
        } else if (ownedPointer === undefined && current !== undefined) {
          diagnostics.push(
            diagnostic(
              "claude.mcp-collision",
              "mcpServers.loom already exists and is not owned by Loom",
              CONFIG_PATH,
            ),
          );
        }
      }
      const updated = setPointer(configText, desiredPointer);
      if (updated !== configText) {
        mutations.push(
          mutation(
            config === undefined ? "create-file" : "update-file",
            resolve(projectRoot, CONFIG_PATH),
            "Configure the Loom MCP server for Claude",
            updated,
            config === undefined ? undefined : hash(config),
          ),
        );
      }
    }

    if (diagnostics.some((item) => item.level === "error")) {
      return this.#issue({
        harness: this.id,
        root: projectRoot,
        mutations: [],
        diagnostics,
      });
    }
    const nextOwnership: Ownership = structuredClone(state.ownership);
    nextOwnership.harnesses.claude = {
      files: Object.fromEntries(
        Object.entries(desiredFiles).map(([path, content]) => [
          path,
          hash(content),
        ]),
      ),
      pointers: {
        [POINTER]: { path: CONFIG_PATH, value: desiredPointer },
      },
    };
    const ownershipContent = `${JSON.stringify(nextOwnership, null, 2)}\n`;
    if (ownershipContent !== state.content) {
      mutations.push(
        mutation(
          state.content === undefined ? "create-file" : "update-file",
          resolve(projectRoot, OWNERSHIP_PATH),
          "Record Loom-owned Claude resources",
          ownershipContent,
          state.content === undefined ? undefined : hash(state.content),
        ),
      );
    }
    return this.#issue({
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
            "claude.invalid-mutation",
            "Plan was not issued by this Claude adapter instance",
          ),
        ],
      };
    }
    const root = resolve(plan.root);
    const diagnostics = [...plan.diagnostics];
    if (!isAbsolute(plan.root) || root !== plan.root) {
      diagnostics.push(
        diagnostic(
          "claude.invalid-plan-root",
          "Plan root must be a normalized absolute path",
        ),
      );
    }
    if (plan.harness !== this.id) {
      diagnostics.push(
        diagnostic("claude.wrong-plan", `Cannot apply a ${plan.harness} plan`),
      );
    }
    const pending: Array<{
      mutation: ConfigMutation;
      relativePath: string;
      previous?: string;
      previousBytes?: Buffer;
    }> = [];
    const skipped: string[] = [];
    if (diagnostics.some((item) => item.level === "error")) {
      return {
        changed: [],
        skipped: plan.mutations.map((item) => item.path),
        diagnostics,
      };
    }
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
            "claude.invalid-mutation",
            "Mutation path, kind, content, or expected hash is not allowed",
            item.path,
          ),
        );
        skipped.push(item.path);
        continue;
      }
      let currentBytes: Buffer | undefined;
      try {
        currentBytes = await safeReadBytes(root, relativePath);
      } catch {
        diagnostics.push(
          diagnostic(
            "claude.unsafe-path",
            "Mutation path contains a symlink",
            item.path,
          ),
        );
        skipped.push(item.path);
        continue;
      }
      const current = currentBytes?.toString("utf8");
      if (item.kind === "delete-file" && current === undefined) {
        skipped.push(item.path);
      } else if (item.kind !== "delete-file" && current === item.content) {
        skipped.push(item.path);
      } else if (
        (item.kind === "create-file" && current !== undefined) ||
        ((item.kind === "update-file" || item.kind === "delete-file") &&
          (current === undefined || hash(current) !== item.expectedHash))
      ) {
        diagnostics.push(
          diagnostic(
            "claude.concurrent-change",
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
          ...(currentBytes === undefined
            ? {}
            : { previousBytes: currentBytes }),
        });
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
    const changed: string[] = [];
    const journal: typeof pending = [];
    for (const entry of pending) {
      const item = entry.mutation;
      try {
        await assertNoSymlink(root, resolve(root, entry.relativePath));
        if (
          !sameBytes(
            await safeReadBytes(root, entry.relativePath),
            entry.previousBytes,
          )
        )
          throw new Error("File changed after preflight");
        if (item.kind === "delete-file")
          await this.#fileOperations.remove(item.path);
        else await this.#fileOperations.write(item.path, item.content!);
        journal.push(entry);
        changed.push(item.path);
      } catch (cause) {
        const intended = item.kind === "delete-file" ? undefined : item.content;
        try {
          if ((await safeRead(root, entry.relativePath)) === intended)
            journal.push(entry);
        } catch {}
        const rollbackFailures: string[] = [];
        for (const applied of journal.reverse()) {
          try {
            await assertNoSymlink(root, resolve(root, applied.relativePath));
            const expected =
              applied.mutation.kind === "delete-file"
                ? undefined
                : Buffer.from(applied.mutation.content!);
            if (
              !sameBytes(
                await safeReadBytes(root, applied.relativePath),
                expected,
              )
            )
              throw new Error("File changed before rollback");
            if (applied.previousBytes === undefined)
              await this.#fileOperations.remove(applied.mutation.path);
            else
              await writeBytesAtomic(
                applied.mutation.path,
                applied.previousBytes,
              );
          } catch {
            rollbackFailures.push(applied.mutation.path);
          }
        }
        diagnostics.push(
          diagnostic(
            "claude.apply-failed",
            `Apply failed at ${item.path}: ${cause instanceof Error ? cause.message : String(cause)}; ${rollbackFailures.length === 0 ? "all earlier mutations were rolled back" : `rollback failed for ${rollbackFailures.join(", ")}`}`,
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
    const state = await readOwnership(projectRoot);
    const diagnostics = [...state.diagnostics];
    const owned = state.ownership.harnesses.claude;
    if (owned === undefined) {
      diagnostics.push(
        diagnostic(
          "claude.not-installed",
          "Loom Claude integration is not installed",
        ),
      );
      return diagnostics;
    }
    for (const [path, expectedHash] of Object.entries(owned.files)) {
      const content = await projectRead(projectRoot, path, diagnostics);
      if (content === undefined || hash(content) !== expectedHash) {
        diagnostics.push(
          diagnostic(
            "claude.modified-owned-file",
            "Owned skill is missing or modified",
            path,
          ),
        );
      }
    }
    const pointer = owned.pointers[POINTER];
    if (pointer === undefined) {
      diagnostics.push(
        diagnostic(
          "claude.missing-pointer",
          "Ownership record is missing mcpServers.loom",
        ),
      );
      return diagnostics;
    }
    const content = await projectRead(projectRoot, pointer.path, diagnostics);
    if (content === undefined) {
      diagnostics.push(
        diagnostic(
          "claude.missing-config",
          "Owned Claude MCP config is missing",
          pointer.path,
        ),
      );
    } else {
      const parsed = parseConfig(content);
      diagnostics.push(...parsed.diagnostics);
      if (
        parsed.value !== undefined &&
        !sameValue(pointerValue(parsed.value), pointer.value)
      ) {
        diagnostics.push(
          diagnostic(
            "claude.modified-owned-pointer",
            "Owned mcpServers.loom was modified",
            pointer.path,
          ),
        );
      }
    }
    return diagnostics;
  }

  async uninstallOwned(root: string, dryRun = false): Promise<ApplyResult> {
    const projectRoot = resolve(root);
    const state = await readOwnership(projectRoot);
    const diagnostics = [...state.diagnostics];
    const owned = state.ownership.harnesses.claude;
    if (
      owned === undefined ||
      diagnostics.some((item) => item.level === "error")
    )
      return { changed: [], skipped: [], diagnostics };
    const paths = [
      ...Object.keys(owned.files),
      ...Object.values(owned.pointers).map((pointer) => pointer.path),
      OWNERSHIP_PATH,
    ];
    for (const path of paths) {
      try {
        await assertNoSymlink(projectRoot, resolve(projectRoot, path));
      } catch {
        diagnostics.push(
          diagnostic(
            "claude.unsafe-path",
            "Uninstall path contains a symlink",
            path,
          ),
        );
      }
    }
    if (diagnostics.some((item) => item.level === "error")) {
      return {
        changed: [],
        skipped: paths.map((path) => resolve(projectRoot, path)),
        diagnostics,
      };
    }
    const changed: string[] = [];
    const skipped: string[] = [];
    const remainingFiles: Record<string, string> = {};
    for (const [path, expectedHash] of Object.entries(owned.files)) {
      const absolute = resolve(projectRoot, path);
      const content = await projectRead(projectRoot, path, diagnostics);
      if (content === undefined) {
        skipped.push(absolute);
      } else if (hash(content) !== expectedHash) {
        remainingFiles[path] = expectedHash;
        skipped.push(absolute);
        diagnostics.push(
          diagnostic(
            "claude.modified-owned-file",
            "Owned skill was modified; refusing to remove it",
            path,
          ),
        );
      } else if (otherHarnessOwnsFile(state.ownership, path, expectedHash)) {
        skipped.push(absolute);
      } else {
        changed.push(absolute);
        if (!dryRun) {
          try {
            await assertNoSymlink(projectRoot, absolute);
            if ((await safeRead(projectRoot, path)) !== content)
              throw new Error("File changed before uninstall");
            await this.#fileOperations.remove(absolute);
          } catch {
            changed.pop();
            skipped.push(absolute);
            remainingFiles[path] = expectedHash;
            diagnostics.push(
              diagnostic(
                "claude.uninstall-failed",
                "Unable to remove owned skill",
                path,
              ),
            );
          }
        }
      }
    }
    const remainingPointers: Record<string, OwnedPointer> = {};
    const pointer = owned.pointers[POINTER];
    if (pointer !== undefined) {
      const absolute = resolve(projectRoot, pointer.path);
      const content = await projectRead(projectRoot, pointer.path, diagnostics);
      if (content === undefined) {
        skipped.push(absolute);
      } else {
        const parsed = parseConfig(content);
        diagnostics.push(...parsed.diagnostics);
        if (
          parsed.value === undefined ||
          !sameValue(pointerValue(parsed.value), pointer.value)
        ) {
          skipped.push(absolute);
          remainingPointers[POINTER] = pointer;
          diagnostics.push(
            diagnostic(
              "claude.modified-owned-pointer",
              "Owned mcpServers.loom was modified; refusing to remove it",
              pointer.path,
            ),
          );
        } else {
          const updated = setPointer(content, undefined);
          if (updated !== content) {
            changed.push(absolute);
            if (!dryRun) {
              try {
                await assertNoSymlink(projectRoot, absolute);
                if ((await safeRead(projectRoot, pointer.path)) !== content)
                  throw new Error("File changed before uninstall");
                await writeFileAtomic(absolute, updated);
              } catch {
                changed.pop();
                skipped.push(absolute);
                remainingPointers[POINTER] = pointer;
                diagnostics.push(
                  diagnostic(
                    "claude.uninstall-failed",
                    "Unable to update Claude MCP config",
                    pointer.path,
                  ),
                );
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
      nextOwnership.harnesses.claude = {
        files: remainingFiles,
        pointers: remainingPointers,
      };
    } else {
      delete nextOwnership.harnesses.claude;
    }
    const ownershipAbsolute = resolve(projectRoot, OWNERSHIP_PATH);
    if (Object.keys(nextOwnership.harnesses).length === 0) {
      changed.push(ownershipAbsolute);
      if (!dryRun) {
        try {
          await assertNoSymlink(projectRoot, ownershipAbsolute);
          if ((await safeRead(projectRoot, OWNERSHIP_PATH)) !== state.content)
            throw new Error("Ownership changed before uninstall");
          await rm(ownershipAbsolute, { force: true });
        } catch {
          changed.pop();
          skipped.push(ownershipAbsolute);
          diagnostics.push(
            diagnostic(
              "claude.uninstall-failed",
              "Unable to remove Loom ownership file",
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
            if ((await safeRead(projectRoot, OWNERSHIP_PATH)) !== state.content)
              throw new Error("Ownership changed before uninstall");
            await writeFileAtomic(ownershipAbsolute, nextContent);
          } catch {
            changed.pop();
            skipped.push(ownershipAbsolute);
            diagnostics.push(
              diagnostic(
                "claude.uninstall-failed",
                "Unable to update Loom ownership file",
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

export {
  ClaudeHarnessAdapter as ClaudeAdapter,
  ClaudeHarnessAdapter as HarnessAdapter,
};
export default ClaudeHarnessAdapter;
