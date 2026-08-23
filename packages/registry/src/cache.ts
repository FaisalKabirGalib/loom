import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import {
  capabilityCandidateSchema,
  type CapabilityCandidate,
} from "@loom/core";
import { z } from "zod";

import type {
  CapabilityQueryInput,
  PaginatedCapabilityRegistry,
} from "./types.js";
import { capabilityQuerySchema } from "./types.js";

const cacheEnvelopeSchema = z.object({
  version: z.literal(1),
  writtenAt: z.number().int().nonnegative(),
  value: z.unknown(),
});

export interface CacheEnvelope<T> {
  version: 1;
  writtenAt: number;
  value: T;
}

export interface CacheResult<T> {
  value: T | null;
  source: "fresh-cache" | "stale-cache" | "network" | "offline-miss";
}

export interface CacheLoadOptions {
  ttlMs: number;
  offline?: boolean;
  force?: boolean;
}

export const getXdgCacheDirectory = (
  appName = "loom",
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string => {
  const configured = environment.XDG_CACHE_HOME;
  if (configured !== undefined && isAbsolute(configured))
    return join(configured, appName);
  const localAppData = environment.LOCALAPPDATA;
  if (
    process.platform === "win32" &&
    localAppData !== undefined &&
    isAbsolute(localAppData)
  ) {
    return join(localAppData, appName, "cache");
  }
  return join(home, ".cache", appName);
};

export class AtomicTtlCache {
  public constructor(
    public readonly directory = getXdgCacheDirectory(),
    private readonly clock: () => number = Date.now,
  ) {}

  public async read<T>(key: string): Promise<CacheEnvelope<T> | null> {
    try {
      const raw = await readFile(this.pathFor(key), "utf8");
      return cacheEnvelopeSchema.parse(JSON.parse(raw)) as CacheEnvelope<T>;
    } catch (error) {
      if (
        isMissing(error) ||
        error instanceof SyntaxError ||
        error instanceof z.ZodError
      )
        return null;
      throw error;
    }
  }

  public async write<T>(key: string, value: T): Promise<CacheEnvelope<T>> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const envelope: CacheEnvelope<T> = {
      version: 1,
      writtenAt: this.clock(),
      value,
    };
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(envelope)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return envelope;
  }

  public isFresh<T>(entry: CacheEnvelope<T>, ttlMs: number): boolean {
    if (!Number.isFinite(ttlMs) || ttlMs < 0)
      throw new Error("Cache TTL must be a non-negative finite number");
    const age = this.clock() - entry.writtenAt;
    return age >= 0 && age <= ttlMs;
  }

  public async getOrRefresh<T>(
    key: string,
    load: () => Promise<T>,
    options: CacheLoadOptions,
  ): Promise<CacheResult<T>> {
    const cached = await this.read<T>(key);
    if (
      cached !== null &&
      options.force !== true &&
      this.isFresh(cached, options.ttlMs)
    ) {
      return { value: cached.value, source: "fresh-cache" };
    }
    if (options.offline === true) {
      return cached === null
        ? { value: null, source: "offline-miss" }
        : { value: cached.value, source: "stale-cache" };
    }
    try {
      const value = await load();
      await this.write(key, value);
      return { value, source: "network" };
    } catch (error) {
      if (cached !== null)
        return { value: cached.value, source: "stale-cache" };
      throw error;
    }
  }

  public nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  private pathFor(key: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(key))
      throw new Error("Invalid cache key");
    return join(this.directory, `${key}.json`);
  }
}

const isMissing = (error: unknown): boolean =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";

export interface RegistrySnapshot {
  candidates: CapabilityCandidate[];
  syncedAt: string;
  complete: boolean;
  nextCursor?: string;
  queryFingerprint: string;
}

const registrySnapshotSchema = z.object({
  candidates: z.array(capabilityCandidateSchema),
  syncedAt: z.iso.datetime({ offset: true }),
  complete: z.boolean().default(true),
  nextCursor: z.string().optional(),
  queryFingerprint: z.string().default("{}"),
});

export interface RegistrySyncOptions extends CacheLoadOptions {
  incremental?: boolean;
  maxPages?: number;
}

export const syncRegistryCache = async (
  cache: AtomicTtlCache,
  key: string,
  registry: PaginatedCapabilityRegistry,
  query: CapabilityQueryInput = {},
  options: RegistrySyncOptions = { ttlMs: 60 * 60 * 1_000 },
): Promise<CacheResult<RegistrySnapshot>> => {
  const normalizedQuery = capabilityQuerySchema.parse(query);
  const queryFingerprint = registryQueryFingerprint(normalizedQuery);
  const cached = await cache.read<RegistrySnapshot>(key);
  const cachedSnapshot = registrySnapshotSchema.safeParse(cached?.value);
  const shouldRefresh =
    cachedSnapshot.success &&
    (cachedSnapshot.data.queryFingerprint !== queryFingerprint ||
      !cachedSnapshot.data.complete);

  return cache.getOrRefresh(
    key,
    async () => {
      const previousEnvelope = await cache.read<RegistrySnapshot>(key);
      const previous =
        previousEnvelope === null
          ? null
          : registrySnapshotSchema.safeParse(previousEnvelope.value);
      const prior = previous?.success === true ? previous.data : null;
      const compatible = prior?.queryFingerprint === queryFingerprint;
      const resuming =
        compatible &&
        prior?.complete === false &&
        prior.nextCursor !== undefined;
      const incremental =
        compatible &&
        !resuming &&
        options.incremental !== false &&
        prior !== null;
      const candidates = new Map<string, CapabilityCandidate>();
      if ((incremental || resuming) && prior !== null) {
        for (const candidate of prior.candidates)
          candidates.set(
            candidateKey(candidate, normalizedQuery.version === "latest"),
            candidate,
          );
      }
      let cursor = resuming ? prior.nextCursor : undefined;
      let pageCount = 0;
      const seenCursors = new Set<string>();
      do {
        pageCount += 1;
        const page = await registry.searchPage({
          ...normalizedQuery,
          ...(incremental && prior !== null
            ? { updatedSince: prior.syncedAt, includeDeleted: true }
            : {}),
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const candidate of page.candidates) {
          const key = candidateKey(
            candidate,
            normalizedQuery.version === "latest",
          );
          if (isDeleted(candidate)) candidates.delete(key);
          else candidates.set(key, candidate);
        }
        cursor = page.nextCursor;
        if (cursor !== undefined && seenCursors.has(cursor))
          throw new Error("Registry returned a repeated cursor");
        if (cursor !== undefined) seenCursors.add(cursor);
      } while (cursor !== undefined && pageCount < (options.maxPages ?? 100));
      return {
        candidates: [...candidates.values()],
        syncedAt: cache.nowIso(),
        complete: cursor === undefined,
        ...(cursor === undefined ? {} : { nextCursor: cursor }),
        queryFingerprint,
      };
    },
    { ...options, force: options.force === true || shouldRefresh },
  );
};

const candidateKey = (
  candidate: CapabilityCandidate,
  latestOnly = false,
): string =>
  latestOnly ? candidate.id : `${candidate.id}@${candidate.version ?? ""}`;

export const registryQueryFingerprint = (
  query: CapabilityQueryInput,
): string => {
  const normalized = capabilityQuerySchema.parse(query);
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(normalized)
        .filter(([key]) => key !== "cursor")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [
          key,
          Array.isArray(value) ? [...value].sort() : value,
        ]),
    ),
  );
};

const isDeleted = (candidate: CapabilityCandidate): boolean =>
  candidate.trustTier === "blocked" &&
  candidate.notes.some(
    (note) => note.toLowerCase() === "registry status: deleted",
  );
