import {
  capabilityCandidateSchema,
  type CapabilityCandidate,
} from "@loom/core";
import { z } from "zod";

import {
  capabilityQuerySchema,
  type CapabilityQueryInput,
  type CapabilityRegistry,
} from "./types.js";
import { inferCapabilities } from "./inference.js";
import { readJsonResponse } from "./http.js";
import { matchesCapabilityQuery } from "./filter.js";

const repositorySchema = z
  .object({
    full_name: z.string(),
    html_url: z.string(),
    description: z.string().nullable(),
    stargazers_count: z.number().nonnegative(),
    archived: z.boolean(),
    disabled: z.boolean(),
    updated_at: z.string(),
    owner: z.object({ login: z.string(), type: z.string() }),
    topics: z.array(z.string()).default([]),
  })
  .passthrough();

const searchResponseSchema = z
  .object({ items: z.array(repositorySchema) })
  .passthrough();
type Repository = z.infer<typeof repositorySchema>;

const normalize = (
  repository: Repository,
  version?: string,
): CapabilityCandidate =>
  capabilityCandidateSchema.parse({
    id: `github:${repository.full_name}`,
    name: repository.full_name,
    kind: "plugin",
    source: {
      registry: "github-fallback",
      repository: repository.html_url,
      publisher: repository.owner.login,
    },
    ...(version === undefined ? {} : { version }),
    updatedAt: repository.updated_at,
    ecosystems: [],
    provides: inferCapabilities(
      `${repository.full_name} ${repository.description ?? ""} ${repository.topics.join(" ")}`,
    ),
    tags: repository.topics,
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
      knownMaintainer: repository.owner.type === "Organization",
      repositoryVerified: true,
    },
    metrics: { stars: repository.stargazers_count },
    overlapGroups: [],
    recommendedScope: "on-demand",
    trustTier:
      repository.archived || repository.disabled ? "blocked" : "community",
    taskTriggers: [],
    contextCost: 15,
    portability: 50,
    notes: [
      "GitHub metadata is provenance context, not an installation recommendation",
      ...(repository.archived ? ["Repository is archived"] : []),
      ...(repository.disabled ? ["Repository is disabled"] : []),
    ],
  });

export interface GitHubProvenanceRegistryOptions {
  token?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  requestTimeoutMs?: number;
}

export class GitHubProvenanceRegistry implements CapabilityRegistry {
  public readonly id = "github-fallback";
  private readonly token: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: URL;
  private readonly requestTimeoutMs: number;

  public constructor(options: GitHubProvenanceRegistryOptions = {}) {
    this.token = options.token;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.baseUrl = new URL(options.baseUrl ?? "https://api.github.com");
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    if (
      this.token !== undefined &&
      (this.baseUrl.protocol !== "https:" ||
        this.baseUrl.origin !== "https://api.github.com")
    )
      throw new Error(
        "GitHub tokens may only be sent to https://api.github.com",
      );
  }

  public async search(
    queryInput: CapabilityQueryInput,
  ): Promise<CapabilityCandidate[]> {
    const query = capabilityQuerySchema.parse(queryInput);
    if (query.text === undefined) return [];
    const url = new URL("/search/repositories", this.baseUrl);
    url.searchParams.set("q", [query.text, ...query.ecosystems].join(" "));
    url.searchParams.set("per_page", String(query.limit));
    const response = await this.fetcher(url, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok)
      throw new Error(`GitHub provenance request failed: ${response.status}`);
    return searchResponseSchema
      .parse(await readJsonResponse(response))
      .items.map((item) => normalize(item))
      .filter((candidate) => matchesCapabilityQuery(candidate, query));
  }

  public async resolve(
    id: string,
    version?: string,
  ): Promise<CapabilityCandidate | null> {
    const name = id.startsWith("github:") ? id.slice(7) : id;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(name)) return null;
    const response = await this.fetcher(
      new URL(`/repos/${name}`, this.baseUrl),
      {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      },
    );
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(`GitHub provenance request failed: ${response.status}`);
    return normalize(
      repositorySchema.parse(await readJsonResponse(response)),
      version,
    );
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(this.token === undefined
        ? {}
        : { authorization: `Bearer ${this.token}` }),
    };
  }
}

export { GitHubProvenanceRegistry as GitHubFallbackRegistry };
