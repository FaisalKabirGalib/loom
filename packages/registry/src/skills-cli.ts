import { stripVTControlCharacters } from "node:util";

import {
  capabilityCandidateSchema,
  type CapabilityCandidate,
} from "@loom/core";

import { NodeProcessRunner } from "./process.js";
import {
  capabilityQuerySchema,
  type CapabilityQueryInput,
  type CapabilityRegistry,
  type ProcessRunner,
} from "./types.js";
import { inferCapabilities } from "./inference.js";
import { matchesCapabilityQuery } from "./filter.js";

const skillReference =
  /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+)$/u;

interface SkillRecord {
  reference: string;
  name: string;
  repository: string;
  installs?: number;
}

const parseInstalls = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return value;
  if (typeof value !== "string") return undefined;
  const match = value
    .trim()
    .toLowerCase()
    .match(/^(\d+(?:\.\d+)?)([km])?$/u);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const multiplier =
    match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1;
  return Math.round(amount * multiplier);
};

const recordFromReference = (
  reference: string,
  installs?: number,
): SkillRecord | null => {
  const match = reference.match(skillReference);
  if (match === null) return null;
  const owner = match[1];
  const repo = match[2];
  const name = match[3];
  if (owner === undefined || repo === undefined || name === undefined)
    return null;
  return {
    reference,
    name,
    repository: `https://github.com/${owner}/${repo}`,
    ...(installs === undefined ? {} : { installs }),
  };
};

const fromJsonItem = (value: unknown): SkillRecord | null => {
  if (typeof value === "string") return recordFromReference(value);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const item = value as Record<string, unknown>;
  const direct = [item.reference, item.id, item.source].find(
    (candidate) =>
      typeof candidate === "string" && skillReference.test(candidate),
  );
  const installs = parseInstalls(
    item.installs ?? item.installCount ?? item.downloads,
  );
  if (typeof direct === "string") return recordFromReference(direct, installs);
  const repository =
    typeof item.repository === "string"
      ? item.repository
      : typeof item.repo === "string"
        ? item.repo
        : undefined;
  const name =
    typeof item.name === "string"
      ? item.name
      : typeof item.skill === "string"
        ? item.skill
        : undefined;
  if (repository === undefined || name === undefined) return null;
  const normalizedRepository = repository
    .replace(/^https:\/\/github\.com\//u, "")
    .replace(/\.git$/u, "");
  return recordFromReference(`${normalizedRepository}@${name}`, installs);
};

export const parseSkillsOutput = (output: string): SkillRecord[] => {
  const clean = stripVTControlCharacters(output).trim();
  if (clean.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(clean);
    const values = Array.isArray(parsed)
      ? parsed
      : parsed !== null && typeof parsed === "object"
        ? ((parsed as Record<string, unknown>).skills ??
          (parsed as Record<string, unknown>).results ??
          (parsed as Record<string, unknown>).items)
        : undefined;
    if (!Array.isArray(values)) return [];
    return values
      .slice(0, 1_000)
      .map(fromJsonItem)
      .filter((value): value is SkillRecord => value !== null);
  } catch {
    const textLine =
      /^\s*(?:[│├└─*•>]\s*)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+)(?:\s+(\d+(?:\.\d+)?[kKmM]?)\s+installs?)?\s*$/u;
    return clean
      .split(/\r?\n/u)
      .slice(0, 1_000)
      .map((line) => line.match(textLine))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) =>
        recordFromReference(match[1] ?? "", parseInstalls(match[2])),
      )
      .filter((value): value is SkillRecord => value !== null);
  }
};

const normalize = (record: SkillRecord): CapabilityCandidate =>
  capabilityCandidateSchema.parse({
    id: `skill:${record.reference}`,
    name: record.name,
    kind: "skill",
    source: {
      registry: "skills-cli",
      repository: record.repository,
      package: record.reference,
      publisher: record.reference.split("/")[0],
    },
    ecosystems: [],
    provides: inferCapabilities(record.reference),
    tags: record.reference
      .toLowerCase()
      .split(/[/@._-]+/u)
      .filter(Boolean),
    permissions: {
      filesystem: "write",
      shell: true,
      network: true,
      secrets: [],
      database: "none",
      device: false,
    },
    provenance: {
      official: false,
      namespaceVerified: false,
      knownMaintainer: false,
      repositoryVerified: true,
    },
    metrics:
      record.installs === undefined ? undefined : { installs: record.installs },
    overlapGroups: [],
    recommendedScope: "project",
    trustTier: "community",
    taskTriggers: [],
    contextCost: 10,
    portability: 70,
    notes: ["Skill scripts require review before execution"],
  });

export interface SkillsCliRegistryOptions {
  runner?: ProcessRunner;
  command?: string;
  commandPrefix?: readonly string[];
}

export class SkillsCliRegistry implements CapabilityRegistry {
  public readonly id = "skills-cli";
  private readonly runner: ProcessRunner;
  private readonly command: string;
  private readonly commandPrefix: readonly string[];

  public constructor(options: SkillsCliRegistryOptions = {}) {
    this.runner = options.runner ?? new NodeProcessRunner();
    this.command = options.command ?? "npx";
    this.commandPrefix = options.commandPrefix ?? ["--yes", "skills@1.5.23"];
  }

  public async search(
    queryInput: CapabilityQueryInput,
  ): Promise<CapabilityCandidate[]> {
    const query = capabilityQuerySchema.parse(queryInput);
    const records =
      query.text === undefined
        ? await this.run(["list", "--json"])
        : await this.run(["find", query.text]);
    return records
      .map(normalize)
      .filter((candidate) => matchesCapabilityQuery(candidate, query))
      .slice(0, query.limit);
  }

  public async list(): Promise<CapabilityCandidate[]> {
    return (await this.run(["list", "--json"])).map(normalize);
  }

  public async resolve(id: string): Promise<CapabilityCandidate | null> {
    const reference = id.startsWith("skill:") ? id.slice(6) : id;
    if (!skillReference.test(reference)) return null;
    const matches = await this.search({ text: reference, limit: 100 });
    return (
      matches.find((candidate) => candidate.id === `skill:${reference}`) ?? null
    );
  }

  private async run(args: readonly string[]): Promise<SkillRecord[]> {
    const result = await this.runner.run(this.command, [
      ...this.commandPrefix,
      ...args,
    ]);
    if (result.exitCode !== 0) return [];
    return parseSkillsOutput(result.stdout);
  }
}
