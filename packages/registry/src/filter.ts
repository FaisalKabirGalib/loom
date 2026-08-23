import type { CapabilityCandidate, TrustTier } from "@loom/core";

import type { CapabilityQuery } from "./types.js";

const TRUST_RANK: Record<TrustTier, number> = {
  blocked: 0,
  experimental: 1,
  community: 2,
  "community-reviewed": 3,
  "verified-maintainer": 4,
  official: 5,
};

export function matchesCapabilityQuery(
  candidate: CapabilityCandidate,
  query: CapabilityQuery,
): boolean {
  return (
    query.provides.every((capability) =>
      candidate.provides.includes(capability),
    ) &&
    query.ecosystems.every((ecosystem) =>
      candidate.ecosystems.includes(ecosystem),
    ) &&
    (query.kinds.length === 0 || query.kinds.includes(candidate.kind)) &&
    (query.minTrustTier === undefined ||
      TRUST_RANK[candidate.trustTier] >= TRUST_RANK[query.minTrustTier]) &&
    (query.version === undefined ||
      query.version === "latest" ||
      candidate.version === query.version)
  );
}
