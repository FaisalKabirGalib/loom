import { describe, expect, it, vi } from "vitest";

import { OfficialMcpRegistry } from "./official-mcp.js";

const entry = (status: "active" | "deprecated" | "deleted" = "active") => ({
  server: {
    $schema: "https://example.com/server.schema.json",
    name: "io.example/tools",
    title: "Example Tools",
    description: "Useful development tools",
    version: "1.2.3",
    repository: {
      url: "https://github.com/example/tools",
      source: "github",
      id: "42",
    },
    packages: [
      {
        registryType: "npm",
        identifier: "@example/tools",
        runtimeHint: "npx",
        transport: { type: "stdio" },
        environmentVariables: [{ name: "EXAMPLE_TOKEN", isSecret: true }],
      },
    ],
  },
  _meta: {
    "io.modelcontextprotocol.registry/official": {
      status,
      statusChangedAt: "2026-01-01T00:00:00Z",
      publishedAt: "2025-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      isLatest: true,
    },
  },
});

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("OfficialMcpRegistry", () => {
  it("passes validated pagination parameters and normalizes pages", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          servers: [entry()],
          metadata: { count: 1, nextCursor: "next:1" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ servers: [], metadata: { count: 0 } }),
      );
    const registry = new OfficialMcpRegistry({ fetch: fetcher });

    const first = await registry.searchPage({
      text: "tools",
      version: "latest",
      updatedSince: "2026-01-01T00:00:00Z",
      limit: 10,
    });
    const second = await registry.searchPage({
      cursor: first.nextCursor,
      limit: 10,
    });

    expect(first.nextCursor).toBe("next:1");
    expect(first.candidates[0]).toMatchObject({
      id: "mcp:io.example/tools",
      version: "1.2.3",
      transport: "stdio",
      trustTier: "community-reviewed",
      runtime: { kind: "node", command: "npx" },
      permissions: { shell: false, secrets: ["EXAMPLE_TOKEN"] },
      provenance: { namespaceVerified: true, repositoryVerified: true },
    });
    expect(second.candidates).toEqual([]);
    const firstUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    const secondUrl = new URL(String(fetcher.mock.calls[1]?.[0]));
    expect(firstUrl.pathname).toBe("/v0.1/servers");
    expect(firstUrl.searchParams.get("updated_since")).toBe(
      "2026-01-01T00:00:00Z",
    );
    expect(secondUrl.searchParams.get("cursor")).toBe("next:1");
  });

  it("blocks deleted registry entries", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ servers: [entry("deleted")], metadata: { count: 1 } }),
      );
    const registry = new OfficialMcpRegistry({ fetch: fetcher });

    const [candidate] = await registry.search({ includeDeleted: true });

    expect(candidate?.trustTier).toBe("blocked");
    expect(candidate?.notes).toContain("Registry status: deleted");
  });

  it("enforces normalized trust and kind filters", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        jsonResponse({ servers: [entry()], metadata: { count: 1 } }),
      );
    const registry = new OfficialMcpRegistry({ fetch: fetcher });

    await expect(
      registry.search({ minTrustTier: "official" }),
    ).resolves.toEqual([]);
    await expect(registry.search({ kinds: ["skill"] })).resolves.toEqual([]);
  });

  it("accepts incomplete optional repository metadata", async () => {
    const value = entry();
    value.server.repository = {} as typeof value.server.repository;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ servers: [value], metadata: { count: 1 } }),
      );

    const [candidate] = await new OfficialMcpRegistry({
      fetch: fetcher,
    }).search({});

    expect(candidate?.source.repository).toBeUndefined();
    expect(candidate?.provenance.repositoryVerified).toBe(false);
  });

  it("models HTTP package transports and secret headers conservatively", async () => {
    const value = entry();
    value.server.packages[0]!.transport = {
      type: "streamable-http",
      headers: [{ name: "AUTH_HEADER", isSecret: true }],
    } as (typeof value.server.packages)[0]["transport"];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ servers: [value], metadata: { count: 1 } }),
      );

    const [candidate] = await new OfficialMcpRegistry({
      fetch: fetcher,
    }).search({});

    expect(candidate).toMatchObject({
      transport: "http",
      runtime: { kind: "remote" },
      permissions: { network: true },
    });
    expect(candidate?.permissions.secrets).toContain("AUTH_HEADER");
  });

  it("rejects invalid versions, timestamps, and cursors before fetching", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const registry = new OfficialMcpRegistry({ fetch: fetcher });

    await expect(registry.search({ version: "^1.0.0" })).rejects.toThrow();
    await expect(
      registry.search({ updatedSince: "yesterday" }),
    ).rejects.toThrow();
    await expect(registry.search({ cursor: "" })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(
      jsonResponse({ servers: [], metadata: { count: 0 } }),
    );
    await expect(registry.search({ version: "1.0.0-exp.1" })).resolves.toEqual(
      [],
    );
  });
});
