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
- Discovery is not installation. Only candidates with audited immutable typed
  recipes can enter `loom setup`; all others remain recommendations.

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

## LLM-assisted setup

- Loom MCP remains read-only. The host LLM searches project dependencies and
  registry skills, then produces a strict intent token containing project
  identity, task, harness, capability enums, selected skill IDs, reasons, and
  immutable binding hashes.
- The CLI re-detects the project and rejects root, fingerprint, capability,
  policy, recipe, version, or permission drift.
- Install recipes contain fixed structured fields and execute argument arrays
  with `shell: false`; LLM text and registry runtime hints are never executed.
- Setup approvals are authenticated with a user-private machine key and stored
  under the XDG state directory, outside the agent-writable project.
- The OpenCode/Flutter recipe creates an isolated project-local Dart package
  with an enforced lockfile, activates the absolute Dart SDK MCP and an
  ownership-hashed, project-local compiled pub.dev explorer, and installs only
  skills explicitly selected by the host LLM. The local package cache is cleared
  and refetched before any package executable runs. Hosted skills are bound to
  package versions and archive hashes; registry skills are fetched from exact
  commits and checked against reviewed content hashes. Unowned paths, symlinks,
  and mutable registry references are rejected.
- Setup transactions record exact plan and recipe digests. Rollback removes only
  setup-owned external resources and retains the Loom connection.

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
