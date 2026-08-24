import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import architectureReview from "../packages/skills/loom-architecture-review/SKILL.md" with { type: "file" };
import dependencyResearch from "../packages/skills/loom-dependency-research/SKILL.md" with { type: "file" };
import designDirector from "../packages/skills/loom-design-director/SKILL.md" with { type: "file" };
import functionalCore from "../packages/skills/loom-functional-core/SKILL.md" with { type: "file" };
import projectHydrate from "../packages/skills/loom-project-hydrate/SKILL.md" with { type: "file" };
import projectStart from "../packages/skills/loom-project-start/SKILL.md" with { type: "file" };
import projectSetup from "../packages/skills/loom-project-setup/SKILL.md" with { type: "file" };
import verificationLoop from "../packages/skills/loom-verification-loop/SKILL.md" with { type: "file" };

const skills = {
  "loom-architecture-review": architectureReview,
  "loom-dependency-research": dependencyResearch,
  "loom-design-director": designDirector,
  "loom-functional-core": functionalCore,
  "loom-project-hydrate": projectHydrate,
  "loom-project-start": projectStart,
  "loom-project-setup": projectSetup,
  "loom-verification-loop": verificationLoop,
};

const skillsRoot = await mkdtemp(join(tmpdir(), "loom-skills-"));
try {
  for (const [name, source] of Object.entries(skills)) {
    const directory = join(skillsRoot, name);
    await mkdir(directory);
    await writeFile(join(directory, "SKILL.md"), await readFile(source));
  }

  Reflect.set(globalThis, Symbol.for("loom.cli.disable-auto-entry"), true);
  const { configureCliRuntime, runCli } =
    await import("../packages/cli/src/index.js");
  configureCliRuntime({
    skillsPath: skillsRoot,
    executablePath: process.execPath,
  });
  process.exitCode = await runCli();
} finally {
  await rm(skillsRoot, { recursive: true, force: true });
}
