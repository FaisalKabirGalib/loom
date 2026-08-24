# Loom

Loom connects a read-only project intelligence MCP to an agent harness, lets the
host LLM recommend a deterministic setup, and executes one reviewed,
version-bound setup command. It supports greenfield directories and brownfield
repositories without replacing existing harness configuration.

Implemented harness adapters are **OpenCode**, **Codex**, **Claude Code**, **Oh
My Pi (OMP)**, and **Antigravity**.

## Build and run

Loom requires Node.js 22 or newer and pnpm 11.22.0.

```sh
pnpm install
pnpm build
./packages/cli/dist/index.js --help
```

Use the built CLI from a project directory:

```sh
/path/to/loom/packages/cli/dist/index.js detect
/path/to/loom/packages/cli/dist/index.js connect --harness opencode
/path/to/loom/packages/cli/dist/index.js doctor --harness opencode
```

Restart OpenCode, then ask `Set up this project with Loom` or run `/loom:setup`.
For Flutter, the host LLM searches locked package and registry skills with
`loom_skill_search`, explicitly selects only task-relevant IDs (or justifies
selecting none), then calls the read-only `loom_setup_recommend` tool and
returns one `loom setup --intent loom1_...` command. Running it revalidates the
project and exact recipe, shows one consolidated review, asks once, installs,
activates, verifies, and records rollback state. An unchanged repeat is a
verified no-op and reuses the authenticated approval.

The first audited external recipe supports Flutter projects on OpenCode. It
creates `.loom/tools/flutter-package-intelligence` with exact
`dart_pubdev_mcp@0.9.0` and `skills@1.0.0` locks, isolated project-local Dart
state, the official Dart MCP, and `dart-pubdev-explorer`. Selected package
skills are copied locally with version and content-hash ownership; Loom never
defaults to the old 22-skill bundle. Hosted selections also run through local
`skills 1.0.0` with explicit package/skill filters; GitHub selections are staged
from their exact commit and verified hash. The explorer runs from an
ownership-hashed project-local executable compiled after clearing and refetching
the enforced package cache. Other candidates remain recommendations until they
have an audited typed recipe.

Apply refuses plans with uncovered requirements or selected candidates that do
not have an exact version/revision. This prevents an unresolved catalog
recommendation from being recorded as reproducible or active.

## Install a standalone binary

Download the binary for your platform from the
[latest GitHub release](https://github.com/FaisalKabirGalib/loom/releases/latest),
verify it against `SHA256SUMS`, make it executable on Linux or macOS, and place
it on your `PATH`:

```sh
chmod +x loom-v*-linux-x64
sudo install loom-v*-linux-x64 /usr/local/bin/loom
loom --help
```

Release binaries embed Bun, Loom's runtime code, and all eight canonical skills;
Node.js is not required. Native builds are published for Linux x64/ARM64, macOS
x64/ARM64, and Windows x64.

## CLI

| Command                                                              | Behavior                                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `detect [--json]`                                                    | Detect stack, services, existing agent config, and greenfield/brownfield lifecycle. |
| `plan [--json] [--task <text>] [--harness <id>]`                     | Resolve capabilities; with a harness, also preview adapter mutations.               |
| `explain`                                                            | Print selection and rejection reasons for the default project plan.                 |
| `discover mcp\|skills <query>`                                       | Query MCP or skill discovery sources without installing results.                    |
| `capabilities [--json]`                                              | List the capability vocabulary.                                                     |
| `connect [--dry-run] [--harness ...]`                                | Connect Loom MCP and bundled setup skills without external installation.            |
| `setup --intent <loom1_token> [--dry-run]`                           | Revalidate and execute one LLM-recommended exact setup transaction.                 |
| `apply [--dry-run] [--harness ...] [--task <text>] [--approve <id>]` | Apply an ownership-checked harness plan. Repeat `--approve` for required approvals. |
| `transactions`                                                       | Show the current setup transaction.                                                 |
| `rollback <transaction-id>`                                          | Remove only setup-owned external capabilities from that transaction.                |
| `recover`                                                            | Recover an interrupted setup transaction.                                           |
| `remove [--dry-run] [--harness ...]`                                 | Remove only unchanged Loom-owned resources.                                         |
| `doctor [--json] [--harness ...]`                                    | Verify harness ownership and project state.                                         |
| `registry sync\|status`                                              | Refresh or inspect the Official MCP Registry cache.                                 |
| `upgrades`                                                           | List locked entries as requiring review.                                            |
| `upgrade --review`                                                   | Show a review with no changes applied.                                              |
| `mcp`                                                                | Run Loom's stdio MCP server.                                                        |

Exit codes are `0` for success, `1` for errors, `2` for usage errors, and `3`
when required approvals were not supplied.

## Project output

An apply may create or update:

- `.loom/project.json`, `.loom/workflow.json`, and
  `.loom/capabilities.lock.json`
- `.loom/ownership.json`
- `.agents/skills/loom-*/...`
- OpenCode: `opencode.json` or `opencode.jsonc`, plus
  `.opencode/plugins/loom.ts`
- Codex: a marked Loom block in `.codex/config.toml`
- Claude Code: `mcpServers.loom` in `.mcp.json` and `.claude/skills/loom-*`
- OMP: `mcpServers.loom` in `.omp/mcp.json` and `.omp/skills/loom-*`
- Antigravity: `mcpServers.loom` in `.agents/mcp_config.json`

The canonical eight instruction-only skills live in
[`packages/skills`](packages/skills). OpenCode, Codex, and Antigravity target
the shared `.agents/skills` project path; Claude Code and OMP use their native
skill directories.

## Verification status

OpenCode is the verified setup path: a fresh host LLM searches package skills,
selects exact relevant IDs, invokes `loom_setup_recommend`, and returns one
setup command. Setup connects Dart, pub.dev explorer, and Loom MCP servers,
reuses approval on an unchanged rerun, passed doctor, and rolled back external
setup while retaining Loom. The Codex adapter was also applied twice, checked,
and removed while OpenCode remained healthy, but Codex ignores project `.codex`
configuration until the project is trusted.

The Official MCP Registry and pinned `skills@1.5.23` integrations have mocked
contract tests and live discovery smoke tests. Registry cache sync was also
verified across two resumable 1,000-candidate checkpoints.

## Documentation

- [Codebase guide](docs/CODEBASE_GUIDE.md)
- [Tech-stack support and extension guide](docs/TECH_STACK_SUPPORT.md)
- [Architecture](docs/architecture.md)
- [Capability model](docs/capability-model.md)
- [MCP resolution](docs/mcp-resolution.md)
- [Skill resolution](docs/skill-resolution.md)
- [Security](docs/security.md)
- [Harness compatibility](docs/harness-compatibility.md)
- [Adding a profile](docs/adding-a-profile.md)
- [Adding a registry](docs/adding-a-registry.md)
- [Architecture decisions](docs/adr/)

Run all checks with `pnpm verify`, or check documentation formatting with
`pnpm exec prettier --check README.md docs`.
