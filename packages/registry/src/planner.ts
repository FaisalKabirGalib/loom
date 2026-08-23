import {
  classifyTask,
  detectProject,
  policySchema,
  resolveCapabilities,
  scoreCapabilities,
  type CapabilityCandidate,
  type CapabilityPlan,
  type Policy,
  type ProjectProfile,
  type TaskProfile,
} from "@loom/core";
import { composeProfiles } from "@loom/profiles";

import { BuiltinRegistry } from "./builtin.js";
import type { CapabilityRegistry } from "./types.js";

export interface PlanProjectOptions {
  task?: string;
  policy?: Policy;
  registries?: readonly CapabilityRegistry[];
  now?: Date;
}

export interface ProjectResolution {
  project: ProjectProfile;
  task: TaskProfile;
  candidates: CapabilityCandidate[];
  plan: CapabilityPlan;
}

export async function planProject(
  root: string,
  options: PlanProjectOptions = {},
): Promise<ProjectResolution> {
  const project = detectProject(root);
  const profiles = composeProfiles(project);
  const task = classifyTask(options.task ?? "", project, {
    requiredCapabilities: profiles.requiredCapabilities,
    usefulCapabilities: profiles.usefulCapabilities,
  });
  const registries = options.registries ?? [new BuiltinRegistry()];
  const results = await Promise.all(
    registries.flatMap((registry) => {
      if (registry.id === "builtin") return [registry.search({ limit: 100 })];
      const terms = discoveryTerms(project, task);
      return terms.map((text) => registry.search({ text, limit: 30 }));
    }),
  );
  const candidates = deduplicate(results.flat());
  const scoreOptions = options.now === undefined ? {} : { now: options.now };
  const scored = scoreCapabilities(candidates, project, task, scoreOptions);
  const plan = resolveCapabilities(
    project,
    task,
    scored,
    options.policy ?? policySchema.parse({}),
  );
  return { project, task, candidates, plan };
}

function discoveryTerms(project: ProjectProfile, task: TaskProfile): string[] {
  return [
    ...new Set([
      ...task.requiredCapabilities.map(capabilityTerm),
      ...task.usefulCapabilities.map(capabilityTerm),
      ...project.frameworks,
      ...project.services,
    ]),
  ]
    .filter(Boolean)
    .slice(0, 5);
}

function capabilityTerm(capability: string): string {
  return capability.split(".").at(-1)?.replaceAll("-", " ") ?? capability;
}

function deduplicate(
  candidates: readonly CapabilityCandidate[],
): CapabilityCandidate[] {
  const byId = new Map<string, CapabilityCandidate>();
  for (const candidate of candidates) {
    const current = byId.get(candidate.id);
    if (!current || compareVersion(candidate.version, current.version) > 0) {
      byId.set(candidate.id, candidate);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function compareVersion(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  const left = semanticVersion(a);
  const right = semanticVersion(b);
  if (left !== null && right !== null) {
    for (let index = 0; index < 3; index += 1) {
      const difference = left.numbers[index]! - right.numbers[index]!;
      if (difference !== 0) return difference;
    }
    if (left.prerelease === right.prerelease) return 0;
    if (left.prerelease === undefined) return 1;
    if (right.prerelease === undefined) return -1;
    return left.prerelease.localeCompare(right.prerelease, undefined, {
      numeric: true,
    });
  }
  return a.localeCompare(b, undefined, { numeric: true });
}

function semanticVersion(
  value: string,
): { numbers: [number, number, number]; prerelease?: string } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.+)?$/u.exec(value);
  if (match === null) return null;
  const numbers = match.slice(1, 4).map(Number) as [number, number, number];
  return {
    numbers,
    ...(match[4] === undefined ? {} : { prerelease: match[4] }),
  };
}
