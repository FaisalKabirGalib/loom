# MCP Resolution

Loom distinguishes its own MCP control surface from MCP candidates discovered
for a project.

## Loom MCP server

`loom mcp` runs a stdio server named `loom` at the current Loom version. It
exposes exactly eight tools, all annotated read-only, non-destructive,
idempotent, and closed-world:

| Tool                      | Result                                                                 |
| ------------------------- | ---------------------------------------------------------------------- |
| `loom_project_detect`     | Detected project profile.                                              |
| `loom_project_plan`       | Project, task, candidates, plan, and discovery warnings.               |
| `loom_explain`            | Compact selected, optional, rejected, uncovered, and approval reasons. |
| `loom_capability_search`  | Matching normalized candidates.                                        |
| `loom_capability_resolve` | First matching candidate by ID/name and optional version.              |
| `loom_capability_status`  | Validated, redacted capability lock state.                             |
| `loom_workflow_status`    | Redacted workflow state.                                               |
| `loom_doctor`             | Local project/state diagnostics.                                       |

Tool names and registration are in
[`packages/mcp/src/server.ts`](../packages/mcp/src/server.ts); behavior and
input schemas are in [`handlers.ts`](../packages/mcp/src/handlers.ts). SDK
transport tests assert that exactly these eight tools initialize and can be
called.

## Discovery

Search and resolution use the built-in registry by default. Setting
`networkDiscovery: true` adds the Official MCP Registry and GitHub provenance
registry. Registry failures become warnings and do not discard successful local
results. `loom_doctor` never enables network discovery.

The CLI has separate explicit paths:

- `loom discover mcp <query>` combines built-in results with a live Official MCP
  Registry request and warns if the remote source fails.
- `loom registry sync` advances a resumable Official MCP Registry snapshot by up
  to ten 100-item pages.
- `loom registry status` reads that cache without a network request.

The atomic cache lives under `$XDG_CACHE_HOME/loom` or `~/.cache/loom`, uses
0600 files, returns fresh cache within TTL, permits stale cache on refresh
failure, and supports offline stale-cache/offline-miss behavior in its API. The
CLI does not currently expose an `--offline` flag.

## Selection is not installation

Registry data is normalized, scored, and policy checked. Official Registry
publication is explicitly not treated as a quality endorsement. A Loom apply
configures only the Loom MCP server in the selected harness; it never downloads,
executes, or configures a discovered external MCP candidate.

The Official MCP Registry adapter has mocked API contract tests. Live search and
two resumable cache checkpoints totaling 2,000 candidates were smoke-verified on
2026-08-23. The snapshot remained incomplete, as reported by `registry status`;
subsequent syncs resume from the stored opaque cursor.
