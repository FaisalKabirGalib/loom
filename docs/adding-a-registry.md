# Adding a Registry

Registries supply normalized metadata for discovery and resolution. They must
not install or execute a candidate.

1. Implement [`CapabilityRegistry`](../packages/registry/src/types.ts) with a
   stable `id`, `search`, and `resolve`. Implement `PaginatedCapabilityRegistry`
   only when cache synchronization needs pages.
2. Parse query input with `capabilityQuerySchema` and validate all remote output
   before normalizing it with `capabilityCandidateSchema`.
3. Populate conservative permissions, provenance, trust, scope, context cost,
   and notes. Registry publication or repository popularity alone is not an
   endorsement.
4. Export the adapter from
   [`packages/registry/src/index.ts`](../packages/registry/src/index.ts).
5. Wire it only into the intended path: `planProject` registries are injectable,
   MCP network registries are explicitly opt-in, and CLI discovery has explicit
   source choices. Do not silently expand default network access.
6. Add tests for request validation, normalization, failure behavior, and
   pagination/cache semantics as applicable, then run `pnpm verify`.

The built-in registry is the default planner source. Existing network adapters
are the Official MCP Registry, GitHub provenance fallback, and `skills` CLI
discovery. [`AtomicTtlCache`](../packages/registry/src/cache.ts) provides atomic
TTL, stale fallback, offline, incremental pagination, deletion, and repeated
cursor handling for paginated sources.

No registry is connected to harness apply. Adding one must not create an
automatic installation path unless a separately reviewed immutable typed recipe
and constrained installer are implemented.
