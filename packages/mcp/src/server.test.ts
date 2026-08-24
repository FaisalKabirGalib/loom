import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decodeSetupIntent } from "@loom/core";
import { describe, expect, it } from "vitest";

import { LOOM_TOOL_NAMES, createLoomMcpServer } from "./server.js";

describe("Loom MCP server", () => {
  it("initializes, lists exactly nine tools, and calls a tool over the SDK transport", async () => {
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
        version: "0.2.0",
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

  it("returns a decodable setup recommendation over the SDK transport", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-mcp-setup-"));
    const server = createLoomMcpServer({
      cwd: () => root,
      networkRegistries: () => [],
    });
    const client = new Client({ name: "loom-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const called = await client.callTool({
        name: "loom_setup_recommend",
        arguments: { networkDiscovery: false },
      });

      expect(called.isError).not.toBe(true);
      expect(called.structuredContent).toMatchObject({
        ok: true,
        data: {
          intent: expect.stringMatching(/^loom1_[A-Za-z0-9_-]+$/),
          command: expect.stringMatching(/^loom setup --intent loom1_/),
          selected: expect.any(Array),
          approvals: expect.any(Array),
          uncovered: expect.any(Array),
          warnings: expect.any(Array),
        },
      });
      const structured = called.structuredContent as
        { data?: Record<string, unknown> } | undefined;
      const data = structured?.data;
      expect(decodeSetupIntent(data?.["intent"] as string)).toMatchObject({
        schemaVersion: 1,
        mode: "apply",
        harness: "opencode",
      });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("redacts secret-shaped manifest values from every result form", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-mcp-secret-"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        dependencies: {
          api_token: "do-not-expose",
          secrets: "also-do-not-expose",
        },
      }),
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
      expect(JSON.stringify(called)).not.toContain("also-do-not-expose");
      expect(JSON.stringify(called)).toContain("[REDACTED]");
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("preserves permission secret names as arrays", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-mcp-permissions-"));
    await writeFile(
      join(root, "pubspec.yaml"),
      "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    const server = createLoomMcpServer({ cwd: () => root });
    const client = new Client({ name: "loom-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const called = await client.callTool({
        name: "loom_project_plan",
        arguments: {},
      });
      expect(JSON.stringify(called)).toContain('"secrets":[]');
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
