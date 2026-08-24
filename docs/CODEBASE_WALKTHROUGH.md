# Loom Codebase Walkthrough

## What Loom Is

Loom analyzes a software project, recommends a minimal set of AI-agent capabilities, and safely installs an approved, reproducible setup into an agent harness.

Its key separation is:

```text
MCP server: inspect and recommend, never mutate
CLI: revalidate, request approval, mutate, verify, and rollback
```

Supported harnesses are OpenCode, Codex, Claude Code, Oh My Pi (OMP), and Antigravity.

## Architecture

```text
Project files
    |
    v
detectProject()
    |
    v
ProjectProfile
    |
    v
profiles + task classification
    |
    v
registry candidates
    |
    v
scoring + policy filtering
    |
    v
minimum set-cover resolver
    |
    v
CapabilityPlan
    |
    v
MCP recommendation or CLI application
    |
    v
HarnessAdapter / typed installer
    |
    v
config + skills + ownership state
```

### Main Packages

- `packages/core`: Domain schemas, project detection, scoring, policy, resolution, setup transactions, safety, and state.
- `packages/registry`: Built-in capabilities and external discovery through the Official MCP Registry, GitHub, and the `skills` CLI.
- `packages/profiles`: Maps detected stacks to required and useful capabilities.
- `packages/mcp`: Exposes Loom's read-only MCP tools.
- `packages/cli`: Handles command parsing and all mutating workflows.
- `packages/installers`: Contains audited installation recipes. The primary external recipe installs pinned Flutter agent skills and Dart MCP support.
- `packages/skills`: Contains eight bundled, instruction-only Loom skills.
- `integrations/*`: Contains harness-specific configuration adapters.

## Planning Flow

CodeGraph identifies the central call path as:

```text
CLI explain/plan/apply
  -> resolvePlan()
  -> planProject()
  -> resolveCapabilities()
  -> selectMinimumSet()
  -> exactSetCover()
```

### 1. Project Detection

`detectProject()` scans at most four directory levels and 5,000 entries while ignoring generated directories. It examines manifests, dependencies, lockfiles, configuration files, and source extensions.

It produces a `ProjectProfile` containing:

- Languages
- Frameworks
- Services
- Package managers
- Existing agent configuration
- Greenfield or brownfield lifecycle
- Evidence explaining each detection

For example, dependencies such as `next` and `react`, PostgreSQL packages, Wrangler configuration, Dockerfiles, and Terraform files become explicit detection signals.

Reference: `packages/core/src/detection.ts:175`

### 2. Profiles and Task Classification

`planProject()` composes stack-specific profiles and classifies the requested task:

```typescript
const project = detectProject(root);
const profiles = composeProfiles(project);
const task = classifyTask(options.task ?? "", project, {
  requiredCapabilities: profiles.requiredCapabilities,
  usefulCapabilities: profiles.usefulCapabilities,
});
```

Profiles provide defaults inferred from the project. An optional task adds more specific requirements.

Reference: `packages/registry/src/planner.ts:32`

### 3. Candidate Discovery

Candidates can come from:

- `BuiltinRegistry`
- Official MCP Registry
- GitHub provenance discovery
- `skills` CLI discovery

For network registries, Loom derives up to five search terms from required capabilities, useful capabilities, frameworks, and services. Duplicate IDs are collapsed to the newest version.

### 4. Scoring and Policy

Candidates are scored against the project and task. The policy layer can reject them based on trust, permissions, minimum score, or other constraints.

A candidate describes:

- Capabilities it provides
- Exact version or revision
- Runtime and transport
- Filesystem, shell, network, secret, database, and device permissions
- Provenance and trust tier
- Context cost and portability
- Scope and task triggers

References: `packages/core/src/domain.ts:190`, `packages/core/src/resolver.ts:21`

### 5. Minimal Selection

The resolver removes blocked and low-scoring candidates, then solves an exact set-cover problem for required capabilities.

It prefers the smallest adequate combination instead of installing every useful tool. Alternatives are retained with rejection explanations such as overlap, additional context cost, or increased permissions.

The resulting `CapabilityPlan` contains:

- Selected candidates
- Optional candidates
- Rejected candidates with reasons
- Uncovered requirements

## MCP Plane

`packages/mcp/src/server.ts` exposes nine tools:

- `loom_project_detect`
- `loom_project_plan`
- `loom_explain`
- `loom_capability_search`
- `loom_capability_resolve`
- `loom_capability_status`
- `loom_workflow_status`
- `loom_doctor`
- `loom_setup_recommend`

Every tool is annotated as read-only, non-destructive, and idempotent. Results also pass through secret redaction.

`loom_setup_recommend` does not install anything. It returns a command containing a serialized `loom1_...` setup intent for the user to review and run.

Reference: `packages/mcp/src/server.ts:43`

## Mutation Plane

The CLI owns all writes. Its important commands include:

- `connect`: Installs Loom MCP and bundled skills.
- `apply`: Applies a capability plan through a harness adapter.
- `setup`: Executes an MCP-recommended, version-bound setup.
- `doctor`: Validates configuration and ownership.
- `remove`: Removes unchanged Loom-owned resources.
- `rollback` and `recover`: Manage setup transactions.

The normal setup flow is:

```text
loom_setup_recommend
  -> loom1_ intent
  -> loom setup --intent ...
  -> decode and validate intent
  -> detect project again
  -> recreate and hash plan
  -> show consolidated approval
  -> execute audited installer
  -> activate harness configuration
  -> verify
  -> write receipt and transaction state
```

Setup plan IDs and recipe digests use canonical JSON plus SHA-256. Timestamps are excluded from the stable plan binding, so equivalent plans receive the same identity.

Reference: `packages/core/src/setup.ts:340`

## Harness Adapters

Every integration implements the same contract:

```typescript
interface HarnessAdapter {
  id: string;
  inspect(root: string): Promise<HarnessState>;
  planInstall(root: string, plan: CapabilityPlan): Promise<ConfigMutationPlan>;
  apply(plan: ConfigMutationPlan, dryRun?: boolean): Promise<ApplyResult>;
  verify(root: string): Promise<Diagnostic[]>;
  uninstallOwned(root: string, dryRun?: boolean): Promise<ApplyResult>;
}
```

Reference: `packages/core/src/harness.ts:45`

Each adapter translates the same plan into native configuration:

- OpenCode: `opencode.json` or `opencode.jsonc`, plugin, and `.agents/skills`
- Codex: Marked section in `.codex/config.toml`
- Claude Code: `.mcp.json` and `.claude/skills`
- OMP: `.omp/mcp.json` and `.omp/skills`
- Antigravity: `.agents/mcp_config.json`

This keeps planning harness-independent while isolating configuration syntax and ownership behavior.

## Safety Model

Loom is intentionally defensive:

- MCP tools cannot mutate the repository.
- Setup re-detects the project instead of trusting an earlier recommendation.
- Applied candidates require exact versions or revisions.
- Only audited typed recipes may be installed.
- Mutations are restricted to known project-relative paths.
- Symlinks and path escapes are rejected.
- Writes are atomic.
- Existing configuration is edited rather than replaced.
- Expected hashes detect concurrent or user modifications.
- `.loom/ownership.json` records which harness owns each file and pointer.
- Removal only deletes resources that remain unchanged.
- Approval records use an HMAC bound to the project root.
- Rollback verifies transaction, plan, and recipe bindings.
- Lock output is secret-redacted.

The important design principle is that recommendation data remains untrusted until the CLI independently reconstructs and validates it.

## Persistence

Loom stores project-local state under `.loom/`, including:

- `project.json`
- `workflow.json`
- `capabilities.lock.json`
- `ownership.json`
- Setup plan, approval, transaction, and ownership records

Transactions move through:

```text
pending -> running -> succeeded | failed -> rolled-back
```

Terminal transactions require a matching receipt.

## Testing

Tests sit beside package implementations, with cross-package scenarios in `tests/`.

Coverage includes:

- Project detection
- Policies and setup schemas
- CLI behavior
- Harness planning, application, verification, and removal
- MCP handlers and server contracts
- Registry normalization, pagination, caching, and process integrations
- Installer ownership and mutation safety
- End-to-end planning fixtures

The complete validation command is `pnpm verify`, which runs formatting, linting, type checking, build, and Vitest.

## Mental Model

Loom is best understood as a deterministic package manager for agent capabilities:

- Detection determines what the project needs.
- Registries provide possible capabilities.
- Scoring and set cover choose the smallest acceptable set.
- The host LLM explains and recommends.
- The CLI enforces trust, approval, exact versions, and safe installation.
- Ownership and transaction records make repeat runs, removal, and rollback predictable.
