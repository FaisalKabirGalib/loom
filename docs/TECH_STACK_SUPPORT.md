# Loom Tech-Stack Support and Extension Guide

## Support Levels

Loom support has four separate levels:

1. **Detected**: Loom recognizes evidence in the project.
2. **Profiled**: The detected stack contributes required or useful capabilities.
3. **Recommendable**: A built-in or external registry candidate can provide
   those capabilities.
4. **Installable**: Loom has an audited, typed recipe that the CLI is allowed to
   execute.

A technology being detected does not mean Loom automatically installs tools for
it. Loom currently detects many stacks, has seven stack profiles, and can
recommend a broad catalog. The only audited external setup recipe is
Flutter/Dart on OpenCode.

## Detected Technologies

Project detection is implemented in `packages/core/src/detection.ts`. It scans
up to four directory levels and 5,000 entries, including declared workspace
package manifests.

### Languages

| Language   | Detection evidence                                                 |
| ---------- | ------------------------------------------------------------------ |
| TypeScript | `tsconfig.json`, a `typescript` dependency, or `.ts`/`.tsx` source |
| JavaScript | `package.json` or `.js`/`.jsx`/`.mjs`/`.cjs` source                |
| Dart       | `pubspec.yaml` or `.dart` source                                   |
| Go         | `go.mod`, `go.work`, or `.go` source                               |
| PHP        | `composer.json` or `.php` source                                   |

### Frameworks and Developer Tools

| Framework/tool | Detection evidence                                                |
| -------------- | ----------------------------------------------------------------- |
| Next.js        | `next` dependency or `next.config.*`                              |
| React          | `react` dependency                                                |
| React Native   | `react-native` dependency or `metro.config.*`                     |
| Expo           | `expo` dependency, Expo `app.json`, `app.config.*`, or `eas.json` |
| Dart           | Dart manifest or source                                           |
| Flutter        | Flutter SDK declaration in `pubspec.yaml`                         |
| Widgetbook     | `widgetbook` package                                              |
| Patrol         | `patrol` package                                                  |
| Go             | Go module, workspace, or source                                   |
| Laravel        | `laravel/framework` Composer dependency                           |
| Storybook      | Storybook package, `.storybook`, or a `*.stories.*` file          |
| shadcn         | `components.json`                                                 |

Vite and Astro configuration contribute to the generic `web` project flag, but
they do not currently have named framework entries or profiles.

### Services and Infrastructure

| Service         | Detection evidence                                                             |
| --------------- | ------------------------------------------------------------------------------ |
| PostgreSQL      | `pg`, `postgres`, or `postgresql` package, or a PostgreSQL Prisma provider     |
| Supabase        | Supabase package or `supabase/` directory                                      |
| Neon            | `@neondatabase/*` package                                                      |
| Vercel          | `vercel.json` or `.vercel/`                                                    |
| Cloudflare      | `wrangler` dependency or `wrangler.json`, `wrangler.jsonc`, or `wrangler.toml` |
| Docker          | `Dockerfile*`, `docker-compose.*`, or `compose.*`                              |
| Terraform       | Any `.tf` file                                                                 |
| Kubernetes/Helm | `k8s/`, `kubernetes/`, `helm/`, or `Chart.yaml`                                |
| GitHub Actions  | `.github/workflows/`                                                           |

### Package Managers

Loom recognizes:

- `pnpm`, `npm`, `yarn`, and `bun` from lockfiles
- Any explicit `packageManager` value in `package.json`
- `pub` from `pubspec.yaml`
- `go` from `go.mod` or `go.work`
- `composer` from `composer.json`

### Project Categories

Loom also derives cross-stack boolean signals:

| Category   | Current evidence                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| `web`      | Next.js, non-mobile React, Storybook, Laravel, Vite, or Astro                                               |
| `ui`       | Web projects, Flutter, React Native, Expo, or shadcn                                                        |
| `mobile`   | Flutter, React Native, or Expo                                                                              |
| `api`      | Next.js, Laravel, Go source, `routes/api.php`, Express, Fastify, Hono, NestJS, or Elysia                    |
| `database` | PostgreSQL, Supabase, Neon, Prisma, Drizzle, Mongoose, TypeORM, Sequelize, or SQLite packages/configuration |
| `monorepo` | pnpm workspace, Turborepo, Nx, Go workspace, or `package.json` workspaces                                   |

The lifecycle is `brownfield` when a known manifest or source file exists;
otherwise it is `greenfield`.

Known existing agent configuration includes `AGENTS.md`, `CLAUDE.md`, `.claude`,
`.cursor`, Copilot instructions, `.mcp.json`, `.opencode`, and OpenCode
JSON/JSONC configuration.

## Stack Profiles

Profiles are defined in `packages/profiles/src/index.ts`. Multiple profiles can
match one project; their capability lists are deduplicated.

| Profile         | Match                       | Required capabilities     | Useful capabilities                                           |
| --------------- | --------------------------- | ------------------------- | ------------------------------------------------------------- |
| TypeScript      | TypeScript language         | None                      | Package docs, structural search                               |
| Next.js / React | Next.js or non-mobile React | None                      | Framework docs, browser testing, React runtime, accessibility |
| Flutter / Dart  | Flutter or Dart             | Mobile framework analysis | Runtime inspection, mobile framework docs                     |
| React Native    | React Native                | Mobile framework analysis | Runtime inspection, device E2E testing                        |
| Expo            | Expo                        | Mobile framework analysis | Device E2E testing, mobile framework docs                     |
| Go              | Go language                 | Symbol navigation         | Framework docs                                                |
| Laravel / PHP   | Laravel                     | Framework docs            | Schema inspection, production errors                          |

Detected technologies without a dedicated profile still influence candidate
scoring through language, framework, service, package-manager, dependency, and
project-category matches.

## Capability Vocabulary

The canonical vocabulary is in `packages/core/src/capabilities.ts`:

- `CODE_CONTEXT`: semantic search, symbol navigation, call graphs, history,
  structural search, impact analysis, relationship graphs, snapshots, and
  efficient reading.
- `DOCS`: package, repository, source, framework, and API documentation.
- `UI`: design systems, component registries, browser tooling, React runtime,
  accessibility, performance, and design-to-code.
- `MOBILE`: framework analysis/docs, runtime and component inspection,
  emulator/device control, E2E tests, hot reload, logs, performance, builds, and
  distribution.
- `API`: contracts, clients, mocking, GraphQL, and API testing.
- `SECURITY`: SAST, dependency risk, quality analysis, secret safety, and SQL
  safety.
- `DATA`: generic SQL, schemas, migrations, Supabase, and Neon.
- `OPS`: deployment, observability, production errors, Kubernetes, Terraform,
  Git hosting, CI, and releases.

## Recommendations

The curated candidate catalog lives in `packages/registry/src/catalog.ts`. It
includes code-intelligence, documentation, browser/UI, mobile, API, security,
database, and operations tools.

Additional candidates can be discovered through:

- Official MCP Registry: `packages/registry/src/official-mcp.ts`
- GitHub provenance: `packages/registry/src/github.ts`
- Pinned `skills@1.5.23` CLI: `packages/registry/src/skills-cli.ts`

External descriptions are mapped onto Loom capabilities by rules in
`packages/registry/src/inference.ts`. Discovery is recommendation-only unless an
audited installer exists.

Candidate ranking is controlled by `packages/core/src/scoring.ts`. Current
weights favor task fit, project fit, capability coverage, maintenance,
provenance, security, context efficiency, and portability. Risky permissions,
stale software, ecosystem mismatch, unverified installers, and duplicate
coverage incur penalties.

Policy then filters candidates in `packages/core/src/policy.ts` and
`packages/core/src/resolver.ts`. A project can override policy through
`.loom/policy.toml`.

## What `loom connect` Sets Up

`loom connect --harness <id>` connects Loom itself; it does not install
arbitrary recommended third-party tools.

It configures the harness to run `loom mcp` and installs Loom's eight bundled
skills:

- `loom-project-setup`
- `loom-verification-loop`
- `loom-functional-core`
- `loom-design-director`
- `loom-architecture-review`
- `loom-dependency-research`
- `loom-project-hydrate`
- `loom-project-start`

Harness outputs are:

| Harness     | Configuration and skills                                                               |
| ----------- | -------------------------------------------------------------------------------------- |
| OpenCode    | `opencode.json`/`opencode.jsonc`, `.opencode/plugins/loom.ts`, `.agents/skills/loom-*` |
| Codex       | Loom-owned block in `.codex/config.toml`, `.agents/skills/loom-*`                      |
| Claude Code | `mcpServers.loom` in `.mcp.json`, `.claude/skills/loom-*`                              |
| OMP         | `mcpServers.loom` in `.omp/mcp.json`, `.omp/skills/loom-*`                             |
| Antigravity | `mcpServers.loom` in `.agents/mcp_config.json`, `.agents/skills/loom-*`                |

Ownership hashes are recorded in `.loom/ownership.json`. Removal refuses to
delete files or configuration pointers that changed after Loom wrote them.

## What `loom setup` Installs Today

The audited setup path currently supports only Flutter/Dart projects on
OpenCode.

It installs:

- `.loom/tools/flutter-package-intelligence` with exact `dart_pubdev_mcp 0.9.0`
  and `skills 1.0.0`, a deterministic lockfile, and project-local Pub/HOME/XDG
  state
- The official `<dart> mcp-server` entry and a local `dart-pubdev-explorer`
  entry backed by an ownership-hashed compiled executable, while refusing
  unowned JSONC pointer collisions. Setup clears and refetches the local package
  cache before compiling or running package code.
- Only exact skills selected by the host LLM from locked hosted packages or
  immutable GitHub commits, copied into `.agents/skills/` with content hashes.
  Hosted selections run through local `skills 1.0.0` with repeated
  `--package`/`--skill` filters; registry skills use exact-commit Loom staging.
  Neither path uses `--all`.
- Setup ownership, plan, approval, transaction, lock, project, and workflow
  state under `.loom/`

The old `builtin:flutter-agent-plugins` 22-skill ownership is recognized only
for migration or removal and is removed only when its files and MCP pointer are
unchanged.

Selection is two-stage: search first, then submit exact IDs with nonblank
reasons or explicitly choose zero with a rationale. The CLI re-resolves every
selection, binds pubspec, lockfile, package config, package/repository hashes,
and the exact installer plan before review, then activates, verifies, and writes
a receipt. Failures roll back ownership-safe mutations.

Other catalog and network candidates remain recommendations because
`setupCommand()` rejects candidates without an audited recipe.

## Where to Modify Behavior

| Desired change                           | Primary file                                                 | Also review                                                     |
| ---------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| Detect a new language/framework/service  | `packages/core/src/detection.ts`                             | `packages/core/src/detection.test.ts`, `tests/fixtures.test.ts` |
| Add a stack profile                      | `packages/profiles/src/index.ts`                             | `packages/profiles/src/index.test.ts`                           |
| Add a capability name                    | `packages/core/src/capabilities.ts`                          | Domain/catalog/profile references and planning tests            |
| Change task-to-capability classification | `packages/core/src/task.ts`                                  | `packages/core/src/workbench.test.ts`, `tests/planning.test.ts` |
| Add or edit a curated candidate          | `packages/registry/src/catalog.ts`                           | `packages/registry/src/catalog.test.ts`                         |
| Change external MCP/skill inference      | `packages/registry/src/inference.ts`                         | Registry contract tests                                         |
| Change ranking weights or penalties      | `packages/core/src/scoring.ts`                               | `packages/core/src/workbench.test.ts`, planning tests           |
| Change policy defaults/schema/loading    | `packages/core/src/domain.ts`, `packages/core/src/policy.ts` | `packages/core/src/policy.test.ts`, `.loom/policy.toml`         |
| Add a recipe kind/schema                 | `packages/core/src/setup.ts`                                 | `packages/core/src/setup.test.ts`                               |
| Add an audited installer                 | `packages/installers/src/index.ts`                           | `packages/installers/src/index.test.ts`                         |
| Allow/orchestrate a setup recipe         | `packages/cli/src/index.ts`                                  | `packages/cli/src/index.test.ts`                                |
| Change OpenCode configuration            | `integrations/opencode/src/index.ts`                         | `integrations/opencode/src/index.test.ts`                       |
| Change Codex configuration               | `integrations/codex/src/index.ts`                            | `integrations/codex/src/index.test.ts`                          |
| Change Claude configuration              | `integrations/claude/src/index.ts`                           | `integrations/claude/src/index.test.ts`                         |
| Change OMP configuration                 | `integrations/omp/src/index.ts`                              | `integrations/omp/src/index.test.ts`                            |
| Change Antigravity configuration         | `integrations/antigravity/src/index.ts`                      | `integrations/antigravity/src/index.test.ts`                    |
| Add/edit bundled Loom skills             | `packages/skills/loom-*/SKILL.md`                            | All adapter tests                                               |
| Change MCP tool inputs or behavior       | `packages/mcp/src/handlers.ts`                               | `packages/mcp/src/handlers.test.ts`                             |
| Add/remove an MCP tool                   | `packages/mcp/src/server.ts`                                 | `packages/mcp/src/server.test.ts`                               |
| Change state filenames                   | `packages/core/src/constants.ts`                             | CLI, adapters, migration implications                           |

## Adding a New Stack

For detection and recommendations only:

1. Add evidence rules to `packages/core/src/detection.ts`.
2. Add a profile to `packages/profiles/src/index.ts` if the stack has specific
   capability needs.
3. Reuse existing capability names or add new ones in
   `packages/core/src/capabilities.ts`.
4. Add curated candidates in `packages/registry/src/catalog.ts`, or extend
   external inference rules.
5. Add detector, profile, catalog, and planning tests.

For automatic installation as well:

1. Define a reproducible recipe with an exact version, commit, digest, or
   immutable remote reference.
2. Implement plan, apply, verify, and uninstall behavior in
   `packages/installers/src/index.ts` or a new installer package.
3. Restrict all writable paths and use expected hashes, atomic writes, and
   ownership records.
4. Add the recipe to CLI revalidation and allow-list logic in
   `packages/cli/src/index.ts`.
5. Add harness activation logic where required.
6. Test dry-run, first install, no-op repeat, modified-owned-file refusal,
   failed-install rollback, doctor, and explicit rollback.

Run the full validation suite with:

```sh
pnpm verify
```
