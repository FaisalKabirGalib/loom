import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
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
  HarnessAdapter as HarnessAdapterContract,
  HarnessState,
} from "@loom/core";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

const CONFIG_PATH = ".omp/mcp.json";
const OWNERSHIP_PATH = ".loom/ownership.json";
const DEFAULT_COMMAND = "loom";
const DEFAULT_ARGS = ["mcp"] as const;
const HASH = /^[a-f0-9]{64}$/u;

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

export interface OmpHarnessAdapterOptions {
  command?: string;
  args?: readonly string[];
  skillsSource?: string;
  fileOperations?: OmpFileOperations;
}

export interface OmpFileOperations {
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
    parts[0] === ".omp" &&
    parts[1] === "skills" &&
    /^loom-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(parts[2] ?? "") &&
    parts[3] === "SKILL.md"
  );
}

function isMutationPath(path: string): boolean {
  return path === CONFIG_PATH || path === OWNERSHIP_PATH || isSkillPath(path);
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

async function assertNoSymlink(root: string, path: string): Promise<void> {
  const candidate = relative(root, path);
  if (
    candidate === "" ||
    candidate === ".." ||
    candidate.startsWith(`..${sep}`) ||
    resolve(path) !== path
  )
    throw new Error(`Path is outside the project root: ${path}`);
  let current = root;
  const parts = candidate.split(sep);
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) current = resolve(current, parts[index]!);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Symlink path component is not allowed: ${current}`);
    } catch (cause) {
      if (isRecord(cause) && cause.code === "ENOENT") return;
      throw cause;
    }
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
        "omp.unsafe-path",
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

function emptyOwnership(): Ownership {
  return { version: 1, harnesses: {} };
}

function validPointer(value: unknown): value is OwnedPointer {
  return (
    isRecord(value) &&
    value.path === CONFIG_PATH &&
    Object.prototype.hasOwnProperty.call(value, "value")
  );
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
        diagnostic(
          "omp.unsafe-path",
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
    const omp = value.harnesses.omp;
    if (omp !== undefined) {
      if (!isRecord(omp) || !isRecord(omp.files) || !isRecord(omp.pointers))
        throw new Error();
      for (const [path, hash] of Object.entries(omp.files)) {
        if (!isSkillPath(path) || typeof hash !== "string" || !HASH.test(hash))
          throw new Error();
      }
      const pointers = Object.entries(omp.pointers);
      if (
        pointers.some(
          ([key, pointer]) =>
            key !== "mcpServers.loom" || !validPointer(pointer),
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
          "omp.invalid-ownership",
          "Loom ownership file is invalid",
          OWNERSHIP_PATH,
        ),
      ],
    };
  }
}

function otherHarnessOwnsFile(
  ownership: Ownership,
  harness: string,
  path: string,
  hash: string,
): boolean {
  return Object.entries(ownership.harnesses).some(([id, value]) => {
    if (id === harness || !isRecord(value)) return false;
    const files = value.files;
    if (Array.isArray(files))
      return files.some(
        (file) => isRecord(file) && file.path === path && file.sha256 === hash,
      );
    return isRecord(files) && files[path] === hash;
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
      throw new Error(`Unsupported canonical skill: ${entry.name}`);
    const directory = resolve(source, entry.name);
    const directoryStat = await lstat(directory);
    const skill = resolve(directory, "SKILL.md");
    const stat = await lstat(skill);
    if (
      directoryStat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.isSymbolicLink()
    )
      throw new Error(`Unsupported canonical skill: ${skill}`);
    result[`.omp/skills/${entry.name}/SKILL.md`] = await readFile(
      skill,
      "utf8",
    );
  }
  return result;
}

function parseConfig(text: string): {
  value?: Record<string, unknown>;
  diagnostics: Diagnostic[];
} {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (errors.length > 0 || !isRecord(value))
    return {
      diagnostics: [
        diagnostic(
          "omp.invalid-config",
          "OMP MCP config is not a valid JSON object",
          CONFIG_PATH,
        ),
      ],
    };
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

export class OmpHarnessAdapter implements HarnessAdapterContract {
  readonly id = "omp";
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #skillsSource: string;
  readonly #fileOperations: OmpFileOperations;
  readonly #issuedPlans = new WeakSet<ConfigMutationPlan>();

  constructor(options: OmpHarnessAdapterOptions = {}) {
    this.#command = options.command ?? DEFAULT_COMMAND;
    this.#args = options.args ?? DEFAULT_ARGS;
    this.#skillsSource = resolve(
      options.skillsSource ??
        fileURLToPath(new URL("../../../packages/skills", import.meta.url)),
    );
    this.#fileOperations =
      options.fileOperations ??
      ({ write: writeFileAtomic, remove: unlink } satisfies OmpFileOperations);
  }

  async inspect(root: string): Promise<HarnessState> {
    const projectRoot = resolve(root);
    const state = await readOwnership(projectRoot);
    const config = await readProjectOptional(
      projectRoot,
      CONFIG_PATH,
      state.diagnostics,
    );
    return {
      id: this.id,
      installed: state.ownership.harnesses.omp !== undefined,
      configPaths:
        config === undefined ? [] : [resolve(projectRoot, CONFIG_PATH)],
      diagnostics: state.diagnostics,
    };
  }

  #issuePlan(plan: ConfigMutationPlan): ConfigMutationPlan {
    for (const item of plan.mutations) Object.freeze(item);
    for (const item of plan.diagnostics) Object.freeze(item);
    Object.freeze(plan.mutations);
    Object.freeze(plan.diagnostics);
    this.#issuedPlans.add(plan);
    return Object.freeze(plan);
  }

  async planInstall(
    root: string,
    plan: CapabilityPlan,
  ): Promise<ConfigMutationPlan> {
    void plan;
    const projectRoot = resolve(root);
    const diagnostics: Diagnostic[] = [];
    const mutations: ConfigMutation[] = [];
    const state = await readOwnership(projectRoot);
    diagnostics.push(...state.diagnostics);
    const previous = state.ownership.harnesses.omp;
    const ownedFiles = previous?.files ?? {};
    const ownedPointer = previous?.pointers["mcpServers.loom"];
    const desiredPointer = {
      type: "stdio",
      command: this.#command,
      args: [...this.#args],
    };

    const existingConfig = await readProjectOptional(
      projectRoot,
      CONFIG_PATH,
      diagnostics,
    );
    const configText = existingConfig ?? "{}\n";
    const parsed = parseConfig(configText);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.value !== undefined) {
      if (
        parsed.value.mcpServers !== undefined &&
        !isRecord(parsed.value.mcpServers)
      ) {
        diagnostics.push(
          diagnostic(
            "omp.mcp-collision",
            "OMP mcpServers config is not an object",
            CONFIG_PATH,
          ),
        );
      } else {
        const current = pointerValue(parsed.value);
        if (
          ownedPointer !== undefined &&
          !sameValue(current, ownedPointer.value)
        ) {
          diagnostics.push(
            diagnostic(
              "omp.modified-owned-pointer",
              "Owned mcpServers.loom config was modified; refusing to overwrite it",
              CONFIG_PATH,
            ),
          );
        } else if (ownedPointer === undefined && current !== undefined) {
          diagnostics.push(
            diagnostic(
              "omp.mcp-collision",
              "mcpServers.loom already exists and is not owned by Loom",
              CONFIG_PATH,
            ),
          );
        }
      }
    }

    let desiredFiles: Record<string, string> = {};
    try {
      desiredFiles = await collectSkills(this.#skillsSource);
    } catch {
      diagnostics.push(
        diagnostic(
          "omp.skills-source",
          "Unable to read the canonical Loom skills source",
          this.#skillsSource,
        ),
      );
    }

    for (const [path, content] of Object.entries(desiredFiles)) {
      const current = await readProjectOptional(projectRoot, path, diagnostics);
      const currentHash = current === undefined ? undefined : sha256(current);
      const ownedHash = ownedFiles[path];
      const shared =
        currentHash !== undefined &&
        otherHarnessOwnsFile(state.ownership, this.id, path, currentHash);
      if (
        ownedHash !== undefined &&
        (currentHash === undefined || currentHash !== ownedHash)
      ) {
        diagnostics.push(
          diagnostic(
            "omp.modified-owned-file",
            "Owned skill was modified; refusing to overwrite it",
            path,
          ),
        );
      } else if (ownedHash === undefined && current !== undefined && !shared) {
        diagnostics.push(
          diagnostic(
            "omp.file-collision",
            "Skill path already exists and is not owned by Loom",
            path,
          ),
        );
      }
      if (current !== undefined && current !== content && shared) {
        diagnostics.push(
          diagnostic(
            "omp.shared-version-collision",
            "A different harness owns the current shared skill version",
            path,
          ),
        );
      }
      if (current !== content)
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

    for (const [path, ownedHash] of Object.entries(ownedFiles)) {
      if (desiredFiles[path] !== undefined) continue;
      const current = await readProjectOptional(projectRoot, path, diagnostics);
      if (current !== undefined && sha256(current) !== ownedHash) {
        diagnostics.push(
          diagnostic(
            "omp.modified-owned-file",
            "Owned obsolete skill was modified; refusing to remove it",
            path,
          ),
        );
      } else if (
        current !== undefined &&
        !otherHarnessOwnsFile(state.ownership, this.id, path, ownedHash)
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

    if (parsed.value !== undefined) {
      const nextConfig = setPointer(configText, desiredPointer);
      if (nextConfig !== configText)
        mutations.push(
          mutation(
            existingConfig === undefined ? "create-file" : "update-file",
            resolve(projectRoot, CONFIG_PATH),
            "Configure the Loom MCP server for OMP",
            nextConfig,
            existingConfig === undefined ? undefined : sha256(existingConfig),
          ),
        );
    }

    if (diagnostics.some((item) => item.level === "error"))
      return this.#issuePlan({
        harness: this.id,
        root: projectRoot,
        mutations: [],
        diagnostics,
      });

    const ownership: Ownership = structuredClone(state.ownership);
    ownership.harnesses.omp = {
      files: Object.fromEntries(
        Object.entries(desiredFiles).map(([path, content]) => [
          path,
          sha256(content),
        ]),
      ),
      pointers: {
        "mcpServers.loom": { path: CONFIG_PATH, value: desiredPointer },
      },
    };
    const ownershipContent = `${JSON.stringify(ownership, null, 2)}\n`;
    if (ownershipContent !== state.content)
      mutations.push(
        mutation(
          state.content === undefined ? "create-file" : "update-file",
          resolve(projectRoot, OWNERSHIP_PATH),
          "Record Loom-owned OMP resources",
          ownershipContent,
          state.content === undefined ? undefined : sha256(state.content),
        ),
      );
    return this.#issuePlan({
      harness: this.id,
      root: projectRoot,
      mutations,
      diagnostics,
    });
  }

  async apply(plan: ConfigMutationPlan, dryRun = false): Promise<ApplyResult> {
    if (!this.#issuedPlans.has(plan))
      return {
        changed: [],
        skipped: [],
        diagnostics: [
          diagnostic(
            "omp.invalid-mutation",
            "Plan was not issued by this OMP adapter instance",
          ),
        ],
      };
    const root = resolve(plan.root);
    const diagnostics = [...plan.diagnostics];
    if (!isAbsolute(plan.root) || root !== plan.root)
      diagnostics.push(
        diagnostic(
          "omp.invalid-plan-root",
          "Plan root must be a normalized absolute path",
        ),
      );
    if (plan.harness !== this.id)
      diagnostics.push(
        diagnostic("omp.wrong-plan", `Cannot apply a ${plan.harness} plan`),
      );

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
          (typeof item.expectedHash !== "string" ||
            !HASH.test(item.expectedHash))) ||
        ((kind === "create-file" || kind === "update-file") &&
          typeof item.content !== "string")
      ) {
        diagnostics.push(
          diagnostic(
            "omp.invalid-mutation",
            "Mutation path, kind, content, or expected hash is not allowed",
            item.path,
          ),
        );
        skipped.push(item.path);
        continue;
      }
      let currentBytes: Buffer | undefined;
      try {
        currentBytes = await safeReadOptionalBytes(root, relativePath);
      } catch {
        diagnostics.push(
          diagnostic(
            "omp.unsafe-path",
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
          (current === undefined || sha256(current) !== item.expectedHash))
      ) {
        diagnostics.push(
          diagnostic(
            "omp.concurrent-change",
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
    if (diagnostics.some((item) => item.level === "error"))
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

    if (dryRun)
      return {
        changed: pending.map(({ mutation: item }) => item.path),
        skipped,
        diagnostics,
      };

    const journal: typeof pending = [];
    const changed: string[] = [];
    for (const entry of pending) {
      const item = entry.mutation;
      try {
        await assertNoSymlink(root, resolve(root, entry.relativePath));
        if (
          !sameBytes(
            await safeReadOptionalBytes(root, entry.relativePath),
            entry.previousBytes,
          )
        )
          throw new Error("File changed after preflight");
        if (item.kind === "delete-file")
          await this.#fileOperations.remove(item.path);
        else await this.#fileOperations.write(item.path, item.content ?? "");
        journal.push(entry);
        changed.push(item.path);
      } catch (cause) {
        const intended = item.kind === "delete-file" ? undefined : item.content;
        try {
          if ((await safeReadOptional(root, entry.relativePath)) === intended)
            journal.push(entry);
        } catch {}
        const rollbackFailures: string[] = [];
        for (const applied of journal.reverse()) {
          try {
            await assertNoSymlink(root, resolve(root, applied.relativePath));
            const expected =
              applied.mutation.kind === "delete-file"
                ? undefined
                : Buffer.from(applied.mutation.content ?? "");
            if (
              !sameBytes(
                await safeReadOptionalBytes(root, applied.relativePath),
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
            "omp.apply-failed",
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
    const owned = state.ownership.harnesses.omp;
    if (owned === undefined) {
      diagnostics.push(
        diagnostic("omp.not-installed", "OMP integration is not owned by Loom"),
      );
      return diagnostics;
    }
    for (const [path, hash] of Object.entries(owned.files)) {
      const content = await readProjectOptional(projectRoot, path, diagnostics);
      if (content === undefined || sha256(content) !== hash)
        diagnostics.push(
          diagnostic(
            "omp.modified-owned-file",
            "Owned skill is missing or modified",
            path,
          ),
        );
    }
    const pointer = owned.pointers["mcpServers.loom"];
    const config = await readProjectOptional(
      projectRoot,
      CONFIG_PATH,
      diagnostics,
    );
    if (pointer === undefined) {
      diagnostics.push(
        diagnostic(
          "omp.missing-pointer",
          "Ownership record is missing mcpServers.loom",
        ),
      );
    } else if (config === undefined) {
      diagnostics.push(
        diagnostic(
          "omp.missing-config",
          "Owned OMP MCP config is missing",
          CONFIG_PATH,
        ),
      );
    } else {
      const parsed = parseConfig(config);
      diagnostics.push(...parsed.diagnostics);
      if (
        parsed.value !== undefined &&
        !sameValue(pointerValue(parsed.value), pointer.value)
      )
        diagnostics.push(
          diagnostic(
            "omp.modified-owned-pointer",
            "Owned mcpServers.loom config was modified",
            CONFIG_PATH,
          ),
        );
    }
    return diagnostics;
  }

  async uninstallOwned(root: string, dryRun = false): Promise<ApplyResult> {
    const projectRoot = resolve(root);
    const state = await readOwnership(projectRoot);
    const diagnostics = [...state.diagnostics];
    const owned = state.ownership.harnesses.omp;
    if (
      owned === undefined ||
      diagnostics.some((item) => item.level === "error")
    )
      return { changed: [], skipped: [], diagnostics };

    const paths = [
      ...Object.keys(owned.files),
      ...(owned.pointers["mcpServers.loom"] === undefined ? [] : [CONFIG_PATH]),
      OWNERSHIP_PATH,
    ];
    for (const path of paths) {
      try {
        await assertNoSymlink(projectRoot, resolve(projectRoot, path));
      } catch {
        diagnostics.push(
          diagnostic(
            "omp.unsafe-path",
            "Uninstall path contains a symlink",
            path,
          ),
        );
      }
    }
    if (diagnostics.some((item) => item.level === "error"))
      return {
        changed: [],
        skipped: paths.map((path) => resolve(projectRoot, path)),
        diagnostics,
      };

    const changed: string[] = [];
    const skipped: string[] = [];
    const retainedFiles: Record<string, string> = {};
    for (const [path, hash] of Object.entries(owned.files)) {
      const absolute = resolve(projectRoot, path);
      const content = await readProjectOptional(projectRoot, path, diagnostics);
      if (content === undefined) {
        skipped.push(absolute);
      } else if (sha256(content) !== hash) {
        retainedFiles[path] = hash;
        skipped.push(absolute);
        diagnostics.push(
          diagnostic(
            "omp.modified-owned-file",
            "Owned skill was modified; refusing to remove it",
            path,
          ),
        );
      } else if (otherHarnessOwnsFile(state.ownership, this.id, path, hash)) {
        skipped.push(absolute);
      } else {
        changed.push(absolute);
        if (!dryRun) {
          try {
            await assertNoSymlink(projectRoot, absolute);
            if ((await safeReadOptional(projectRoot, path)) !== content)
              throw new Error();
            await unlink(absolute);
          } catch {
            changed.pop();
            skipped.push(absolute);
            retainedFiles[path] = hash;
            diagnostics.push(
              diagnostic(
                "omp.concurrent-change",
                "Owned skill changed during uninstall",
                path,
              ),
            );
          }
        }
      }
    }

    const retainedPointers: Record<string, OwnedPointer> = {};
    const pointer = owned.pointers["mcpServers.loom"];
    if (pointer !== undefined) {
      const configAbsolute = resolve(projectRoot, CONFIG_PATH);
      const config = await readProjectOptional(
        projectRoot,
        CONFIG_PATH,
        diagnostics,
      );
      if (config === undefined) {
        skipped.push(configAbsolute);
      } else {
        const parsed = parseConfig(config);
        diagnostics.push(...parsed.diagnostics);
        if (
          parsed.value === undefined ||
          !sameValue(pointerValue(parsed.value), pointer.value)
        ) {
          retainedPointers["mcpServers.loom"] = pointer;
          skipped.push(configAbsolute);
          diagnostics.push(
            diagnostic(
              "omp.modified-owned-pointer",
              "Owned mcpServers.loom config was modified; refusing to remove it",
              CONFIG_PATH,
            ),
          );
        } else {
          const next = setPointer(config, undefined);
          if (next !== config) {
            changed.push(configAbsolute);
            if (!dryRun) {
              try {
                await assertNoSymlink(projectRoot, configAbsolute);
                if (
                  (await safeReadOptional(projectRoot, CONFIG_PATH)) !== config
                )
                  throw new Error();
                await writeFileAtomic(configAbsolute, next);
              } catch {
                changed.pop();
                skipped.push(configAbsolute);
                retainedPointers["mcpServers.loom"] = pointer;
                diagnostics.push(
                  diagnostic(
                    "omp.concurrent-change",
                    "OMP MCP config changed during uninstall",
                    CONFIG_PATH,
                  ),
                );
              }
            }
          }
        }
      }
    }

    const ownership: Ownership = structuredClone(state.ownership);
    if (
      Object.keys(retainedFiles).length > 0 ||
      Object.keys(retainedPointers).length > 0
    )
      ownership.harnesses.omp = {
        files: retainedFiles,
        pointers: retainedPointers,
      };
    else delete ownership.harnesses.omp;

    const ownershipAbsolute = resolve(projectRoot, OWNERSHIP_PATH);
    changed.push(ownershipAbsolute);
    if (!dryRun) {
      try {
        await assertNoSymlink(projectRoot, ownershipAbsolute);
        if (
          (await safeReadOptional(projectRoot, OWNERSHIP_PATH)) !==
          state.content
        )
          throw new Error();
        if (Object.keys(ownership.harnesses).length === 0)
          await rm(ownershipAbsolute);
        else
          await writeFileAtomic(
            ownershipAbsolute,
            `${JSON.stringify(ownership, null, 2)}\n`,
          );
      } catch {
        changed.pop();
        skipped.push(ownershipAbsolute);
        diagnostics.push(
          diagnostic(
            "omp.concurrent-change",
            "Ownership file changed during uninstall",
            OWNERSHIP_PATH,
          ),
        );
      }
    }
    return {
      changed: [...new Set(changed)],
      skipped: [...new Set(skipped)],
      diagnostics,
    };
  }
}

export { OmpHarnessAdapter as HarnessAdapter };
export default OmpHarnessAdapter;
