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
import {
  writeFileAtomic,
  type ApplyResult,
  type CapabilityPlan,
  type ConfigMutation,
  type ConfigMutationPlan,
  type Diagnostic,
  type HarnessAdapter,
  type HarnessState,
} from "@loom/core";

const BEGIN_MARKER = "# BEGIN LOOM MANAGED BLOCK: mcp_servers.loom";
const END_MARKER = "# END LOOM MANAGED BLOCK: mcp_servers.loom";
const CONFIG_PATH = ".codex/config.toml";
const OWNERSHIP_PATH = ".loom/ownership.json";
const SERVER_TABLE =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:loom|"loom"|'loom')\s*\]\s*(?:#.*)?$/m;

interface OwnedFile {
  path: string;
  sha256: string;
}

interface OwnedConfig {
  path: string;
  blockSha256: string;
  prefix: string;
  created: boolean;
}

interface CodexOwnership {
  files: OwnedFile[];
  config: OwnedConfig;
}

interface OwnershipManifest {
  version: 1;
  harnesses: Record<string, unknown> & { codex?: CodexOwnership };
}

export interface CodexAdapterOptions {
  command?: string;
  skillsSource?: string;
  fileOperations?: CodexFileOperations;
}

export interface CodexFileOperations {
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
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

function isSkillPath(path: unknown): path is string {
  if (!isNormalizedRelative(path)) return false;
  const parts = path.split("/");
  return (
    parts.length >= 4 &&
    parts[0] === ".agents" &&
    parts[1] === "skills" &&
    /^loom-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(parts[2] ?? "")
  );
}

function isMutationRelative(path: string): boolean {
  return path === OWNERSHIP_PATH || path === CONFIG_PATH || isSkillPath(path);
}

async function assertNoSymlink(root: string, path: string): Promise<void> {
  const pathFromRoot = relative(root, path);
  if (
    pathFromRoot === "" ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    resolve(path) !== path
  ) {
    throw new Error(`Path is outside the project root: ${path}`);
  }
  let current = root;
  const parts = pathFromRoot.split(sep);
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) current = resolve(current, parts[index]!);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Symlink path component is not allowed: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function safeReadOptional(
  root: string,
  relativePath: string,
): Promise<string | undefined> {
  const path = resolve(root, relativePath);
  await assertNoSymlink(root, path);
  return readOptional(path);
}

async function safeReadOptionalBytes(
  root: string,
  relativePath: string,
): Promise<Buffer | undefined> {
  const path = resolve(root, relativePath);
  await assertNoSymlink(root, path);
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
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

function allowedMutationRelative(
  root: string,
  path: unknown,
): string | undefined {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path)
    return undefined;
  const pathFromRoot = relative(root, path).split(sep).join("/");
  return isNormalizedRelative(pathFromRoot) && isMutationRelative(pathFromRoot)
    ? pathFromRoot
    : undefined;
}

function managedBlock(command: string): string {
  return `${BEGIN_MARKER}\n[mcp_servers.loom]\ncommand = ${JSON.stringify(command)}\nargs = ["mcp"]\nrequired = false\nstartup_timeout_sec = 10\ntool_timeout_sec = 60\n${END_MARKER}\n`;
}

function blockRange(
  content: string,
): { start: number; end: number; block: string } | undefined {
  const start = content.indexOf(BEGIN_MARKER);
  if (start < 0) return undefined;
  const markerEnd = content.indexOf(END_MARKER, start + BEGIN_MARKER.length);
  if (
    markerEnd < 0 ||
    content.indexOf(BEGIN_MARKER, start + BEGIN_MARKER.length) >= 0
  )
    return undefined;
  let end = markerEnd + END_MARKER.length;
  if (content[end] === "\r" && content[end + 1] === "\n") end += 2;
  else if (content[end] === "\n") end += 1;
  return { start, end, block: content.slice(start, end) };
}

function diagnostic(
  level: Diagnostic["level"],
  code: string,
  message: string,
  path?: string,
): Diagnostic {
  return path === undefined
    ? { level, code, message }
    : { level, code, message, path };
}

async function readProjectOptional(
  root: string,
  relativePath: string,
  diagnostics: Diagnostic[],
): Promise<string | undefined> {
  try {
    return await safeReadOptional(root, relativePath);
  } catch {
    diagnostics.push(
      diagnostic(
        "error",
        "codex.unsafe-path",
        "Path contains a symlink or escapes the project root",
        relativePath,
      ),
    );
    return undefined;
  }
}

async function collectSkillFiles(
  source: string,
): Promise<Array<{ source: string; relativePath: string; content: string }>> {
  const results: Array<{
    source: string;
    relativePath: string;
    content: string;
  }> = [];
  const skillDirectories = (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("loom-"))
    .sort((left, right) => left.name.localeCompare(right.name));

  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const sourcePath = resolve(directory, entry.name);
      const targetPath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(sourcePath, targetPath);
      else if (entry.isFile())
        results.push({
          source: sourcePath,
          relativePath: targetPath,
          content: await readFile(sourcePath, "utf8"),
        });
      else throw new Error(`Unsupported skill entry: ${sourcePath}`);
    }
  }

  for (const directory of skillDirectories) {
    await walk(
      resolve(source, directory.name),
      `.agents/skills/${directory.name}`,
    );
  }
  return results;
}

function parseOwnership(content: string | undefined): OwnershipManifest {
  if (content === undefined) return { version: 1, harnesses: {} };
  const value = JSON.parse(content) as Partial<OwnershipManifest>;
  if (
    value.version !== 1 ||
    !value.harnesses ||
    typeof value.harnesses !== "object" ||
    Array.isArray(value.harnesses)
  ) {
    throw new Error("Unsupported Loom ownership manifest");
  }
  const codex = value.harnesses.codex;
  if (codex !== undefined) {
    if (!codex || typeof codex !== "object")
      throw new Error("Invalid Codex ownership manifest");
    const candidate = codex as Partial<CodexOwnership>;
    if (
      !Array.isArray(candidate.files) ||
      !candidate.files.every(
        (file) =>
          file !== null &&
          typeof file === "object" &&
          isSkillPath((file as Partial<OwnedFile>).path) &&
          typeof (file as Partial<OwnedFile>).sha256 === "string",
      ) ||
      !candidate.config ||
      typeof candidate.config !== "object" ||
      candidate.config.path !== CONFIG_PATH ||
      typeof candidate.config.blockSha256 !== "string" ||
      typeof candidate.config.prefix !== "string" ||
      typeof candidate.config.created !== "boolean"
    ) {
      throw new Error("Invalid Codex ownership manifest");
    }
  }
  return value as OwnershipManifest;
}

function ownedFileMap(ownership: OwnershipManifest): Map<string, OwnedFile> {
  return new Map(
    (ownership.harnesses.codex?.files ?? []).map((file) => [file.path, file]),
  );
}

function otherHarnessOwnsFile(
  ownership: OwnershipManifest,
  harness: string,
  path: string,
  hash: string,
): boolean {
  return Object.entries(ownership.harnesses).some(([id, value]) => {
    if (id === harness || !value || typeof value !== "object") return false;
    const files = (value as { files?: unknown }).files;
    if (Array.isArray(files)) {
      return files.some(
        (file) =>
          file !== null &&
          typeof file === "object" &&
          (file as { path?: unknown }).path === path &&
          (file as { sha256?: unknown }).sha256 === hash,
      );
    }
    return (
      files !== null &&
      typeof files === "object" &&
      (files as Record<string, unknown>)[path] === hash
    );
  });
}

export class CodexHarnessAdapter implements HarnessAdapter {
  readonly id = "codex";
  readonly #command: string;
  readonly #skillsSource: string;
  readonly #fileOperations: CodexFileOperations;
  readonly #issuedPlans = new WeakSet<ConfigMutationPlan>();

  constructor(options: CodexAdapterOptions = {}) {
    this.#command = options.command ?? "loom";
    this.#skillsSource = resolve(
      options.skillsSource ??
        fileURLToPath(new URL("../../../packages/skills", import.meta.url)),
    );
    this.#fileOperations =
      options.fileOperations ??
      ({ write: writeFileAtomic, remove: rm } satisfies CodexFileOperations);
  }

  async inspect(root: string): Promise<HarnessState> {
    const projectRoot = resolve(root);
    const configPath = resolve(projectRoot, CONFIG_PATH);
    const ownershipPath = resolve(projectRoot, OWNERSHIP_PATH);
    const diagnostics: Diagnostic[] = [];
    const config = await readProjectOptional(
      projectRoot,
      CONFIG_PATH,
      diagnostics,
    );
    const ownershipContent = await readProjectOptional(
      projectRoot,
      OWNERSHIP_PATH,
      diagnostics,
    );
    let installed = false;
    try {
      const ownership = parseOwnership(ownershipContent);
      installed = ownership.harnesses.codex !== undefined;
      if (
        config !== undefined &&
        SERVER_TABLE.test(config) &&
        blockRange(config) === undefined
      ) {
        diagnostics.push(
          diagnostic(
            "error",
            "codex.mcp-collision",
            "mcp_servers.loom already exists outside Loom's marker block",
            configPath,
          ),
        );
      }
    } catch (error) {
      diagnostics.push(
        diagnostic(
          "error",
          "codex.ownership-invalid",
          (error as Error).message,
          ownershipPath,
        ),
      );
    }
    return { id: this.id, installed, configPaths: [configPath], diagnostics };
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
    _plan: CapabilityPlan,
  ): Promise<ConfigMutationPlan> {
    const projectRoot = resolve(root);
    const configPath = resolve(projectRoot, CONFIG_PATH);
    const ownershipPath = resolve(projectRoot, OWNERSHIP_PATH);
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
      return this.#issuePlan({
        harness: this.id,
        root: projectRoot,
        mutations,
        diagnostics: [
          diagnostic(
            "error",
            "codex.ownership-invalid",
            (error as Error).message,
            ownershipPath,
          ),
        ],
      });
    }

    const previousFiles = ownedFileMap(ownership);
    const nextFiles: OwnedFile[] = [];
    for (const skill of await collectSkillFiles(this.#skillsSource)) {
      const target = resolve(projectRoot, skill.relativePath);
      const existing = await readProjectOptional(
        projectRoot,
        skill.relativePath,
        diagnostics,
      );
      const previous = previousFiles.get(skill.relativePath);
      const sourceHash = sha256(skill.content);
      nextFiles.push({ path: skill.relativePath, sha256: sourceHash });
      if (existing !== undefined) {
        const existingHash = sha256(existing);
        const sharedOwner = otherHarnessOwnsFile(
          ownership,
          this.id,
          skill.relativePath,
          existingHash,
        );
        if (previous !== undefined && existingHash !== previous.sha256) {
          diagnostics.push(
            diagnostic(
              "error",
              "codex.owned-file-modified",
              "Refusing to overwrite a modified owned skill file",
              target,
            ),
          );
          continue;
        }
        if (
          previous === undefined &&
          !otherHarnessOwnsFile(
            ownership,
            this.id,
            skill.relativePath,
            existingHash,
          )
        ) {
          diagnostics.push(
            diagnostic(
              "error",
              "codex.skill-collision",
              "Skill file already exists and is not owned by Loom",
              target,
            ),
          );
          continue;
        }
        if (existing !== skill.content && sharedOwner) {
          diagnostics.push(
            diagnostic(
              "error",
              "codex.shared-version-collision",
              "A different harness owns the current shared file version",
              target,
            ),
          );
          continue;
        }
      }
      if (existing === skill.content) {
        continue;
      }
      const mutation: ConfigMutation = {
        kind: existing === undefined ? "create-file" : "update-file",
        path: target,
        description: `Install ${skill.relativePath}`,
        content: skill.content,
      };
      if (existing !== undefined) mutation.expectedHash = sha256(existing);
      mutations.push(mutation);
    }
    const desiredPaths = new Set(nextFiles.map((file) => file.path));
    for (const previous of previousFiles.values()) {
      if (desiredPaths.has(previous.path)) continue;
      const existing = await readProjectOptional(
        projectRoot,
        previous.path,
        diagnostics,
      );
      if (existing === undefined) continue;
      if (sha256(existing) !== previous.sha256) {
        diagnostics.push(
          diagnostic(
            "error",
            "codex.owned-file-modified",
            "Refusing to remove a modified obsolete skill file",
            previous.path,
          ),
        );
      } else if (
        !otherHarnessOwnsFile(
          ownership,
          this.id,
          previous.path,
          previous.sha256,
        )
      ) {
        mutations.push({
          kind: "delete-file",
          path: resolve(projectRoot, previous.path),
          description: `Remove obsolete ${previous.path}`,
          expectedHash: previous.sha256,
        });
      }
    }

    const desiredBlock = managedBlock(this.#command);
    const config = await readProjectOptional(
      projectRoot,
      CONFIG_PATH,
      diagnostics,
    );
    const range = config === undefined ? undefined : blockRange(config);
    if (
      config !== undefined &&
      SERVER_TABLE.test(config) &&
      range === undefined
    ) {
      diagnostics.push(
        diagnostic(
          "error",
          "codex.mcp-collision",
          "mcp_servers.loom already exists outside Loom's marker block",
          configPath,
        ),
      );
    } else if (range !== undefined && ownership.harnesses.codex === undefined) {
      diagnostics.push(
        diagnostic(
          "error",
          "codex.mcp-collision",
          "Loom marker block exists without an ownership record",
          configPath,
        ),
      );
    } else if (
      range !== undefined &&
      ownership.harnesses.codex !== undefined &&
      sha256(range.block) !== ownership.harnesses.codex.config.blockSha256
    ) {
      diagnostics.push(
        diagnostic(
          "error",
          "codex.config-modified",
          "Refusing to overwrite a modified owned Codex MCP block",
          configPath,
        ),
      );
    } else {
      const prefix =
        range === undefined
          ? config?.endsWith("\n")
            ? "\n"
            : config === undefined || config.length === 0
              ? ""
              : "\n\n"
          : (ownership.harnesses.codex?.config.prefix ?? "");
      const nextConfig =
        config === undefined
          ? desiredBlock
          : range === undefined
            ? `${config}${prefix}${desiredBlock}`
            : `${config.slice(0, range.start)}${desiredBlock}${config.slice(range.end)}`;
      if (config !== nextConfig) {
        const mutation: ConfigMutation = {
          kind: config === undefined ? "create-file" : "update-file",
          path: configPath,
          description: "Configure the Loom MCP server for Codex",
          content: nextConfig,
        };
        if (config !== undefined) mutation.expectedHash = sha256(config);
        mutations.push(mutation);
      }
      ownership.harnesses.codex = {
        files: nextFiles,
        config: {
          path: CONFIG_PATH,
          blockSha256: sha256(desiredBlock),
          prefix,
          created:
            range === undefined
              ? config === undefined
              : (ownership.harnesses.codex?.config.created ?? false),
        },
      };
    }

    if (!diagnostics.some((item) => item.level === "error")) {
      const nextOwnership = `${JSON.stringify(ownership, null, 2)}\n`;
      if (ownershipContent !== nextOwnership) {
        const mutation: ConfigMutation = {
          kind: ownershipContent === undefined ? "create-file" : "update-file",
          path: ownershipPath,
          description: "Record Codex integration ownership",
          content: nextOwnership,
        };
        if (ownershipContent !== undefined)
          mutation.expectedHash = sha256(ownershipContent);
        mutations.push(mutation);
      }
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
            "error",
            "codex.invalid-mutation",
            "Plan was not issued by this Codex adapter instance",
          ),
        ],
      };
    }
    const root = resolve(plan.root);
    const diagnostics = [...plan.diagnostics];
    if (!isAbsolute(plan.root) || root !== plan.root) {
      diagnostics.push(
        diagnostic(
          "error",
          "codex.invalid-plan-root",
          "Plan root must be a normalized absolute path",
        ),
      );
    }
    if (plan.harness !== this.id) {
      diagnostics.push(
        diagnostic(
          "error",
          "codex.wrong-plan",
          `Cannot apply a ${plan.harness} plan`,
        ),
      );
    }
    const errors = diagnostics.filter((item) => item.level === "error");
    if (errors.length > 0)
      return {
        changed: [],
        skipped: plan.mutations.map((item) => item.path),
        diagnostics,
      };

    const conflicts: Diagnostic[] = [];
    const valid: Array<{
      mutation: ConfigMutation;
      relativePath: string;
      previous: string | undefined;
      previousBytes: Buffer | undefined;
    }> = [];
    for (const mutation of plan.mutations) {
      const relativePath = allowedMutationRelative(root, mutation.path);
      const kind: unknown = mutation.kind;
      if (
        relativePath === undefined ||
        (kind !== "create-file" &&
          kind !== "update-file" &&
          kind !== "delete-file") ||
        ((kind === "update-file" || kind === "delete-file") &&
          typeof mutation.expectedHash !== "string") ||
        ((kind === "create-file" || kind === "update-file") &&
          typeof mutation.content !== "string")
      ) {
        conflicts.push(
          diagnostic(
            "error",
            "codex.invalid-mutation",
            "Mutation path, kind, content, or expected hash is not allowed",
            mutation.path,
          ),
        );
        continue;
      }
      let existing: string | undefined;
      let existingBytes: Buffer | undefined;
      try {
        existingBytes = await safeReadOptionalBytes(root, relativePath);
        existing = existingBytes?.toString("utf8");
      } catch {
        conflicts.push(
          diagnostic(
            "error",
            "codex.unsafe-path",
            "Mutation path contains a symlink",
            mutation.path,
          ),
        );
        continue;
      }
      if (mutation.kind === "create-file" && existing !== undefined) {
        conflicts.push(
          diagnostic(
            "error",
            "codex.concurrent-change",
            "Refusing to replace a file created after planning",
            mutation.path,
          ),
        );
      } else if (
        mutation.expectedHash !== undefined &&
        (existing === undefined || sha256(existing) !== mutation.expectedHash)
      ) {
        conflicts.push(
          diagnostic(
            "error",
            "codex.concurrent-change",
            "File changed after planning",
            mutation.path,
          ),
        );
      } else {
        valid.push({
          mutation,
          relativePath,
          previous: existing,
          previousBytes: existingBytes,
        });
      }
    }
    if (conflicts.length > 0)
      return {
        changed: [],
        skipped: plan.mutations.map((item) => item.path),
        diagnostics: [...diagnostics, ...conflicts],
      };
    const changed: string[] = [];
    const skipped: string[] = [];
    if (!dryRun) {
      const journal: typeof valid = [];
      for (const entry of valid) {
        const { mutation, relativePath } = entry;
        try {
          await assertNoSymlink(root, resolve(root, relativePath));
          if (
            !sameBytes(
              await safeReadOptionalBytes(root, relativePath),
              entry.previousBytes,
            )
          )
            throw new Error("File changed after preflight");
          if (mutation.kind === "delete-file")
            await this.#fileOperations.remove(mutation.path);
          else
            await this.#fileOperations.write(mutation.path, mutation.content!);
          journal.push(entry);
          changed.push(mutation.path);
        } catch (error) {
          const intended =
            mutation.kind === "delete-file" ? undefined : mutation.content;
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
            diagnostic(
              "error",
              "codex.apply-failed",
              `Apply failed at ${mutation.path}: ${error instanceof Error ? error.message : String(error)}; ${rollbackFailures.length === 0 ? "all earlier mutations were rolled back" : `rollback failed for ${rollbackFailures.join(", ")}`}`,
              mutation.path,
            ),
          );
          return {
            changed: [],
            skipped: valid.map(({ mutation: item }) => item.path),
            diagnostics,
          };
        }
      }
    }
    return {
      changed: dryRun ? valid.map(({ mutation }) => mutation.path) : changed,
      skipped,
      diagnostics,
    };
  }

  async verify(root: string): Promise<Diagnostic[]> {
    const projectRoot = resolve(root);
    const ownershipPath = resolve(projectRoot, OWNERSHIP_PATH);
    const diagnostics: Diagnostic[] = [];
    let ownership: OwnershipManifest;
    try {
      ownership = parseOwnership(
        await readProjectOptional(projectRoot, OWNERSHIP_PATH, diagnostics),
      );
    } catch (error) {
      return [
        diagnostic(
          "error",
          "codex.ownership-invalid",
          (error as Error).message,
          ownershipPath,
        ),
      ];
    }
    const codex = ownership.harnesses.codex;
    if (codex === undefined) {
      diagnostics.push(
        diagnostic(
          "error",
          "codex.not-installed",
          "Codex integration is not owned by Loom",
        ),
      );
      return diagnostics;
    }
    for (const file of codex.files) {
      const path = resolve(projectRoot, file.path);
      const content = await readProjectOptional(
        projectRoot,
        file.path,
        diagnostics,
      );
      if (content === undefined || sha256(content) !== file.sha256) {
        diagnostics.push(
          diagnostic(
            "error",
            "codex.owned-file-modified",
            "Owned skill file is missing or modified",
            path,
          ),
        );
      }
    }
    const configPath = resolve(projectRoot, codex.config.path);
    const config = await readProjectOptional(
      projectRoot,
      codex.config.path,
      diagnostics,
    );
    const range = config === undefined ? undefined : blockRange(config);
    if (
      range === undefined ||
      sha256(range.block) !== codex.config.blockSha256
    ) {
      diagnostics.push(
        diagnostic(
          "error",
          "codex.config-modified",
          "Owned Codex MCP block is missing or modified",
          configPath,
        ),
      );
    }
    return diagnostics;
  }

  async uninstallOwned(root: string, dryRun = false): Promise<ApplyResult> {
    const projectRoot = resolve(root);
    const ownershipPath = resolve(projectRoot, OWNERSHIP_PATH);
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
        skipped: [ownershipPath],
        diagnostics: [
          ...diagnostics,
          diagnostic(
            "error",
            "codex.ownership-invalid",
            (error as Error).message,
            ownershipPath,
          ),
        ],
      };
    }
    const codex = ownership.harnesses.codex;
    if (codex === undefined) return { changed: [], skipped: [], diagnostics };
    const uninstallPaths = [
      ...codex.files.map((file) => file.path),
      codex.config.path,
      OWNERSHIP_PATH,
    ];
    for (const relativePath of uninstallPaths) {
      try {
        await assertNoSymlink(projectRoot, resolve(projectRoot, relativePath));
      } catch {
        diagnostics.push(
          diagnostic(
            "error",
            "codex.unsafe-path",
            "Uninstall path contains a symlink",
            relativePath,
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
    const retainedFiles: OwnedFile[] = [];
    for (const file of codex.files) {
      const path = resolve(projectRoot, file.path);
      const content = await readProjectOptional(
        projectRoot,
        file.path,
        diagnostics,
      );
      if (content === undefined) continue;
      if (sha256(content) !== file.sha256) {
        retainedFiles.push(file);
        skipped.push(path);
        diagnostics.push(
          diagnostic(
            "error",
            "codex.owned-file-modified",
            "Refusing to remove a modified owned skill file",
            path,
          ),
        );
      } else {
        if (otherHarnessOwnsFile(ownership, this.id, file.path, file.sha256)) {
          skipped.push(path);
        } else {
          changed.push(path);
          if (!dryRun) {
            try {
              await assertNoSymlink(projectRoot, path);
              await rm(path);
            } catch {
              changed.pop();
              retainedFiles.push(file);
              skipped.push(path);
              diagnostics.push(
                diagnostic(
                  "error",
                  "codex.unsafe-path",
                  "Owned skill path contains a symlink",
                  path,
                ),
              );
            }
          }
        }
      }
    }

    const configPath = resolve(projectRoot, codex.config.path);
    const config = await readProjectOptional(
      projectRoot,
      codex.config.path,
      diagnostics,
    );
    const range = config === undefined ? undefined : blockRange(config);
    let retainConfig = false;
    if (retainedFiles.length > 0) {
      retainConfig = true;
      skipped.push(configPath);
      diagnostics.push(
        diagnostic(
          "warning",
          "codex.partial-uninstall",
          "Codex MCP config remains owned while modified skill files are retained",
          configPath,
        ),
      );
    } else if (
      config !== undefined &&
      range !== undefined &&
      sha256(range.block) === codex.config.blockSha256
    ) {
      let start = range.start;
      if (
        codex.config.prefix &&
        config.slice(Math.max(0, start - codex.config.prefix.length), start) ===
          codex.config.prefix
      ) {
        start -= codex.config.prefix.length;
      }
      const next = `${config.slice(0, start)}${config.slice(range.end)}`;
      changed.push(configPath);
      if (!dryRun) {
        try {
          await assertNoSymlink(projectRoot, configPath);
          if (next.length === 0 && codex.config.created) await rm(configPath);
          else await writeFileAtomic(configPath, next);
        } catch {
          changed.pop();
          retainConfig = true;
          skipped.push(configPath);
          diagnostics.push(
            diagnostic(
              "error",
              "codex.unsafe-path",
              "Codex config path contains a symlink",
              configPath,
            ),
          );
        }
      }
    } else if (config !== undefined) {
      retainConfig = true;
      skipped.push(configPath);
      diagnostics.push(
        diagnostic(
          "error",
          "codex.config-modified",
          "Refusing to remove a modified owned Codex MCP block",
          configPath,
        ),
      );
    }

    if (!dryRun) {
      if (retainedFiles.length > 0 || retainConfig) {
        ownership.harnesses.codex = {
          files: retainedFiles,
          config: codex.config,
        };
      } else {
        delete ownership.harnesses.codex;
      }
      if (Object.keys(ownership.harnesses).length === 0)
        try {
          await assertNoSymlink(projectRoot, ownershipPath);
          await rm(ownershipPath);
        } catch {
          skipped.push(ownershipPath);
          diagnostics.push(
            diagnostic(
              "error",
              "codex.unsafe-path",
              "Ownership path contains a symlink",
              ownershipPath,
            ),
          );
        }
      else {
        try {
          await assertNoSymlink(projectRoot, ownershipPath);
          await writeFileAtomic(
            ownershipPath,
            `${JSON.stringify(ownership, null, 2)}\n`,
          );
        } catch {
          skipped.push(ownershipPath);
          diagnostics.push(
            diagnostic(
              "error",
              "codex.unsafe-path",
              "Ownership path contains a symlink",
              ownershipPath,
            ),
          );
        }
      }
    }
    if (!skipped.includes(ownershipPath)) changed.push(ownershipPath);
    return { changed, skipped, diagnostics };
  }
}

export { CodexHarnessAdapter as CodexAdapter, BEGIN_MARKER, END_MARKER };
