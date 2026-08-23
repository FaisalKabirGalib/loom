# ADR 0001: Minimum Capability Resolver

- Status: Accepted
- Decision: Select the lowest-cost set covering required capabilities after
  scoring and policy filtering. Use bounded exact set cover, then deterministic
  greedy fallback.
- Rationale: Fewer overlapping tools reduce privilege, runtime complexity, and
  model context cost while retaining explicit uncovered requirements.
- Consequences: Useful-only candidates are not selected; ties are deterministic;
  plans explain rejection, overlap, approval, and uncovered capability state.

Implementation:
[`packages/core/src/resolver.ts`](../../packages/core/src/resolver.ts).
