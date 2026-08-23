# Skill Resolution

## Bundled skills

Loom owns one canonical, harness-neutral skill set under
[`packages/skills`](../packages/skills):

- `loom-architecture-review`
- `loom-dependency-research`
- `loom-design-director`
- `loom-functional-core`
- `loom-project-hydrate`
- `loom-project-start`
- `loom-verification-loop`

These skills contain instructions only. Both implemented adapters copy all files
under `loom-*` skill directories into `.agents/skills/<name>/`, the project path
shared by OpenCode and Codex. Hashes in `.loom/ownership.json` let both
harnesses share identical files without either adapter deleting a file still
owned by the other.

OpenCode also installs a local plugin with `loom:start`, `loom:hydrate`, and
`loom:verify` commands that direct the harness to the corresponding skills.
Codex receives skills and MCP configuration, not a plugin.

## External skill discovery

`loom discover skills <query>` invokes:

```text
npx --yes skills@1.5.23 find <query>
```

The adapter also implements `list --json` for registry consumers. It accepts
conservative `owner/repo@skill` results and normalizes them as community,
project-scoped candidates with shell/network/write permissions and a script
review note. Failed or malformed output produces no candidates.

Discovery never invokes the `skills` install command and `loom apply` never
installs discovered skills. Review and installation of an external skill remain
outside Loom.

The `skills` CLI integration has mocked parser/process tests, but its live live
`skills@1.5.23 find typescript` discovery was smoke-verified on 2026-08-23.

## Collision behavior

Adapters refuse to overwrite an unowned destination or a modified owned skill.
Removal deletes only unchanged Loom-owned files and preserves unrelated skills.
See [ADR 0002](adr/0002-explicit-ownership.md) and
[harness compatibility](harness-compatibility.md).
