import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { LOOM_TOOL_NAMES, createLoomMcpServer } from "./server.js";

describe("Loom MCP server", () => {
  it("initializes, lists exactly eight tools, and calls a tool over the SDK transport", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-mcp-"));
    const server = createLoomMcpServer({ cwd: () => root });
    const client = new Client({ name: "loom-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      expect(client.getServerVersion()).toMatchObject({
        name: "loom",
        version: "0.1.0",
      });
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(LOOM_TOOL_NAMES);

      const called = await client.callTool({
        name: "loom_project_detect",
        arguments: {},
      });
      expect(called.isError).not.toBe(true);
      expect(called.structuredContent).toMatchObject({
        ok: true,
        data: { project: { root, lifecycle: "greenfield" } },
      });
      if (!("content" in called) || !Array.isArray(called.content))
        throw new Error("Expected tool content");
      const first = called.content[0] as { type?: string; text?: string };
      expect(
        JSON.parse(first.type === "text" ? (first.text ?? "null") : "null"),
      ).toEqual(called.structuredContent);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("redacts secret-shaped manifest values from every result form", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-mcp-secret-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { api_token: "do-not-expose" } }),
    );
    const server = createLoomMcpServer({ cwd: () => root });
    const client = new Client({ name: "loom-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const called = await client.callTool({
        name: "loom_project_detect",
        arguments: {},
      });
      expect(JSON.stringify(called)).not.toContain("do-not-expose");
      expect(JSON.stringify(called)).toContain("[REDACTED]");
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
