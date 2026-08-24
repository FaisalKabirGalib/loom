# Loom Codebase Guide

Use this document as the index for learning and navigating Loom. It starts with
the system in plain language, follows the important runtime flows, and then maps
common changes to the files and tests involved.

## Start Here

Loom helps a coding agent understand what tools a project needs and connect
those tools safely.

Given a project directory, Loom:

1. Detects the languages, frameworks, services, workspace structure, and
   existing agent configuration.
2. Converts that evidence and an optional task into semantic requirements called
   capabilities.
3. Scores available candidates, rejects candidates that violate policy, and
   attempts to select a small set covering the required capabilities while
   reporting anything left uncovered.
4. Connects Loom's read-only MCP server and instruction-only skills to a
   supported coding-agent harness.
5. For an audited setup recipe, revalidates the recommendation and performs a
   reviewed, version-bound, reversible installation.

The most important boundary is:

- The MCP server may inspect, plan, explain, and recommend.
- Only the CLI may modify harness configuration or install an audited recipe.

Start with [`README.md`](../README.md) for user-facing behavior and
[`architecture.md`](architecture.md) for the short architectural summary. Use
this guide when you need to find the implementation behind either document.

## Vocabulary

| Term              | Meaning                                                                                             | Source of truth                                  |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Project profile   | Normalized evidence about the inspected repository.                                                 | `packages/core/src/domain.ts`                    |
| Capability        | A stable semantic need such as `DOCS.framework-docs` or `UI.browser-test`.                          | `packages/core/src/capabilities.ts`              |
| Candidate         | An MCP, skill, plugin, CLI, or framework tool that provides capabilities and may declare a version. | `packages/core/src/domain.ts`                    |
| Task profile      | Intents, risk, and capabilities inferred from optional task text.                                   | `packages/core/src/task.ts`                      |
| Capability plan   | Selected, optional, rejected, uncovered, and approval-required candidates.                          | `packages/core/src/domain.ts`                    |
| Harness           | A supported coding-agent host: OpenCode, Codex, Claude Code, OMP, or Antigravity.                   | `packages/core/src/harness.ts`                   |
| Adapter plan      | A guarded set of project-local config and file mutations for one harness.                           | `packages/core/src/harness.ts`                   |
| Recipe            | An audited, immutable description of an allowed external installation.                              | `packages/core/src/setup.ts`                     |
| Lock              | Accepted non-range versions or revisions and lifecycle state for selected candidates.               | `packages/core/src/lock.ts`                      |
| Ownership         | Hashes and config pointers proving which resources Loom may later update or remove.                 | Harness adapters and `.loom/ownership.json`      |
| Intent token      | An untrusted, project-bound recommendation passed from the host LLM back to the CLI.                | `packages/core/src/setup.ts`                     |
| Setup transaction | Durable progress and receipts used to verify, recover, or roll back an external setup operation.    | `packages/core/src/setup.ts`, `packages/cli/src` |

Capabilities are not packages. Profiles ask for capabilities; candidates claim
to provide them. The resolver chooses candidates only after scoring and policy
evaluation. See [`capability-model.md`](capability-model.md) for the complete
model.

## Architecture At A Glance

Loom is a private pnpm workspace written in strict TypeScript and built with
TypeScript project references. Arrows below point from a consumer to its
workspace dependency:

```text
packages/cli
  -> core, profiles, registry, installers, mcp, skills, integrations/*

packages/mcp
  -> core, profiles, registry

packages/registry
  -> core, profiles

packages/profiles -> core
integrations/*    -> core
packages/installers has no Loom workspace dependency
```

The CLI is the composition root. It combines core behavior, profiles,
registries, installers, MCP, and all harness adapters. The MCP package exposes a
strict read-only interface over project detection and planning. Integrations own
Loom's harness connection edits; audited installers may separately patch harness
configuration needed to activate an external capability.

[`tsconfig.json`](../tsconfig.json) lists the root project references;
TypeScript derives build order from their dependency references.
[`pnpm-workspace.yaml`](../pnpm-workspace.yaml) includes every package under
`packages/*` and `integrations/*`.

## Repository Map

| Path                       | Purpose                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/core`            | Domain schemas, detection, task classification, scoring, policy, resolution, locks, setup, paths, and contracts. |
| `packages/profiles`        | Converts detected stacks into required and useful capability requirements.                                       |
| `packages/registry`        | Built-in catalog, remote discovery adapters, cache, and project planning orchestration.                          |
| `packages/installers`      | Audited external recipes, staging, activation, ownership, verification, and rollback.                            |
| `packages/cli`             | Commands, terminal/JSON output, setup authority, state persistence, and adapter selection.                       |
| `packages/mcp`             | Read-only stdio MCP server and its nine tool handlers.                                                           |
| `packages/skills`          | Eight canonical, harness-neutral, instruction-only Loom skills.                                                  |
| `integrations/opencode`    | OpenCode JSON/JSONC config, plugin, skills, ownership, and uninstall behavior.                                   |
| `integrations/codex`       | Codex managed TOML block, skills, ownership, and uninstall behavior.                                             |
| `integrations/claude`      | Claude Code MCP JSON, native skills, ownership, and uninstall behavior.                                          |
| `integrations/omp`         | Oh My Pi MCP JSON, native skills, ownership, and uninstall behavior.                                             |
| `integrations/antigravity` | Antigravity MCP JSON, shared skills, ownership, and uninstall behavior.                                          |
| `fixtures`                 | Small representative projects used by detection and planning tests.                                              |
| `tests`                    | Cross-package fixture and planning tests.                                                                        |
| `docs`                     | Concept guides, extension guides, security constraints, compatibility notes, and ADRs.                           |
| `scripts`                  | Standalone binary entry point and cross-platform release builder.                                                |
| `.github/workflows`        | Tagged release build, verification, and publication.                                                             |

Normally edit `src/`, tests, docs, fixtures, or skill sources. Do not treat
these as primary source:

| Path                | Why                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `**/dist`           | Generated TypeScript build output.                                                        |
| `release`           | Ignored binaries and checksums produced by `pnpm build:binaries`.                         |
| `.loom`             | Runtime state produced while dogfooding Loom in this checkout.                            |
| `.agents`, `.codex` | Local/generated harness projections; inspect carefully before assuming they are fixtures. |
| `fixtures/**/dist`  | Fixture content only, if present; it does not implement Loom.                             |

## Main Runtime Flows

### 1. Project Planning

This is the central read-only flow:

```text
project directory
  -> detectProject
  -> composeProfiles
  -> classifyTask
  -> registry search and deduplication
  -> scoreCapabilities
  -> evaluatePolicy inside resolution
  -> resolveCapabilities
  -> ProjectResolution
```

1. `detectProject` in `packages/core/src/detection.ts` performs a bounded scan
   and returns a validated `ProjectProfile`.
2. `composeProfiles` in `packages/profiles/src/index.ts` maps detected
   ecosystems to required and useful capabilities.
3. `classifyTask` in `packages/core/src/task.ts` adds task intent, risk, and
   task-specific capabilities.
4. `planProject` in `packages/registry/src/planner.ts` searches the built-in
   registry by default. Injected remote registries receive a bounded set of
   discovery terms.
5. `scoreCapabilities` in `packages/core/src/scoring.ts` computes explainable
   task fit, project fit, coverage, maintenance, provenance, security, context
   efficiency, and portability scores.
6. `resolveCapabilities` in `packages/core/src/resolver.ts` applies policy and
   finds a minimum-cost covering set. It uses exact set cover for small inputs
   and a deterministic greedy fallback for larger inputs.
7. `createCapabilityLock` in `packages/core/src/lock.ts` can lock only
   candidates with a present, non-range version or revision string.

Only required capabilities must be covered. Useful capabilities influence the
plan but may remain optional. Blocked candidates never reach selection.

### 2. Connect And Apply

Every harness adapter implements the contract in `packages/core/src/harness.ts`:

```text
inspect -> planInstall -> apply -> verify -> uninstallOwned
```

The exact method names are defined by `HarnessAdapter`; conceptually the stages
are:

1. Inspect existing harness configuration and Loom ownership records.
2. Produce an expected-hash mutation plan without changing files.
3. Reject forged plans, unsafe paths, symlinks, collisions, or concurrent edits.
4. Apply structural config edits and file writes atomically.
5. Roll back earlier writes if a later mutation fails.
6. Verify that every owned file and config pointer has the expected value.
7. Persist project, workflow, lock, and ownership state under `.loom/`.

`connect` projects Loom MCP, bundled skills, and any harness-specific support
artifact such as the OpenCode plugin. `apply` additionally records the resolved
capability plan, but unresolved catalog recommendations are not equivalent to
installed software.

OpenCode, Codex, and Antigravity share `.agents/skills`. Claude Code uses
`.claude/skills`; OMP uses `.omp/skills`. Shared ownership prevents removing one
harness from deleting identical skill files still used by another harness.

### 3. LLM-Assisted Setup

The setup path deliberately separates recommendation from execution:

```text
host LLM
  -> loom_skill_search MCP tool
  -> select exact relevant skills with reasons
  -> loom_setup_recommend MCP tool
  -> loom1_... intent token
  -> loom setup --intent <token>
  -> project, policy, capability, executable, and recipe revalidation
  -> authenticated approval
  -> durable setup transaction
  -> external installer apply
  -> harness adapter apply
  -> verify both sides
  -> commit state or roll back
```

`createLoomToolHandlers` in `packages/mcp/src/handlers.ts` creates the intent.
`setupCommand` in `packages/cli/src/index.ts` treats that intent as untrusted
and recomputes all authoritative data. Schemas, canonical JSON, hashes, intents,
plans, approvals, and transaction state live in `packages/core/src/setup.ts`.

The currently audited external recipe is `FLUTTER_PACKAGE_INTELLIGENCE_RECIPE`
in `packages/installers/src/index.ts`. It binds exact `dart_pubdev_mcp` and
`skills` versions in an isolated project-local Dart package, plus only the
package or registry skills explicitly selected by the host LLM. Package skills
are bound to the project lockfile and content hashes; registry skills are bound
to exact commits and content hashes. The old fixed Flutter skill recipe is
recognized only for safe migration or removal. A candidate without an audited
typed recipe remains only a recommendation.

### 4. MCP Requests

`loom mcp` dispatches from `packages/cli/src/index.ts` to `runLoomMcpServer` in
`packages/mcp/src/server.ts`. The server uses stdio and registers exactly these
tools:

| Tool                      | Purpose                                                     |
| ------------------------- | ----------------------------------------------------------- |
| `loom_project_detect`     | Return the normalized project profile.                      |
| `loom_project_plan`       | Resolve a capability plan.                                  |
| `loom_skill_search`       | Search locked package and pinned registry skills.           |
| `loom_explain`            | Explain selections and rejections.                          |
| `loom_capability_search`  | Search candidates.                                          |
| `loom_capability_resolve` | Resolve supplied capability needs.                          |
| `loom_capability_status`  | Read persisted capability state safely.                     |
| `loom_workflow_status`    | Read persisted workflow state safely.                       |
| `loom_doctor`             | Return diagnostics.                                         |
| `loom_setup_recommend`    | Return one project-bound setup intent, not executable text. |

Schemas and behavior are in `packages/mcp/src/handlers.ts`; SDK registration and
stdio transport are in `packages/mcp/src/server.ts`. Network discovery is
opt-in. State reads reject symlinks, escapes, non-regular files, and oversized
files; returned data is redacted for secret-shaped content.

### 5. Remove, Rollback, And Recovery

`remove` asks a harness adapter to delete only unchanged resources recorded as
owned by that harness. Modified files or config values are preserved and
reported rather than overwritten.

Setup rollback is separate. It removes only external resources owned by the
specified setup transaction and retains the Loom connection. `recover` uses
durable transaction state to roll back an interrupted operation. The command
orchestration is in `packages/cli/src/index.ts`; installer ownership and
receipts are implemented in `packages/installers/src/index.ts`.

## File Index

### Core Domain

| File                                | Read it for                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/core/src/domain.ts`       | Zod schemas and TypeScript types shared across the system.                          |
| `packages/core/src/capabilities.ts` | The complete grouped capability vocabulary.                                         |
| `packages/core/src/constants.ts`    | State filenames, schema versions, and shared constants.                             |
| `packages/core/src/detection.ts`    | Bounded filesystem scanning and ecosystem/workspace evidence rules.                 |
| `packages/core/src/task.ts`         | Task keyword classification, inferred intent, capabilities, and risk.               |
| `packages/core/src/scoring.ts`      | Candidate score components and penalties.                                           |
| `packages/core/src/policy.ts`       | Default policy, TOML parsing, policy layering, and candidate decisions.             |
| `packages/core/src/resolver.ts`     | Exact/greedy minimum-cover selection and rejection explanations.                    |
| `packages/core/src/lock.ts`         | Non-range version/revision lock creation and validation.                            |
| `packages/core/src/harness.ts`      | Harness adapter contract and mutation/ownership types.                              |
| `packages/core/src/setup.ts`        | Setup intent, recipe, approval, plan, transaction schemas, and cryptographic binds. |
| `packages/core/src/state.ts`        | Persisted project/workflow schemas.                                                 |
| `packages/core/src/paths.ts`        | Project and XDG user config/cache/state path resolution.                            |
| `packages/core/src/io.ts`           | Safe low-level state I/O helpers.                                                   |
| `packages/core/src/safety.ts`       | Redaction and safety helpers used at trust boundaries.                              |
| `packages/core/src/index.ts`        | Public package exports.                                                             |

### Profiles And Registry

| File                                    | Read it for                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `packages/profiles/src/index.ts`        | Stack-to-capability mappings and profile composition.                       |
| `packages/registry/src/planner.ts`      | End-to-end planning orchestration.                                          |
| `packages/registry/src/catalog.ts`      | Built-in normalized candidate metadata.                                     |
| `packages/registry/src/builtin.ts`      | Built-in registry implementation.                                           |
| `packages/registry/src/types.ts`        | Registry interfaces and search contracts.                                   |
| `packages/registry/src/official-mcp.ts` | Official MCP Registry adapter.                                              |
| `packages/registry/src/github.ts`       | GitHub provenance discovery adapter.                                        |
| `packages/registry/src/skills-cli.ts`   | Pinned `skills` CLI discovery adapter.                                      |
| `packages/registry/src/cache.ts`        | Atomic TTL cache, resumable pagination, fingerprints, and offline behavior. |
| `packages/registry/src/filter.ts`       | Candidate filtering helpers.                                                |
| `packages/registry/src/inference.ts`    | Normalization and inference for discovered metadata.                        |
| `packages/registry/src/http.ts`         | Bounded HTTP behavior.                                                      |
| `packages/registry/src/process.ts`      | Bounded external process behavior.                                          |
| `packages/registry/src/index.ts`        | Public package exports.                                                     |

### Interfaces And Mutation

| File                                    | Read it for                                                             |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `packages/cli/src/index.ts`             | Argument parsing, command dispatch, setup authority, output, and state. |
| `packages/mcp/src/server.ts`            | MCP server construction, tool registration, and stdio startup.          |
| `packages/mcp/src/handlers.ts`          | Tool input schemas and read-only request behavior.                      |
| `packages/installers/src/index.ts`      | Audited recipe and transactional external installer.                    |
| `integrations/opencode/src/index.ts`    | JSON/JSONC patching, plugin projection, and shared skills.              |
| `integrations/codex/src/index.ts`       | Managed TOML block and shared skills.                                   |
| `integrations/claude/src/index.ts`      | `.mcp.json` patching and Claude-native skills.                          |
| `integrations/omp/src/index.ts`         | OMP MCP JSON patching and OMP-native skills.                            |
| `integrations/antigravity/src/index.ts` | Agent MCP JSON patching and shared skills.                              |
| `scripts/standalone.ts`                 | Standalone binary entry and embedded skill runtime.                     |
| `scripts/build-binaries.ts`             | Bun compilation targets and checksum generation.                        |

### Documentation

| Document                                               | Question it answers                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| [`architecture.md`](architecture.md)                   | What are the major packages and planning stages?                      |
| [`capability-model.md`](capability-model.md)           | How are capabilities, candidates, scores, policy, and locks modeled?  |
| [`security.md`](security.md)                           | Which trust boundaries and mutation invariants must be preserved?     |
| [`mcp-resolution.md`](mcp-resolution.md)               | How does MCP candidate discovery and resolution work?                 |
| [`skill-resolution.md`](skill-resolution.md)           | How are skills represented and projected?                             |
| [`harness-compatibility.md`](harness-compatibility.md) | Which harness surfaces and limitations are supported?                 |
| [`adding-a-profile.md`](adding-a-profile.md)           | How do I add stack detection-to-capability mapping?                   |
| [`adding-a-registry.md`](adding-a-registry.md)         | How do I add a remote discovery source?                               |
| [`adr/`](adr/)                                         | Why were minimum resolution, ownership, and integration choices made? |

## State And Configuration

Loom has no database. Persistent state is filesystem-based and schema-validated.

### Project State

| Path                           | Contents                                                              |
| ------------------------------ | --------------------------------------------------------------------- |
| `.loom/project.json`           | Last detected project profile.                                        |
| `.loom/workflow.json`          | Per-harness task, selections, and supplied approvals.                 |
| `.loom/capabilities.lock.json` | Accepted per-harness and combined candidate lock entries.             |
| `.loom/ownership.json`         | Harness-owned files, hashes, and config pointers.                     |
| `.loom/policy.toml`            | Optional project policy layered over user policy and secure defaults. |
| `.loom/setup-plan.json`        | Exact setup bindings and recipe digest.                               |
| `.loom/setup-transaction.json` | Durable setup status and receipts.                                    |
| `.loom/setup-ownership.json`   | External setup-owned files and config pointers.                       |

### User State

| Location                                             | Purpose                                  |
| ---------------------------------------------------- | ---------------------------------------- |
| `$XDG_CONFIG_HOME/loom/preferences.toml`             | User policy, with `~/.config` fallback.  |
| `$XDG_CACHE_HOME/loom`                               | Registry cache, with platform fallbacks. |
| `$XDG_STATE_HOME/loom/approval.key`                  | Private HMAC key for setup approvals.    |
| `$XDG_STATE_HOME/loom/approvals/<project-hash>.json` | Authenticated reusable project approval. |

Relevant environment inputs are `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`,
`XDG_STATE_HOME`, `LOCALAPPDATA` on Windows, and `PATH` for validated executable
resolution. Loom does not load application `.env` files.

## Development Workflow

Requirements are Node.js 22 or newer and pnpm 11.22.0. Bun is required only for
standalone binary builds.

```sh
pnpm install
pnpm build
pnpm test
pnpm test:watch
pnpm typecheck
pnpm lint
pnpm format
pnpm format:check
pnpm verify
pnpm build:binaries
```

`pnpm verify` runs formatting checks, lint with warnings denied, TypeScript
project-reference type checking, a production build, and the Vitest suite.

Run a focused test with a source test path:

```sh
pnpm exec vitest run packages/core/src/detection.test.ts
pnpm exec vitest run integrations/opencode/src/index.test.ts
```

Run the built CLI from a project directory:

```sh
node /path/to/loom/packages/cli/dist/index.js detect
node /path/to/loom/packages/cli/dist/index.js plan --task "review this project"
node /path/to/loom/packages/cli/dist/index.js connect --dry-run --harness opencode
node /path/to/loom/packages/cli/dist/index.js doctor --harness opencode
node /path/to/loom/packages/cli/dist/index.js mcp
```

Source uses NodeNext ESM. Relative TypeScript imports intentionally end in `.js`
because emitted JavaScript runs directly under Node ESM. Follow that convention
in new source files.

Tests usually live beside implementation as `*.test.ts`. The root tests verify
all fixture projects across package boundaries. When changing detection,
profiles, or planning, check both the nearby tests and `tests/fixtures.test.ts`
or `tests/planning.test.ts`.

Tags matching `v*` trigger `.github/workflows/release.yml`, which runs
verification, builds standalone binaries, and publishes the artifacts from
`release/` with `SHA256SUMS`.

## Find The Right Place To Change

| Goal                              | Start here                                | Also inspect or update                                               |
| --------------------------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| Detect a new stack signal         | `packages/core/src/detection.ts`          | Detection tests and a focused fixture.                               |
| Add a capability ID               | `packages/core/src/capabilities.ts`       | Profiles, catalog, resolver/planning tests, capability docs.         |
| Map a framework to capabilities   | `packages/profiles/src/index.ts`          | Profile tests, fixtures, `adding-a-profile.md`.                      |
| Change task intent classification | `packages/core/src/task.ts`               | Planning tests and scoring implications.                             |
| Change candidate scoring          | `packages/core/src/scoring.ts`            | Resolver behavior, policy thresholds, score tests.                   |
| Change security policy            | `packages/core/src/policy.ts`             | Policy tests, `security.md`, CLI/MCP policy loading.                 |
| Change minimum-set selection      | `packages/core/src/resolver.ts`           | Resolver tests and ADR 0001.                                         |
| Add built-in candidate metadata   | `packages/registry/src/catalog.ts`        | Catalog tests, exact version/provenance, profile coverage.           |
| Add a remote registry             | `packages/registry/src/types.ts`          | Adapter, cache/process limits, tests, `adding-a-registry.md`.        |
| Add or change an MCP tool         | `packages/mcp/src/handlers.ts`            | `server.ts`, handler/server tests, README tool behavior.             |
| Add or change a CLI command       | `packages/cli/src/index.ts`               | CLI tests, README command table, persisted state effects.            |
| Add an audited setup recipe       | `packages/installers/src/index.ts`        | Setup schemas, CLI setup flow, installer and security tests.         |
| Add a harness                     | `packages/core/src/harness.ts`            | New integration, CLI dispatch, project references, lifecycle tests.  |
| Change harness config projection  | `integrations/<harness>/src/index.ts`     | Collision, rollback, ownership, idempotence, remove tests.           |
| Add or change a Loom skill        | `packages/skills/<skill>/SKILL.md`        | Standalone embedding and adapter projection expectations.            |
| Change persisted state            | `packages/core/src/state.ts` or `lock.ts` | Constants, CLI writers, MCP readers, schema version/migration needs. |
| Change binary packaging           | `scripts/build-binaries.ts`               | `standalone.ts`, release workflow, README platforms.                 |

## Invariants To Preserve

Changes that cross a trust or mutation boundary should preserve all applicable
rules:

- Planning output is deterministic: sort and deduplicate explicitly.
- Filesystem and network work is bounded by size, depth, count, or timeout.
- Apply requires selected candidates to declare a version; lock persistence
  additionally rejects range-like version or revision strings.
- Discovery metadata is not installation authority.
- LLM text and registry runtime hints are never executed.
- External processes receive argument arrays with `shell: false`.
- Mutations stay under explicit path allowlists and reject symlink escapes.
- Existing config is patched structurally, not replaced wholesale.
- Apply checks expected hashes to detect changes since planning.
- Partial multi-file operations roll back earlier changes.
- Loom removes only resources it owns and that remain unchanged.
- Persisted and returned data is schema-validated and secret-redacted.
- Approval authority remains outside the agent-writable project directory.

Read [`security.md`](security.md) and the adapter tests before changing any code
that writes files, executes processes, reads persisted state, or crosses a
network boundary.

## Complexity Hotspots

| Area                               | Why it needs extra care                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `packages/cli/src/index.ts`        | Large composition root with approval, transaction, state, and cleanup logic. |
| `packages/core/src/detection.ts`   | Many ecosystem heuristics inside a bounded recursive scan.                   |
| `packages/core/src/resolver.ts`    | Exact and fallback algorithms must remain deterministic and explainable.     |
| `packages/core/src/setup.ts`       | Canonicalization and hashes bind intents, recipes, approvals, and state.     |
| `packages/registry/src/catalog.ts` | Large security-sensitive source of normalized candidate metadata.            |
| `packages/registry/src/cache.ts`   | Atomic cache state, TTL, resumable pagination, and offline behavior.         |
| `packages/installers/src/index.ts` | External process staging, ownership, verification, and rollback.             |
| `integrations/*/src/index.ts`      | Harness-specific filesystem transactions and shared ownership.               |
| `packages/mcp/src/handlers.ts`     | Network opt-in, safe state reads, redaction, and setup-intent generation.    |

When documentation disagrees with implementation, treat current schemas, package
source, tests, and then the README as authoritative. Update stale docs as part
of the same change.

## Reading Paths

### 15-Minute Orientation

1. [`README.md`](../README.md)
2. [`architecture.md`](architecture.md)
3. `packages/registry/src/planner.ts`
4. `packages/core/src/harness.ts`
5. The repository map and runtime flows in this guide

### Planning And Resolution

1. `packages/core/src/domain.ts`
2. `packages/core/src/detection.ts`
3. `packages/profiles/src/index.ts`
4. `packages/core/src/task.ts`
5. `packages/core/src/scoring.ts`
6. `packages/core/src/policy.ts`
7. `packages/core/src/resolver.ts`
8. `packages/registry/src/planner.ts`
9. [`capability-model.md`](capability-model.md)

### Harness Integration

1. `packages/core/src/harness.ts`
2. [`adr/0002-explicit-ownership.md`](adr/0002-explicit-ownership.md)
3. [`adr/0003-harness-integration.md`](adr/0003-harness-integration.md)
4. `integrations/opencode/src/index.ts`
5. `integrations/opencode/src/index.test.ts`
6. One other adapter for comparison
7. `packages/cli/src/index.ts`, starting at adapter selection and apply/remove
   commands

### Secure Setup

1. [`security.md`](security.md)
2. `packages/core/src/setup.ts`
3. `packages/mcp/src/handlers.ts`, focusing on `loom_setup_recommend`
4. `packages/installers/src/index.ts`
5. `packages/cli/src/index.ts`, focusing on setup, rollback, and recovery
6. The corresponding `*.test.ts` files

### Full Architecture

1. Complete the planning and harness paths above.
2. Read `packages/registry/src/types.ts` and each remote registry adapter.
3. Read `packages/registry/src/cache.ts` and its tests.
4. Read `packages/mcp/src/server.ts` and handler/server tests.
5. Read `scripts/standalone.ts` and `scripts/build-binaries.ts`.
6. Finish with every document under [`adr/`](adr/).
