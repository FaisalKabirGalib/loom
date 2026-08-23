# Loom

Loom detects a project, resolves a minimal capability plan, and safely projects
its own MCP server and shared skills into a supported agent harness. It supports
greenfield directories and brownfield repositories without replacing existing
harness configuration.

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
/path/to/loom/packages/cli/dist/index.js plan --task "refactor the API"
/path/to/loom/packages/cli/dist/index.js apply --dry-run --harness opencode
/path/to/loom/packages/cli/dist/index.js apply --harness opencode
/path/to/loom/packages/cli/dist/index.js doctor --harness opencode
```

`opencode` is the default harness when `--harness` is omitted. A normal apply
installs Loom's integration and bundled skills only. Registry candidates are
recommendations; Loom does not automatically install external MCP servers,
skills, CLIs, plugins, or framework tools.

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

Release binaries embed Bun, Loom's runtime code, and all seven canonical skills;
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
| `apply [--dry-run] [--harness ...] [--task <text>] [--approve <id>]` | Apply an ownership-checked harness plan. Repeat `--approve` for required approvals. |
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

The canonical seven instruction-only skills live in
[`packages/skills`](packages/skills). OpenCode, Codex, and Antigravity target
the shared `.agents/skills` project path; Claude Code and OMP use their native
skill directories.

## Verification status

OpenCode is the verified dogfood path: Loom was applied twice, loaded by a fresh
OpenCode process, invoked through `loom_project_detect`, checked with `doctor`,
and removed through the ownership-aware uninstall path. The Codex adapter was
also applied twice, checked, and removed while OpenCode remained healthy, but
Codex ignores project `.codex` configuration until the project is trusted.

The Official MCP Registry and pinned `skills@1.5.23` integrations have mocked
contract tests and live discovery smoke tests. Registry cache sync was also
verified across two resumable 1,000-candidate checkpoints.

## Documentation

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
