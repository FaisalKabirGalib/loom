# Loom Codebase Guide

## What Loom Does

Loom inspects a project, resolves the smallest reproducible set of agent
capabilities that covers its needs, and safely projects Loom's MCP server and
skills into supported coding-agent harnesses.

The main design constraints are deterministic planning, no automatic external
installation, exact version locking, structural config edits, and explicit
ownership of every mutation.

## Repository Map

| Path                       | Purpose                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `packages/core`            | Domain schemas, detection, task classification, scoring, policy, resolution, locks, paths, and harness contracts. |
| `packages/profiles`        | Converts detected stacks into required and useful capability requirements.                                        |
| `packages/registry`        | Built-in catalog, remote MCP/skill discovery, cache, and project planning orchestration.                          |
| `packages/installers`      | Audited external recipes, staging, activation, ownership, verification, and rollback.                             |
| `packages/cli`             | User-facing commands, output, state persistence, and harness selection.                                           |
| `packages/mcp`             | Read-only stdio MCP server exposing Loom's nine tools.                                                            |
| `packages/skills`          | Eight canonical, instruction-only Loom skills.                                                                    |
| `integrations/opencode`    | OpenCode config, plugin, skill, ownership, and uninstall adapter.                                                 |
| `integrations/codex`       | Codex TOML, skill, ownership, and uninstall adapter.                                                              |
| `integrations/claude`      | Claude Code MCP JSON, skill, ownership, and uninstall adapter.                                                    |
| `integrations/omp`         | Oh My Pi MCP JSON, skill, ownership, and uninstall adapter.                                                       |
| `integrations/antigravity` | Antigravity MCP JSON, shared-skill, ownership, and uninstall adapter.                                             |
| `fixtures`                 | Representative project stacks used by detection and planning tests.                                               |
| `tests`                    | Cross-package fixture and planning tests.                                                                         |
| `docs/adr`                 | Decisions that define reproducibility, ownership, integration boundaries, and discovery behavior.                 |

## Execution Flow

1. `detectProject` in `packages/core/src/detection.ts` scans bounded project
   evidence and produces a normalized `ProjectProfile`.
2. `composeProfiles` in `packages/profiles/src/index.ts` maps that profile to
   required and useful capabilities.
3. `classifyTask` adds task-specific intent and risk requirements.
4. `planProject` in `packages/registry/src/planner.ts` combines built-in or
   discovered candidates, applies policy, scores candidates, and invokes the
   minimum-set resolver.
5. The selected `HarnessAdapter` inspects existing project config and returns a
   guarded mutation plan.
6. `loom apply` validates approvals and exact versions, applies the plan, then
   writes project, workflow, lock, and ownership state under `.loom/`.
7. `loom doctor` verifies owned files and config pointers. `loom remove` removes
   only unchanged Loom-owned content.

## Core Concepts

### Capabilities

Capabilities are stable semantic requirements such as project detection,
semantic search, browser automation, or database tooling. Profiles require
capabilities; candidates provide them. See `packages/core/src/capabilities.ts`
and `docs/capability-model.md`.

### Candidates And Resolution

Candidates come from the built-in catalog or explicit remote discovery. Scoring
is deterministic and explainable. Policy can reject candidates before the
resolver selects a minimum covering set. Remote results are recommendations and
are never installed automatically.

### Harness Adapters

Every adapter implements `HarnessAdapter` from `packages/core/src/harness.ts`.
The lifecycle is:

1. `inspect(root)` reads current harness and ownership state.
2. `plan(root, capabilityPlan)` creates expected-hash mutations.
3. `apply(root, plan, dryRun)` accepts only a plan issued by that adapter
   instance, checks concurrent changes, and rolls back partial failures.
4. `verify(root)` reports missing or modified owned resources.
5. `uninstall(root, dryRun)` removes only content that still matches ownership.

Do not bypass ownership checks or replace whole brownfield config files.

### Shared Skills

OpenCode, Codex, and Antigravity use `.agents/skills`. Their ownership records
may refer to the same identical skill files, so removing one harness must retain
skills still owned by another. Claude Code uses `.claude/skills`; OMP uses
`.omp/skills`.

### Project State

Loom writes schema-versioned state under `.loom/`:

| File                     | Contents                                                      |
| ------------------------ | ------------------------------------------------------------- |
| `project.json`           | Last detected project profile.                                |
| `workflow.json`          | Per-harness task, selections, and approvals.                  |
| `capabilities.lock.json` | Exact selected versions and per-harness lock state.           |
| `ownership.json`         | Owned files, hashes, and config pointers.                     |
| `policy.toml`            | Optional project policy layered over user and default policy. |

## CLI And MCP

The CLI entry point is `packages/cli/src/index.ts`. OpenCode is the default
harness; `--harness` also accepts `codex`, `claude`, `omp`, and `antigravity`.

```sh
pnpm install
pnpm build
node packages/cli/dist/index.js detect
node packages/cli/dist/index.js plan --task "review this project"
node packages/cli/dist/index.js apply --dry-run --harness opencode
node packages/cli/dist/index.js doctor --harness opencode
```

`loom mcp` starts the stdio server in `packages/mcp/src/server.ts`. It exposes
exactly nine read-only tools for project detection, planning, setup
recommendation, explanation, capability search/resolution/status, workflow
status, and diagnostics.

## Development Workflow

The workspace requires Node.js 22 or newer and pnpm 11.22.0.

```sh
pnpm verify
```

This runs Prettier checks, Oxlint with warnings denied, TypeScript project
references, a production build, and the Vitest suite. Run a focused test with:

```sh
pnpm exec vitest run packages/core/src/detection.test.ts
```

`pnpm build:binaries` creates standalone cross-platform executables and
`SHA256SUMS` under the ignored `release/` directory. Tagged `v*` pushes run the
release workflow in `.github/workflows/release.yml`.

The preferred project flow is `loom connect --harness opencode`, followed by a
host-LLM call to `loom_setup_recommend` and one returned
`loom setup --intent ...` command. The CLI, never the LLM or MCP server, owns
installation and mutation authority.

## Common Changes

### Add A Capability

1. Add the stable capability ID in `packages/core/src/capabilities.ts`.
2. Map relevant stacks in `packages/profiles`.
3. Add or update candidates in `packages/registry/src/catalog.ts`.
4. Add resolver and fixture coverage.

### Add A Harness

1. Implement the `HarnessAdapter` contract under `integrations/<harness>`.
2. Use only documented project-local config and skill surfaces.
3. Add strict path allowlists, symlink rejection, expected hashes, rollback,
   idempotence, collision handling, and safe uninstall tests.
4. Add the package to TypeScript references and CLI dispatch.
5. Add CLI lifecycle and shared-ownership tests where applicable.

### Add A Registry

1. Implement the registry contract in `packages/registry`.
2. Bound network/process output and enforce timeouts.
3. Preserve provenance and exact versions.
4. Add mocked contract tests before live smoke testing.

## Areas To Read Carefully

- `packages/core/src/resolver.ts`: minimum-set selection and uncovered
  requirements.
- `packages/core/src/detection.ts`: bounded scanning and declared-workspace
  aggregation.
- `packages/registry/src/cache.ts`: resumable pagination, query fingerprints,
  TTL, and offline fallback.
- `packages/cli/src/index.ts`: mutation approval, lock persistence, and
  multi-harness state cleanup.
- `integrations/*/src/index.ts`: security-sensitive filesystem mutations,
  ownership interoperability, rollback, and surgical removal.

## Recommended Reading Order

1. `README.md`
2. `docs/architecture.md`
3. `packages/core/src/harness.ts`
4. `packages/core/src/detection.ts`
5. `packages/registry/src/planner.ts`
6. `packages/cli/src/index.ts`
7. One adapter under `integrations/`
8. `packages/mcp/src/server.ts`
9. `docs/adr/`
