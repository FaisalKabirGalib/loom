import { describe, expect, it, vi } from "vitest";

import { GitHubProvenanceRegistry } from "./github.js";

describe("GitHubProvenanceRegistry", () => {
  it("normalizes provenance and sends an optional token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                full_name: "example/tool",
                html_url: "https://github.com/example/tool",
                description: "Tool",
                stargazers_count: 42,
                archived: false,
                disabled: false,
                updated_at: "2026-01-01T00:00:00Z",
                owner: { login: "example", type: "Organization" },
                topics: ["mcp"],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const registry = new GitHubProvenanceRegistry({
      token: "token",
      fetch: fetcher,
    });

    const [candidate] = await registry.search({ text: "tool", limit: 5 });

    expect(candidate).toMatchObject({
      id: "github:example/tool",
      metrics: { stars: 42 },
      provenance: { knownMaintainer: true, repositoryVerified: true },
    });
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer token" }),
      }),
    );
    await expect(
      registry.search({ text: "tool", kinds: ["cli"] }),
    ).resolves.toEqual([]);
  });
});
