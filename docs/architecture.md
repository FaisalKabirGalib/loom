# Architecture

Loom is a private pnpm workspace with a TypeScript project-reference build. The
CLI composes project detection, profiles, registries, resolution, MCP, and
harness adapters; dependencies flow toward `@loom/core`.

## Packages

| Path                                                                   | Responsibility                                                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [`packages/core`](../packages/core/src/index.ts)                       | Domain schemas, detection, task classification, scoring, policy, resolver, locks, paths, and harness contracts. |
| [`packages/profiles`](../packages/profiles/src/index.ts)               | Maps detected stacks to required and useful capabilities.                                                       |
| [`packages/registry`](../packages/registry/src/index.ts)               | Built-in catalog, registry contracts, remote discovery adapters, cache, and project planner.                    |
| [`packages/mcp`](../packages/mcp/src/server.ts)                        | Read-only stdio MCP server exposing eight tools.                                                                |
| [`packages/cli`](../packages/cli/src/index.ts)                         | User commands, output, state persistence, and adapter selection.                                                |
| [`packages/skills`](../packages/skills)                                | Canonical harness-neutral, instruction-only Loom skills.                                                        |
| [`integrations/opencode`](../integrations/opencode/src/index.ts)       | OpenCode config/plugin/skill projection and ownership.                                                          |
| [`integrations/codex`](../integrations/codex/src/index.ts)             | Codex managed TOML block/skill projection and ownership.                                                        |
| [`integrations/claude`](../integrations/claude/src/index.ts)           | Claude Code MCP JSON/skill projection and ownership.                                                            |
| [`integrations/omp`](../integrations/omp/src/index.ts)                 | Oh My Pi MCP JSON/skill projection and ownership.                                                               |
| [`integrations/antigravity`](../integrations/antigravity/src/index.ts) | Antigravity MCP JSON/shared-skill projection and ownership.                                                     |

## Planning flow

1. [`detectProject`](../packages/core/src/detection.ts) scans bounded project
   evidence and labels the directory `greenfield` or `brownfield`.
2. [`composeProfiles`](../packages/profiles/src/index.ts) adds stack-specific
   required and useful capabilities.
3. [`classifyTask`](../packages/core/src/task.ts) infers intents and risk from
   an optional task. Brownfield projects add semantic search as useful context;
   monorepos add impact analysis.
4. [`planProject`](../packages/registry/src/planner.ts) queries registries,
   deduplicates candidates by ID, scores them, applies policy, and resolves a
   minimal set covering required capabilities.
5. The selected harness adapter plans guarded file mutations. `apply` persists
   project/workflow/lock state only after a successful non-dry-run mutation.

CLI planning uses only the built-in catalog. Network-backed sources are used by
explicit discovery/cache commands; MCP tools use them only when
`networkDiscovery: true`.

## State and paths

Project state uses `.loom/` with schema version 1:

- `project.json`: detected project profile
- `workflow.json`: per-harness task, selections, and supplied approvals
- `capabilities.lock.json`: per-harness and combined entries with exact versions
- `ownership.json`: adapter-owned files, hashes, and config regions
- `policy.toml`: project policy layered over user preferences and defaults

[`resolveLoomPaths`](../packages/core/src/paths.ts) defines user config, cache,
and state roots under XDG directories, with home-directory fallbacks. Registry
cache operations currently use the XDG cache path.

## Supported integration boundary

OpenCode, Codex, Claude Code, OMP, and Antigravity adapters implement the
[`HarnessAdapter`](../packages/core/src/harness.ts) contract. See
[ADR 0003](adr/0003-harness-integration.md) and
[harness compatibility](harness-compatibility.md).
