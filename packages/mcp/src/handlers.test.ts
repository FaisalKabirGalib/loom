import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectProject, type CapabilityCandidate } from "@loom/core";
import { BuiltinRegistry, type CapabilityRegistry } from "@loom/registry";
import { describe, expect, it, vi } from "vitest";

import { createLoomToolHandlers } from "./handlers.js";

describe("createLoomToolHandlers", () => {
  it("delegates detection and keeps network discovery disabled by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-mcp-"));
    const detect = vi.fn(detectProject);
    const network = vi.fn<() => readonly CapabilityRegistry[]>(() => [
      new BuiltinRegistry(),
    ]);
    const handlers = createLoomToolHandlers({
      cwd: () => root,
      detectProject: detect,
      networkRegistries: network,
    });

    const detected = await handlers.projectDetect({});
    const searched = await handlers.capabilitySearch({ text: "context7" });

    expect(detect).toHaveBeenCalledWith(root);
    expect(detected.project).toMatchObject({ root, lifecycle: "greenfield" });
    expect(network).not.toHaveBeenCalled();
    expect(searched).toMatchObject({
      networkDiscovery: false,
      registries: ["builtin"],
      count: 1,
    });
  });

  it("uses network registries only when explicitly requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-mcp-"));
    const candidate = (await new BuiltinRegistry().resolve(
      "context7",
    )) as CapabilityCandidate;
    const registry: CapabilityRegistry = {
      id: "network-test",
      search: vi.fn(async () => [candidate]),
      resolve: vi.fn(async () => candidate),
    };
    const network = vi.fn(() => [registry]);
    const handlers = createLoomToolHandlers({
      cwd: () => root,
      localRegistries: [],
      networkRegistries: network,
    });

    const result = await handlers.capabilitySearch({
      text: "context7",
      networkDiscovery: true,
    });

    expect(network).toHaveBeenCalledOnce();
    expect(registry.search).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ count: 1, registries: ["network-test"] });
  });

  it("reads valid state and refuses state-file symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-mcp-"));
    const stateDirectory = join(root, ".loom");
    const outside = join(root, "outside.json");
    await mkdir(stateDirectory);
    await writeFile(
      join(stateDirectory, "capabilities.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date(0).toISOString(),
        entries: [],
      }),
    );
    await writeFile(outside, JSON.stringify({ phase: "build" }));
    await symlink(outside, join(stateDirectory, "workflow.json"));
    const handlers = createLoomToolHandlers({ cwd: () => root });

    const capabilities = await handlers.capabilityStatus({});
    const workflow = await handlers.workflowStatus({});

    expect(capabilities).toMatchObject({
      state: { status: "valid" },
      capabilities: [],
    });
    expect(workflow).toMatchObject({
      state: {
        status: "invalid",
        error: "State file must not be a symbolic link",
      },
      workflow: null,
    });
  });
});
