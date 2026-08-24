import { createHash } from "node:crypto";

import type { CapabilityCandidate } from "@loom/core";

import { readJsonResponse } from "./http.js";

export interface ResolvedRegistrySkill {
  repository: string;
  commit: string;
  path: string;
  contentHash: string;
  description: string;
}

export interface RegistrySkillResolver {
  resolve(candidate: CapabilityCandidate): Promise<ResolvedRegistrySkill>;
}

export interface GitHubSkillResolverOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  requestTimeoutMs?: number;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

const digest = (value: string | Uint8Array): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export class GitHubSkillResolver implements RegistrySkillResolver {
  readonly #fetch: typeof fetch;
  readonly #baseUrl: URL;
  readonly #requestTimeoutMs: number;

  public constructor(options: GitHubSkillResolverOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#baseUrl = new URL(options.baseUrl ?? "https://api.github.com");
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  public async resolve(
    candidate: CapabilityCandidate,
  ): Promise<ResolvedRegistrySkill> {
    const repository = candidate.source.repository;
    const match =
      repository === undefined
        ? null
        : /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(
            repository,
          );
    if (match === null) throw new Error("Registry skill is not from GitHub");
    const owner = match[1]!;
    const repo = match[2]!;
    const commitValue = await this.#json(
      `/repos/${owner}/${repo}/commits/HEAD`,
    );
    const commit = isRecord(commitValue) ? commitValue["sha"] : undefined;
    if (typeof commit !== "string" || !/^[a-f0-9]{40}$/u.test(commit))
      throw new Error("GitHub returned an invalid commit");
    const treeValue = await this.#json(
      `/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`,
    );
    if (!isRecord(treeValue) || treeValue["truncated"] === true)
      throw new Error("GitHub skill tree is unavailable or truncated");
    const rawTree = treeValue["tree"];
    if (!Array.isArray(rawTree))
      throw new Error("GitHub returned an invalid tree");
    const tree = rawTree.map(parseTreeEntry);
    const suffix = `/${candidate.name}/SKILL.md`;
    const skillFiles = tree.filter(
      ({ path, type }) =>
        type === "blob" &&
        (path === `${candidate.name}/SKILL.md` || path.endsWith(suffix)),
    );
    if (skillFiles.length !== 1)
      throw new Error(`Expected one immutable path for ${candidate.name}`);
    const skillPath = skillFiles[0]!.path.slice(0, -"/SKILL.md".length);
    const entries = tree
      .filter(({ path }) => path.startsWith(`${skillPath}/`))
      .sort((left, right) => compare(left.path, right.path));
    if (
      entries.length === 0 ||
      entries.length > 100 ||
      entries.some(
        ({ mode, type }) =>
          mode === "120000" || (type !== "blob" && type !== "tree"),
      )
    )
      throw new Error("GitHub skill contains unsupported entries");
    const files = entries.filter(({ type }) => type === "blob");
    let totalBytes = 0;
    let skillContent = "";
    const hashes: string[] = [];
    for (const file of files) {
      const value = await this.#json(
        `/repos/${owner}/${repo}/git/blobs/${file.sha}`,
      );
      if (!isRecord(value) || value["encoding"] !== "base64")
        throw new Error("GitHub returned an unsupported blob");
      const encoded = value["content"];
      if (typeof encoded !== "string")
        throw new Error("GitHub blob has no content");
      const compact = encoded.replace(/\s+/gu, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact))
        throw new Error("GitHub blob is not valid base64");
      const bytes = Buffer.from(compact, "base64");
      totalBytes += bytes.length;
      if (totalBytes > 1_048_576) throw new Error("GitHub skill exceeds 1 MiB");
      const text = bytes.toString("utf8");
      if (!Buffer.from(text).equals(bytes))
        throw new Error("GitHub skill contains non-UTF-8 files");
      const relativePath = file.path.slice(skillPath.length + 1);
      if (relativePath === "SKILL.md") skillContent = text;
      hashes.push(`${relativePath}\0${digest(bytes)}`);
    }
    return {
      repository: `https://github.com/${owner}/${repo}`,
      commit,
      path: skillPath,
      contentHash: digest(hashes.join("\n")),
      description: skillDescription(skillContent),
    };
  }

  async #json(path: string): Promise<unknown> {
    const response = await this.#fetch(new URL(path, this.#baseUrl), {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    if (!response.ok)
      throw new Error(`GitHub skill request failed: ${response.status}`);
    return readJsonResponse(response);
  }
}

function parseTreeEntry(value: unknown): TreeEntry {
  if (!isRecord(value))
    throw new Error("GitHub returned an invalid tree entry");
  const { path, mode, type, sha } = value;
  if (
    typeof path !== "string" ||
    !normalizedPath(path) ||
    typeof mode !== "string" ||
    typeof type !== "string" ||
    typeof sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(sha)
  )
    throw new Error("GitHub returned an invalid tree entry");
  return { path, mode, type, sha };
}

function normalizedPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function skillDescription(content: string): string {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)?.[1] ?? "";
  const lines = block.split(/\r?\n/u);
  const index = lines.findIndex((line) => /^description\s*:/u.test(line));
  if (index < 0) return "Community registry skill";
  const inline = lines[index]!.replace(/^description\s*:\s*/u, "").trim();
  if (inline && inline !== ">" && inline !== "|")
    return inline.replace(/^['"]|['"]$/gu, "");
  const values: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (!/^\s+/u.test(line)) break;
    values.push(line.trim());
  }
  return values.join(" ") || "Community registry skill";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
