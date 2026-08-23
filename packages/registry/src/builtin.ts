import type { CapabilityCandidate, TrustTier } from "@loom/core";

import { BUILTIN_CATALOG } from "./catalog.js";
import {
  capabilityQuerySchema,
  type CapabilityQueryInput,
  type CapabilityRegistry,
} from "./types.js";

const trustRank: Record<TrustTier, number> = {
  blocked: 0,
  experimental: 1,
  community: 2,
  "community-reviewed": 3,
  "verified-maintainer": 4,
  official: 5,
};

export class BuiltinRegistry implements CapabilityRegistry {
  public readonly id = "builtin";

  public constructor(
    private readonly catalog: readonly CapabilityCandidate[] = BUILTIN_CATALOG,
  ) {}

  public async search(
    queryInput: CapabilityQueryInput,
  ): Promise<CapabilityCandidate[]> {
    const query = capabilityQuerySchema.parse(queryInput);
    const text = query.text?.toLowerCase();
    const minimum =
      query.minTrustTier === undefined ? 0 : trustRank[query.minTrustTier];
    return this.catalog
      .filter((candidate) => {
        const searchable = [
          candidate.name,
          candidate.id,
          ...candidate.tags,
          ...candidate.taskTriggers,
        ]
          .join(" ")
          .toLowerCase();
        return (
          (text === undefined || searchable.includes(text)) &&
          query.provides.every((capability) =>
            candidate.provides.includes(capability),
          ) &&
          query.ecosystems.every((ecosystem) =>
            candidate.ecosystems.includes(ecosystem),
          ) &&
          (query.kinds.length === 0 || query.kinds.includes(candidate.kind)) &&
          trustRank[candidate.trustTier] >= minimum &&
          (query.version === undefined || candidate.version === query.version)
        );
      })
      .slice(0, query.limit);
  }

  public async resolve(
    id: string,
    version?: string,
  ): Promise<CapabilityCandidate | null> {
    const normalized = id.toLowerCase();
    return (
      this.catalog.find(
        (candidate) =>
          (candidate.id.toLowerCase() === normalized ||
            candidate.name.toLowerCase() === normalized) &&
          (version === undefined || candidate.version === version),
      ) ?? null
    );
  }
}
