# ADR 0003: Native Harness Integration

- Status: Accepted
- Decision: Keep one harness-neutral skill source and a small Loom stdio MCP
  surface, then use explicit adapters for native project configuration.
- Rationale: OpenCode and Codex share `.agents/skills` but have different config
  formats and lifecycle mechanisms.
- Consequences: OpenCode receives `mcp.loom`, shared skills, and a thin local
  command plugin. Codex receives a marked `mcp_servers.loom` block and shared
  skills; project trust controls whether Codex loads it. New harnesses require a
  tested `HarnessAdapter`; no compatibility is implied without one.

Contract: [`packages/core/src/harness.ts`](../../packages/core/src/harness.ts).
