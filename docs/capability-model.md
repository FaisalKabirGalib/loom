# Capability Model

A capability is a normalized feature such as `DOCS.framework-docs` or
`UI.browser-test`, not an installed package. The complete grouped vocabulary is
defined in
[`packages/core/src/capabilities.ts`](../packages/core/src/capabilities.ts) and
printed by `loom capabilities`.

## Candidate

[`capabilityCandidateSchema`](../packages/core/src/domain.ts) records:

- identity, kind (`mcp`, `skill`, `plugin`, `cli`, or `framework-tool`), source,
  and optional exact version
- ecosystems, provided capabilities, tags, task triggers, and overlap groups
- transport/runtime metadata
- filesystem, shell, network, secret, database, and device permissions
- provenance, trust tier, recommended scope, context cost, and portability

Candidates come from the built-in catalog or a registry. Catalog entries are
metadata used for resolution; they are not proof that a tool is installed or
that a live service is available.

## Detection and task inputs

Project detection produces languages, frameworks, package managers,
dependencies, services, monorepo status, existing agent config, and evidence
signals. A directory with a recognized manifest or source file is brownfield;
otherwise it is greenfield.

Profiles contribute required and useful capabilities. Task classification adds
intents and useful capabilities and classifies risk as low, medium, or high.
Only required capabilities must be covered by the resolver.

## Score and policy

[`scoreCapability`](../packages/core/src/scoring.ts) combines task fit, project
fit, coverage, maintenance, provenance, security, context efficiency, and
portability. It subtracts explicit penalties for risks such as stale metadata,
write/shell access, provenance mismatch, large tool surfaces, and unsafe
installer signals.

[`evaluatePolicy`](../packages/core/src/policy.ts) then allows, blocks, or
requires approval. Defaults block remote MCP and MCP shell execution, cap
database access at read, require review for skill scripts, require a score of
50, and accept trust tier `community` or higher.

## Resolution and lock

The resolver filters blocked and below-score candidates, then finds a minimal
set covering required capabilities. It uses exact set cover for at most 20
useful candidates and 100,000 search nodes; otherwise it uses a deterministic
greedy fallback. Cost includes count, permissions, context, runtime, score, and
overlap. Duplicate coverage is rejected with an explanation; unrelated eligible
entries remain optional.

The lock contains only selected candidates with an exact version or revision.
After policy and any explicit approval checks pass, CLI state marks selected
entries `approved`; it does not install external candidates. See
[ADR 0001](adr/0001-minimum-capability-resolver.md).
