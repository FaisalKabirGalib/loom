import {
  capabilityCandidateSchema,
  type CapabilityCandidate,
  type Permissions,
} from "@loom/core";
import { z } from "zod";

import {
  capabilityQuerySchema,
  registryCursorSchema,
  registryVersionSchema,
  type CapabilityQuery,
  type CapabilityQueryInput,
  type PaginatedCapabilityRegistry,
  type RegistryPage,
} from "./types.js";
import { inferCapabilities } from "./inference.js";
import { readJsonResponse } from "./http.js";
import { matchesCapabilityQuery } from "./filter.js";

const transportSchema = z
  .object({
    type: z.string(),
    url: z.string().optional(),
    headers: z
      .array(
        z
          .object({ name: z.string(), isSecret: z.boolean().optional() })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

const packageSchema = z
  .object({
    registryType: z.string(),
    identifier: z.string(),
    version: z.string().optional(),
    runtimeHint: z.string().optional(),
    transport: transportSchema,
    environmentVariables: z
      .array(
        z
          .object({ name: z.string(), isSecret: z.boolean().optional() })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

const serverSchema = z
  .object({
    name: z.string().min(1),
    title: z.string().optional(),
    description: z.string(),
    version: z.string(),
    repository: z
      .object({
        url: z.string().optional(),
        source: z.string().optional(),
        id: z.string().optional(),
      })
      .passthrough()
      .optional(),
    packages: z.array(packageSchema).nullish(),
    remotes: z.array(transportSchema).nullish(),
  })
  .passthrough();

const statusSchema = z
  .object({
    status: z.enum(["active", "deprecated", "deleted"]),
    statusMessage: z.string().optional(),
    statusChangedAt: z.string(),
    publishedAt: z.string(),
    updatedAt: z.string().optional(),
    isLatest: z.boolean(),
  })
  .passthrough();

const serverResponseSchema = z
  .object({
    server: serverSchema,
    _meta: z
      .object({
        "io.modelcontextprotocol.registry/official": statusSchema,
      })
      .passthrough(),
  })
  .passthrough();

const serverListSchema = z
  .object({
    servers: z.array(serverResponseSchema).nullable(),
    metadata: z
      .object({
        count: z.number().int().nonnegative(),
        nextCursor: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

type ServerResponse = z.infer<typeof serverResponseSchema>;
type Package = z.infer<typeof packageSchema>;

const runtimeKind = (
  item: Package | undefined,
): NonNullable<CapabilityCandidate["runtime"]>["kind"] => {
  const value =
    `${item?.runtimeHint ?? ""} ${item?.registryType ?? ""}`.toLowerCase();
  if (/uv|python|pypi/u.test(value)) return "python";
  if (/docker|oci/u.test(value)) return "docker";
  if (/go/u.test(value)) return "go";
  if (/dart|pub/u.test(value)) return "dart";
  if (/npm|node|npx|pnpm|yarn/u.test(value)) return "node";
  return "binary";
};

const secretNames = (entry: ServerResponse): string[] => {
  const packageSecrets = (entry.server.packages ?? []).flatMap((item) =>
    (item.environmentVariables ?? [])
      .filter((variable) => variable.isSecret !== false)
      .map((variable) => variable.name),
  );
  const remoteSecrets = (entry.server.remotes ?? []).flatMap((item) =>
    (item.headers ?? [])
      .filter((header) => header.isSecret !== false)
      .map((header) => header.name),
  );
  const packageHeaderSecrets = (entry.server.packages ?? []).flatMap((item) =>
    (item.transport.headers ?? [])
      .filter((header) => header.isSecret !== false)
      .map((header) => header.name),
  );
  return [
    ...new Set([...packageSecrets, ...packageHeaderSecrets, ...remoteSecrets]),
  ];
};

const normalize = (entry: ServerResponse): CapabilityCandidate => {
  const server = entry.server;
  const metadata = entry._meta["io.modelcontextprotocol.registry/official"];
  const firstPackage = server.packages?.[0];
  const packageTransport = firstPackage?.transport.type.toLowerCase();
  const packageUsesNetwork =
    packageTransport?.includes("http") === true ||
    packageTransport?.includes("sse") === true;
  const isRemote =
    (server.remotes?.length ?? 0) > 0 && firstPackage === undefined;
  const canExecuteShell = /\b(shell|terminal|command execution)\b/iu.test(
    server.description,
  );
  const permissions: Permissions = {
    filesystem: firstPackage === undefined ? "none" : "read",
    shell: canExecuteShell,
    network:
      packageUsesNetwork || isRemote || (server.remotes?.length ?? 0) > 0,
    secrets: secretNames(entry),
    database: "none",
    device: false,
  };
  const words =
    `${server.title ?? ""} ${server.description}`
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9+._-]{2,}/gu) ?? [];
  return capabilityCandidateSchema.parse({
    id: `mcp:${server.name}`,
    name: server.title ?? server.name,
    kind: "mcp",
    source: {
      registry: "official-mcp",
      ...(server.repository?.url === undefined
        ? {}
        : { repository: server.repository.url }),
      ...(firstPackage === undefined
        ? {}
        : { package: firstPackage.identifier }),
      publisher: server.name.split("/")[0],
    },
    version: server.version,
    updatedAt: metadata.updatedAt ?? metadata.statusChangedAt,
    ecosystems: [],
    provides: inferCapabilities(
      `${server.name} ${server.title ?? ""} ${server.description}`,
    ),
    tags: [...new Set(words)].slice(0, 30),
    transport: isRemote || packageUsesNetwork ? "http" : "stdio",
    runtime:
      isRemote || packageUsesNetwork
        ? { kind: "remote" }
        : {
            kind: runtimeKind(firstPackage),
            ...(firstPackage?.runtimeHint === undefined
              ? {}
              : { command: firstPackage.runtimeHint }),
          },
    permissions,
    provenance: {
      official: false,
      namespaceVerified: true,
      knownMaintainer: false,
      repositoryVerified:
        server.repository?.source?.toLowerCase() === "github" &&
        server.repository.id !== undefined,
    },
    overlapGroups: [],
    recommendedScope: "on-demand",
    trustTier:
      metadata.status === "deleted"
        ? "blocked"
        : metadata.status === "deprecated"
          ? "community"
          : "community-reviewed",
    taskTriggers: [],
    contextCost: 30,
    portability: isRemote ? 75 : 50,
    notes: [
      `Registry status: ${metadata.status}`,
      ...(metadata.statusMessage === undefined ? [] : [metadata.statusMessage]),
      "Official registry publication is not a quality endorsement",
    ],
  });
};

export interface OfficialMcpRegistryOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export class OfficialMcpRegistry implements PaginatedCapabilityRegistry {
  public readonly id = "official-mcp";
  private readonly baseUrl: URL;
  private readonly fetcher: typeof fetch;
  private readonly requestTimeoutMs: number;

  public constructor(options: OfficialMcpRegistryOptions = {}) {
    this.baseUrl = new URL(
      options.baseUrl ?? "https://registry.modelcontextprotocol.io",
    );
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  public async search(
    query: CapabilityQueryInput,
  ): Promise<CapabilityCandidate[]> {
    return (await this.searchPage(query)).candidates;
  }

  public async searchPage(
    queryInput: CapabilityQueryInput,
  ): Promise<RegistryPage> {
    const query = capabilityQuerySchema.parse(queryInput);
    const url = new URL("/v0.1/servers", this.baseUrl);
    this.applyQuery(url, query);
    const response = await this.fetcher(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok)
      throw new Error(
        `Official MCP registry request failed: ${response.status}`,
      );
    const result = serverListSchema.parse(await readJsonResponse(response));
    const nextCursor =
      result.metadata.nextCursor === undefined
        ? undefined
        : registryCursorSchema.parse(result.metadata.nextCursor);
    return {
      candidates: (result.servers ?? [])
        .map(normalize)
        .filter((candidate) => matchesCapabilityQuery(candidate, query)),
      ...(nextCursor === undefined ? {} : { nextCursor }),
      count: result.metadata.count,
    };
  }

  public async resolve(
    id: string,
    version = "latest",
  ): Promise<CapabilityCandidate | null> {
    const name = id.startsWith("mcp:") ? id.slice(4) : id;
    if (name.length === 0 || name.length > 200)
      throw new Error("Invalid MCP server id");
    const parsedVersion = registryVersionSchema.parse(version);
    const url = new URL(
      `/v0.1/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(parsedVersion)}`,
      this.baseUrl,
    );
    const response = await this.fetcher(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (response.status === 404) return null;
    if (!response.ok)
      throw new Error(
        `Official MCP registry request failed: ${response.status}`,
      );
    return normalize(
      serverResponseSchema.parse(await readJsonResponse(response)),
    );
  }

  private applyQuery(url: URL, query: CapabilityQuery): void {
    if (query.text !== undefined) url.searchParams.set("search", query.text);
    if (query.version !== undefined)
      url.searchParams.set("version", query.version);
    if (query.updatedSince !== undefined)
      url.searchParams.set("updated_since", query.updatedSince);
    if (query.cursor !== undefined)
      url.searchParams.set("cursor", query.cursor);
    if (query.includeDeleted) url.searchParams.set("include_deleted", "true");
    url.searchParams.set("limit", String(query.limit));
  }
}

export const normalizeOfficialMcpServer = (
  value: unknown,
): CapabilityCandidate => normalize(serverResponseSchema.parse(value));
