import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BUILTIN_CATALOG } from "./catalog.js";
import {
  AtomicTtlCache,
  registryQueryFingerprint,
  syncRegistryCache,
} from "./cache.js";
import type { PaginatedCapabilityRegistry } from "./types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AtomicTtlCache", () => {
  it("honors TTL and refreshes expired values", async () => {
    let now = 1_000;
    const directory = await mkdtemp(join(tmpdir(), "loom-cache-"));
    directories.push(directory);
    const cache = new AtomicTtlCache(directory, () => now);
    const loader = vi
      .fn()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");

    expect(
      await cache.getOrRefresh("registry", loader, { ttlMs: 100 }),
    ).toMatchObject({ value: "first", source: "network" });
    now = 1_050;
    expect(
      await cache.getOrRefresh("registry", loader, { ttlMs: 100 }),
    ).toMatchObject({ value: "first", source: "fresh-cache" });
    now = 1_101;
    expect(
      await cache.getOrRefresh("registry", loader, { ttlMs: 100 }),
    ).toMatchObject({ value: "second", source: "network" });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("uses stale data offline and on network failure", async () => {
    let now = 1_000;
    const directory = await mkdtemp(join(tmpdir(), "loom-cache-"));
    directories.push(directory);
    const cache = new AtomicTtlCache(directory, () => now);
    await cache.write("registry", { candidates: ["cached"] });
    now = 5_000;
    const loader = vi.fn().mockRejectedValue(new Error("offline"));

    expect(
      await cache.getOrRefresh("registry", loader, {
        ttlMs: 10,
        offline: true,
      }),
    ).toMatchObject({ source: "stale-cache" });
    expect(loader).not.toHaveBeenCalled();
    expect(
      await cache.getOrRefresh("registry", loader, { ttlMs: 10 }),
    ).toMatchObject({ source: "stale-cache" });
    expect(
      await cache.getOrRefresh("missing", loader, { ttlMs: 10, offline: true }),
    ).toEqual({ value: null, source: "offline-miss" });
  });

  it("incrementally follows cursors and removes deleted entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loom-cache-"));
    directories.push(directory);
    const cache = new AtomicTtlCache(directory, () => 2_000);
    const existing = BUILTIN_CATALOG[0];
    const added = BUILTIN_CATALOG[1];
    if (existing === undefined || added === undefined)
      throw new Error("Missing seed fixtures");
    await cache.write("registry", {
      candidates: [existing],
      syncedAt: "2026-01-01T00:00:00.000Z",
      queryFingerprint: registryQueryFingerprint({}),
    });
    const deleted = {
      ...existing,
      trustTier: "blocked" as const,
      notes: ["Registry status: deleted"],
    };
    const searchPage = vi
      .fn<PaginatedCapabilityRegistry["searchPage"]>()
      .mockResolvedValueOnce({
        candidates: [added],
        nextCursor: "page-2",
        count: 1,
      })
      .mockResolvedValueOnce({ candidates: [deleted], count: 1 });
    const registry: PaginatedCapabilityRegistry = {
      id: "mock",
      search: vi.fn(),
      resolve: vi.fn(),
      searchPage,
    };

    const result = await syncRegistryCache(
      cache,
      "registry",
      registry,
      {},
      {
        ttlMs: 1_000,
        force: true,
      },
    );

    expect(result.value?.candidates.map((candidate) => candidate.id)).toEqual([
      added.id,
    ]);
    expect(result.value?.complete).toBe(true);
    expect(searchPage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        updatedSince: "2026-01-01T00:00:00.000Z",
        includeDeleted: true,
      }),
    );
    expect(searchPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: "page-2" }),
    );
  });

  it("checkpoints and resumes bounded full syncs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loom-cache-"));
    directories.push(directory);
    const cache = new AtomicTtlCache(directory, () => 2_000);
    const first = BUILTIN_CATALOG[0];
    const second = BUILTIN_CATALOG[1];
    if (first === undefined || second === undefined)
      throw new Error("Missing seed fixtures");
    const searchPage = vi
      .fn<PaginatedCapabilityRegistry["searchPage"]>()
      .mockResolvedValueOnce({
        candidates: [first],
        nextCursor: "resume-here",
        count: 1,
      })
      .mockResolvedValueOnce({ candidates: [second], count: 1 });
    const registry: PaginatedCapabilityRegistry = {
      id: "mock",
      search: vi.fn(),
      resolve: vi.fn(),
      searchPage,
    };

    const partial = await syncRegistryCache(
      cache,
      "registry",
      registry,
      {},
      {
        ttlMs: 1_000,
        maxPages: 1,
      },
    );
    const complete = await syncRegistryCache(
      cache,
      "registry",
      registry,
      {},
      {
        ttlMs: 1_000,
        maxPages: 1,
      },
    );

    expect(partial.value).toMatchObject({
      complete: false,
      nextCursor: "resume-here",
    });
    expect(complete.value?.complete).toBe(true);
    expect(complete.value?.candidates).toHaveLength(2);
    expect(searchPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: "resume-here" }),
    );
  });

  it("refreshes a fresh snapshot when its normalized query changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "loom-cache-"));
    directories.push(directory);
    const cache = new AtomicTtlCache(directory, () => 2_000);
    const searchPage = vi
      .fn<PaginatedCapabilityRegistry["searchPage"]>()
      .mockResolvedValue({ candidates: [], count: 0 });
    const registry: PaginatedCapabilityRegistry = {
      id: "mock",
      search: vi.fn(),
      resolve: vi.fn(),
      searchPage,
    };

    await syncRegistryCache(
      cache,
      "registry",
      registry,
      { text: "first" },
      {
        ttlMs: 10_000,
      },
    );
    await syncRegistryCache(
      cache,
      "registry",
      registry,
      { text: "second" },
      {
        ttlMs: 10_000,
      },
    );

    expect(searchPage).toHaveBeenCalledTimes(2);
    expect(searchPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "second" }),
    );
  });
});
