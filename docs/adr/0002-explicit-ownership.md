# ADR 0002: Explicit Ownership

- Status: Accepted
- Decision: Record each adapter's exact files, hashes, and owned config regions
  in `.loom/ownership.json`; mutate or remove only matching owned content.
- Rationale: Brownfield harness files and user skills are authoritative and must
  survive Loom apply, reapply, and removal.
- Consequences: Collisions and user modifications stop mutation; dry-run and
  concurrent-change checks are first-class; identical shared skills can be owned
  by both harnesses without premature deletion.

Implementations:
[`integrations/opencode`](../../integrations/opencode/src/index.ts) and
[`integrations/codex`](../../integrations/codex/src/index.ts),
[`integrations/claude`](../../integrations/claude/src/index.ts),
[`integrations/omp`](../../integrations/omp/src/index.ts), and
[`integrations/antigravity`](../../integrations/antigravity/src/index.ts).
