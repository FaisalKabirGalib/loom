# Loom Harness Compatibility

Verified 2026-08-23 against the locally installed CLIs and official
documentation. Local versions were OpenCode `1.18.18` and Codex CLI `0.147.0`.
The current official OpenCode tag was `v1.18.21`
(`826d9ad46a22bef0294998e08daa3c4904fea28f`).

## Compatibility matrix

| Area               | OpenCode 1.18.18 / tag 1.18.21                                                                                                                                                | Codex 0.147.0                                                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project config     | `opencode.json` or `opencode.jsonc`; project resources under `.opencode/`                                                                                                     | `.codex/config.toml`, loaded only for trusted projects; layers run from repository root toward the working directory                                                                  |
| User config        | `~/.config/opencode/opencode.json`; resources under `~/.config/opencode/`                                                                                                     | `~/.codex/config.toml`; system defaults may use `/etc/codex/config.toml`                                                                                                              |
| Instructions       | Project `AGENTS.md`; global `~/.config/opencode/AGENTS.md`; documented Claude-compatible fallbacks                                                                            | Global `~/.codex/AGENTS.md` or `AGENTS.override.md`; project files are layered root-to-working-directory, with the nearest guidance last                                              |
| Project skills     | `.opencode/skills/<name>/SKILL.md`, `.agents/skills/<name>/SKILL.md`, or `.claude/skills/<name>/SKILL.md`                                                                     | `.agents/skills/<name>/SKILL.md` from the working directory through repository root                                                                                                   |
| Other skill scopes | `~/.config/opencode/skills`, `~/.agents/skills`, and `~/.claude/skills`                                                                                                       | User `~/.agents/skills`, admin `/etc/codex/skills`, and bundled system skills                                                                                                         |
| Skill behavior     | Progressive loading through the native `skill` tool; access can be allowed, denied, or prompted globally or per agent                                                         | Progressive loading; explicit `$name` or `/skills` and implicit description matching; individual skills can be disabled in `~/.codex/config.toml`                                     |
| MCP                | Local and remote entries under `mcp` in OpenCode config; servers can be disabled and tools scoped globally or per agent                                                       | STDIO and streamable HTTP entries under `[mcp_servers.<name>]`; CLI management via `codex mcp`; user or trusted-project scope; allow/deny lists and approval modes                    |
| Plugin model       | Local TypeScript/JavaScript modules in `.opencode/plugins/` or `~/.config/opencode/plugins/`; npm packages in the config `plugin` array; hooks and custom tools are supported | Marketplace plugins bundle skills, connectors, MCP servers, hooks, or assets; `/plugins` manages them in CLI and a new session loads them; the IDE extension does not support plugins |

## Implemented Loom integration

Loom keeps one canonical, harness-neutral skill set in `packages/skills`. Every
adapter preserves unrelated files and records hashes and owned config pointers
in `.loom/ownership.json`. OpenCode patches `mcp.loom` in
`opencode.json`/`opencode.jsonc` and installs a thin local command plugin. Codex
writes a marked `mcp_servers.loom` block in `.codex/config.toml`. Claude Code
patches `mcpServers.loom` in `.mcp.json`; OMP patches it in `.omp/mcp.json`; and
Antigravity patches it in `.agents/mcp_config.json`.

OpenCode, Codex, and Antigravity share identical skills through
`.agents/skills`. Claude Code uses `.claude/skills`, and OMP uses `.omp/skills`.

OpenCode is the verified dogfood path in this checkout. Its adapter tests cover
JSONC preservation, idempotency, collision handling, verification, dry-run, and
safe removal. The Codex adapter and equivalent mutation tests are implemented,
but Codex project trust remains an external activation requirement. See the
[OpenCode adapter](../integrations/opencode/src/index.ts),
[Codex adapter](../integrations/codex/src/index.ts),
[Claude Code adapter](../integrations/claude/src/index.ts),
[OMP adapter](../integrations/omp/src/index.ts),
[Antigravity adapter](../integrations/antigravity/src/index.ts), and
[integration ADR](adr/0003-harness-integration.md).

Loom connects its own nine-tool stdio MCP server and eight bundled,
instruction-only skills. Capability plans and registry discovery do not trigger
external installation.

## Caveats

- OpenCode releases frequently; the installed `1.18.18` trails official tag
  `1.18.21`. Recheck plugin types and config schema before encoding
  version-sensitive hooks.
- OpenCode merges configuration layers, so adapters must patch owned keys rather
  than replace files. npm plugins install through Bun and local plugin
  dependencies can trigger installation.
- Both harnesses expose every enabled MCP tool to model context; keep the
  enabled set minimal and use tool or per-agent scoping where available.
- Codex ignores project `.codex` layers for untrusted repositories. The CLI,
  desktop app, and IDE share Codex MCP configuration, but plugin availability
  differs by surface.
- Codex repository skills with duplicate names are not merged. OpenCode also
  requires valid frontmatter and folder/name consistency. Loom installers must
  detect collisions rather than overwrite them.
- Skills may contain scripts, but Loom's canonical skills are instruction-only.
  External capabilities require provenance, permission review, approval, and
  version locking.
- The Official MCP Registry and pinned `skills@1.5.23` adapters have mocked
  contract tests and live discovery smoke tests from 2026-08-23. Registry cache
  sync was verified with resumable checkpoints totaling 2,000 candidates.
- No secrets belong in tracked harness configuration; use environment references
  or the harness authentication flow.

## Sources

- [OpenCode configuration](https://opencode.ai/docs/config/)
- [OpenCode skills](https://opencode.ai/docs/skills/)
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [OpenCode rules](https://opencode.ai/docs/rules/)
- [OpenCode v1.18.21 release](https://github.com/anomalyco/opencode/releases/tag/v1.18.21)
- [Codex configuration](https://developers.openai.com/codex/config-basic/)
- [Codex skills](https://developers.openai.com/codex/skills/)
- [Codex MCP](https://developers.openai.com/codex/mcp/)
- [Codex plugins](https://developers.openai.com/codex/plugins/)
- [Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md/)
