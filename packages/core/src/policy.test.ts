import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadEffectivePolicy } from "./policy.js";

describe("loadEffectivePolicy", () => {
  it("layers project policy over user preferences without resetting omitted values", async () => {
    const root = await mkdtemp(join(tmpdir(), "loom-policy-project-"));
    const config = await mkdtemp(join(tmpdir(), "loom-policy-config-"));
    await mkdir(join(config, "loom"));
    await mkdir(join(root, ".loom"));
    await writeFile(
      join(config, "loom/preferences.toml"),
      "[capabilities]\nmin_trust_score = 72\n[mcp]\nallow_remote = true\n",
    );
    await writeFile(
      join(root, ".loom/policy.toml"),
      "[mcp]\nallow_shell = true\n[database]\nmax_access = 'none'\n",
    );

    const policy = await loadEffectivePolicy(root, {
      XDG_CONFIG_HOME: config,
      HOME: tmpdir(),
    });

    expect(policy).toMatchObject({
      mcp: { allowRemote: true, allowShell: true },
      database: { maxAccess: "none" },
      capabilities: { minScore: 72 },
    });
  });
});
