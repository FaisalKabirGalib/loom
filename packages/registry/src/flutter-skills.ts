import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  sha256,
  type CapabilityCandidate,
  type ProjectProfile,
  type TaskProfile,
} from "@loom/core";

import { SkillsCliRegistry } from "./skills-cli.js";
import {
  GitHubSkillResolver,
  type RegistrySkillResolver,
} from "./github-skill.js";

export interface FlutterSkillCandidate {
  id: string;
  name: string;
  description: string;
  source: "hosted-package" | "skills-registry";
  package?: string;
  packageVersion?: string;
  packageContentHash?: string;
  archiveHash?: string;
  repository?: string;
  commit?: string;
  path: string;
  contentHash?: string;
  metrics?: CapabilityCandidate["metrics"];
  provenance: Record<string, unknown>;
}

export function flutterSkillBindingHash(
  candidate: FlutterSkillCandidate,
): string {
  return sha256(
    canonicalJson(
      candidate.source === "hosted-package"
        ? {
            source: candidate.source,
            id: candidate.id,
            package: candidate.package,
            version: candidate.packageVersion,
            packageContentHash: candidate.packageContentHash,
            archiveHash: candidate.archiveHash,
            path: candidate.path,
            contentHash: candidate.contentHash,
          }
        : {
            source: candidate.source,
            id: candidate.id,
            repository: candidate.repository,
            commit: candidate.commit,
            path: candidate.path,
            contentHash: candidate.contentHash,
          },
    ),
  );
}

const digest = (value: string | Uint8Array): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const safeName = (value: string): boolean =>
  /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value);

function skillDescription(content: string): string {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)?.[1] ?? "";
  const lines = block.split(/\r?\n/u);
  const index = lines.findIndex((line) => /^description\s*:/u.test(line));
  if (index < 0) return "Package-provided Agent Skill";
  const inline = lines[index]!.replace(/^description\s*:\s*/u, "").trim();
  if (inline && inline !== ">" && inline !== "|")
    return inline.replace(/^['"]|['"]$/gu, "");
  const values: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (!/^\s+/u.test(line)) break;
    values.push(line.trim());
  }
  return values.join(" ") || "Package-provided Agent Skill";
}

function lockedHostedPackages(
  content: string,
): Map<string, { version: string; hash: string }> {
  const packages = new Map<string, { version: string; hash: string }>();
  let name: string | undefined;
  let hosted = false;
  let hash: string | undefined;
  for (const line of content.split(/\r?\n/u)) {
    const packageMatch = /^  ([A-Za-z0-9_]+):\s*$/u.exec(line);
    if (packageMatch) {
      name = packageMatch[1];
      hosted = false;
      hash = undefined;
      continue;
    }
    if (!name) continue;
    if (/^    source: hosted\s*$/u.test(line)) hosted = true;
    const hashMatch = /^      sha256: ["']?([a-f0-9]{64})["']?\s*$/u.exec(line);
    if (hashMatch) hash = hashMatch[1];
    const versionMatch = /^    version: ["']([^"']+)["']\s*$/u.exec(line);
    if (versionMatch && hosted && hash)
      packages.set(name, { version: versionMatch[1]!, hash: `sha256:${hash}` });
    if (packages.size >= 512) break;
  }
  return packages;
}

async function packageRoots(root: string): Promise<Map<string, string>> {
  const configPath = join(root, ".dart_tool/package_config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    packages?: Array<{ name?: unknown; rootUri?: unknown }>;
  };
  const result = new Map<string, string>();
  for (const item of (config.packages ?? []).slice(0, 1_024)) {
    if (typeof item.name !== "string" || typeof item.rootUri !== "string")
      continue;
    const path = await realpath(
      fileURLToPath(new URL(item.rootUri, `file://${dirname(configPath)}/`)),
    );
    result.set(item.name, path);
  }
  return result;
}

async function packageSkills(root: string): Promise<FlutterSkillCandidate[]> {
  const lock = lockedHostedPackages(
    await readFile(join(root, "pubspec.lock"), "utf8"),
  );
  const roots = await packageRoots(root);
  const candidates: FlutterSkillCandidate[] = [];
  for (const [packageName, pinned] of [...lock].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (candidates.length >= 128) break;
    const packageRoot = roots.get(packageName);
    if (!packageRoot) continue;
    const skillsRoot = join(packageRoot, "skills");
    let entries;
    try {
      entries = await readdir(skillsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, 128)) {
      const normalizedPackage = packageName.replaceAll("_", "-");
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !safeName(entry.name) ||
        !(
          entry.name.startsWith(`${packageName}-`) ||
          entry.name.startsWith(`${normalizedPackage}-`)
        )
      )
        continue;
      const skillRoot = join(skillsRoot, entry.name);
      const skillFile = join(skillRoot, "SKILL.md");
      const state = await lstat(skillFile).catch(() => undefined);
      if (!state?.isFile() || state.isSymbolicLink()) continue;
      const content = await readFile(skillFile, "utf8");
      const hashes: string[] = [];
      const visit = async (directory: string, prefix = ""): Promise<void> => {
        for (const child of (
          await readdir(directory, { withFileTypes: true })
        ).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
          if (
            child.isSymbolicLink() ||
            (!child.isDirectory() && !child.isFile())
          )
            throw new Error("Unsupported skill entry");
          const childPath = join(directory, child.name);
          const childRelative = prefix ? `${prefix}/${child.name}` : child.name;
          if (child.isDirectory()) await visit(childPath, childRelative);
          else
            hashes.push(
              `${childRelative}\0${digest(await readFile(childPath))}`,
            );
        }
      };
      await visit(skillRoot);
      candidates.push({
        id: `pub:${packageName}@${pinned.version}/${entry.name}`,
        name: entry.name,
        description: skillDescription(content),
        source: "hosted-package",
        package: packageName,
        packageVersion: pinned.version,
        packageContentHash: pinned.hash,
        archiveHash: pinned.hash,
        path: `skills/${entry.name}`,
        contentHash: digest(hashes.join("\n")),
        provenance: { registry: "pub.dev", hosted: true, locked: true },
      });
    }
  }
  return candidates;
}

export async function discoverFlutterSkills(
  root: string,
  project: ProjectProfile,
  task: TaskProfile,
  registry: SkillsCliRegistry = new SkillsCliRegistry(),
  resolver: RegistrySkillResolver = new GitHubSkillResolver(),
): Promise<{
  candidates: FlutterSkillCandidate[];
  terms: string[];
  warnings: string[];
}> {
  const terms = [
    ...new Set(
      [
        ...Object.keys(project.dependencies),
        ...Object.keys(project.devDependencies),
        ...task.intents,
        ...(task.summary?.split(/\s+/u) ?? []),
      ]
        .map((term) => term.trim().toLowerCase())
        .filter((term) => term.length > 2),
    ),
  ].slice(0, 12);
  const warnings: string[] = [];
  const packageCandidates = await packageSkills(root).catch((cause) => {
    warnings.push(
      `package skills: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return [];
  });
  const searchResults = await Promise.all(
    terms.map((term) =>
      registry.search({ text: term, limit: 10 }).catch((cause) => {
        warnings.push(
          `skills-cli: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        return [];
      }),
    ),
  );
  const discoveredRegistryCandidates: CapabilityCandidate[] = [];
  for (let index = 0; index < 10; index += 1)
    for (const results of searchResults) {
      const candidate = results[index];
      if (candidate !== undefined) discoveredRegistryCandidates.push(candidate);
    }
  const uniqueRegistryCandidates = [
    ...new Map(
      discoveredRegistryCandidates.map((item) => [item.id, item]),
    ).values(),
  ].slice(0, 8);
  const resolvedRegistryCandidates = await Promise.all(
    uniqueRegistryCandidates.map(async (candidate) => {
      try {
        const pinned = await resolver.resolve(candidate);
        return {
          id: candidate.id,
          name: candidate.name,
          description: pinned.description,
          source: "skills-registry",
          repository: pinned.repository,
          commit: pinned.commit,
          path: pinned.path,
          contentHash: pinned.contentHash,
          ...(candidate.metrics === undefined
            ? {}
            : { metrics: candidate.metrics }),
          provenance: {
            ...candidate.provenance,
            immutable: true,
            resolvedBy: "github-api",
          },
        } satisfies FlutterSkillCandidate;
      } catch (cause) {
        warnings.push(
          `${candidate.id}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        return undefined;
      }
    }),
  );
  const registryCandidates: FlutterSkillCandidate[] = [];
  for (const candidate of resolvedRegistryCandidates)
    if (candidate !== undefined) registryCandidates.push(candidate);
  return {
    candidates: [
      ...new Map(
        [...packageCandidates, ...registryCandidates].map((item) => [
          item.id,
          item,
        ]),
      ).values(),
    ].sort((a, b) => a.id.localeCompare(b.id)),
    terms,
    warnings,
  };
}

export function isInside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`));
}
