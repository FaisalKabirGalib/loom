import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import manifest from "../package.json";

const expectedTag = `v${manifest.version}`;
const releaseTag = process.env["GITHUB_REF_NAME"];
if (releaseTag !== undefined && releaseTag !== expectedTag) {
  throw new Error(`Release tag ${releaseTag} does not match ${expectedTag}`);
}

const outputDirectory = join(import.meta.dir, "..", "release");
const targets = [
  ["linux-x64", "bun-linux-x64"],
  ["linux-arm64", "bun-linux-arm64"],
  ["darwin-x64", "bun-darwin-x64"],
  ["darwin-arm64", "bun-darwin-arm64"],
  ["windows-x64.exe", "bun-windows-x64"],
] as const;

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const artifacts: string[] = [];
for (const [platform, target] of targets) {
  const filename = `loom-v${manifest.version}-${platform}`;
  const outfile = join(outputDirectory, filename);
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "standalone.ts")],
    compile: { target, outfile },
    minify: true,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Failed to build ${target}`);
  }
  artifacts.push(filename);
}

const checksums: string[] = [];
for (const filename of artifacts) {
  const content = await Bun.file(join(outputDirectory, filename)).arrayBuffer();
  checksums.push(
    `${createHash("sha256").update(new Uint8Array(content)).digest("hex")}  ${filename}`,
  );
}
await Bun.write(
  join(outputDirectory, "SHA256SUMS"),
  `${checksums.join("\n")}\n`,
);
