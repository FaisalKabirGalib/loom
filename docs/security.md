# Security

Loom treats capability metadata, harness configuration, and project state as
separate trust boundaries.

## Resolution controls

- Candidates declare permissions and provenance; scoring penalizes privilege and
  policy can block or require explicit `--approve <id>`.
- Default policy disables remote MCP and MCP shell execution, limits database
  access to read, and requires review for scripted skills.
- Suspicious binaries, unresolved provenance, package/repository mismatch,
  unsafe installers, deleted entries, and below-minimum trust can be blocked.
- Discovery is not installation. Loom has no external auto-install path.

CLI and MCP planning layer `$XDG_CONFIG_HOME/loom/preferences.toml` (falling
back to `~/.config/loom/preferences.toml`) and `.loom/policy.toml` over secure
defaults. Invalid policy fails planning rather than silently reverting to
defaults.

## Safe apply and remove

Adapters plan mutations before applying them, support `--dry-run`, constrain
paths to explicit allowlists, reject symlinked path components, and use atomic
writes. Only in-memory plans issued by the same adapter instance are accepted.
Expected hashes detect changes between planning and apply, and failed multi-file
applies roll back earlier mutations. Existing unowned target files/config keys
are collisions, not overwrite candidates.

`.loom/ownership.json` records exact file hashes and owned config regions.
Reapply and removal refuse to overwrite or delete modified owned content.
OpenCode patches only `mcp.loom` while preserving JSONC comments and other keys.
Codex appends/replaces only a marked `mcp_servers.loom` TOML block and preserves
all bytes outside it. Shared skill files remain while another harness owns the
same hash.

## State and output

- JSON CLI output and persisted project/lock state redact secret-shaped keys and
  common credential strings.
- MCP state readers reject symlinked `.loom` directories/files, paths resolving
  outside the project, non-regular files, and state files larger than 1 MiB.
- Registry cache directories/files are created with modes 0700/0600 and replaced
  atomically.
- CLI JSON plans omit mutation contents, and MCP responses pass through the same
  recursive secret redaction used for persisted state.
- Secrets must not be stored in tracked harness configuration. Candidate secret
  names are metadata, not values.

## Harness limitations

Codex loads project `.codex/config.toml` only for trusted projects, so a
successful Loom apply does not guarantee that Codex activates the MCP server.
OpenCode is the verified dogfood harness in this checkout. See
[harness compatibility](harness-compatibility.md) for versioned harness details.
