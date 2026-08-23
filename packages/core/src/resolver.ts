import type {
  CapabilityPlan,
  Policy,
  ProjectProfile,
  ScoredCapability,
  TaskProfile,
} from "./domain.js";
import { evaluatePolicy } from "./policy.js";
import { compareScoredCapabilities } from "./scoring.js";

export interface ResolveOptions {
  exactCandidateLimit?: number;
  exactNodeLimit?: number;
}

interface Selection {
  selected: ScoredCapability[];
  exact: boolean;
}

export function resolveCapabilities(
  project: ProjectProfile,
  task: TaskProfile | undefined,
  scored: readonly ScoredCapability[],
  policy: Policy,
  options: ResolveOptions = {},
): CapabilityPlan {
  const ordered = [...scored].sort(compareScoredCapabilities);
  const eligible: ScoredCapability[] = [];
  const rejected: CapabilityPlan["rejected"] = [];
  const decisions = new Map<string, ReturnType<typeof evaluatePolicy>>();
  for (const capability of ordered) {
    const decision = evaluatePolicy(capability.candidate, policy, task);
    decisions.set(capability.candidate.id, decision);
    if (decision.decision === "blocked")
      rejected.push({ capability, reason: decision.reasons.join("; ") });
    else if (capability.score < policy.capabilities.minScore)
      rejected.push({
        capability,
        reason: `score ${capability.score} is below policy minimum ${policy.capabilities.minScore}`,
      });
    else eligible.push(capability);
  }

  const required = [...new Set(task?.requiredCapabilities ?? [])].sort();
  const selection = selectMinimumSet(eligible, required, options);
  const selectedIds = new Set(
    selection.selected.map((item) => item.candidate.id),
  );
  const selectedCoverage = new Map<string, string>();
  for (const item of selection.selected)
    for (const coverage of item.coverage)
      if (!selectedCoverage.has(coverage))
        selectedCoverage.set(coverage, item.candidate.id);

  const optional: ScoredCapability[] = [];
  for (const capability of eligible) {
    if (selectedIds.has(capability.candidate.id)) continue;
    const overlap = capability.coverage.filter((coverage) =>
      selectedCoverage.has(coverage),
    );
    if (overlap.length > 0) {
      const replacements = [
        ...new Set(
          overlap
            .map((coverage) => selectedCoverage.get(coverage))
            .filter((id): id is string => Boolean(id)),
        ),
      ].sort();
      const costs = explainAddedCost(capability);
      rejected.push({
        capability,
        reason: `${replacements.join(", ")} already cover${replacements.length === 1 ? "s" : ""} ${overlap.sort().join(", ")}; adding ${capability.candidate.id} increases ${costs.join(" and ")}`,
      });
    } else optional.push(capability);
  }

  const covered = new Set(selection.selected.flatMap((item) => item.coverage));
  const requiredApprovals = selection.selected
    .map((item) => ({ item, decision: decisions.get(item.candidate.id) }))
    .filter((value) => value.decision?.decision === "approval-required")
    .map(({ item, decision }) => ({
      capabilityId: item.candidate.id,
      reasons: decision?.reasons ?? [],
    }))
    .sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));

  return {
    project,
    ...(task ? { task } : {}),
    selected: selection.selected.sort(compareScoredCapabilities),
    optional: optional.sort(compareScoredCapabilities),
    rejected: rejected.sort((a, b) =>
      a.capability.candidate.id.localeCompare(b.capability.candidate.id),
    ),
    uncovered: required.filter((item) => !covered.has(item)),
    requiredApprovals,
  };
}

function selectMinimumSet(
  candidates: readonly ScoredCapability[],
  required: readonly string[],
  options: ResolveOptions,
): Selection {
  if (required.length === 0) return { selected: [], exact: true };
  const useful = candidates.filter((candidate) =>
    candidate.coverage.some((item) => required.includes(item)),
  );
  const exactLimit = options.exactCandidateLimit ?? 20;
  if (useful.length <= exactLimit) {
    const exact = exactSetCover(
      useful,
      new Set(required),
      options.exactNodeLimit ?? 100_000,
    );
    if (exact) return { selected: exact, exact: true };
  }
  return { selected: greedySetCover(useful, new Set(required)), exact: false };
}

function exactSetCover(
  candidates: readonly ScoredCapability[],
  required: ReadonlySet<string>,
  nodeLimit: number,
): ScoredCapability[] | undefined {
  let nodes = 0;
  let best: ScoredCapability[] | undefined;
  let bestCost = Number.POSITIVE_INFINITY;
  const visit = (
    index: number,
    selected: ScoredCapability[],
    covered: Set<string>,
  ): void => {
    if (++nodes > nodeLimit) return;
    if ([...required].every((item) => covered.has(item))) {
      const cost = selectionCost(selected);
      if (
        cost < bestCost ||
        (cost === bestCost && ids(selected) < ids(best ?? []))
      ) {
        best = [...selected];
        bestCost = cost;
      }
      return;
    }
    if (index >= candidates.length || selectionCost(selected) >= bestCost)
      return;
    const candidate = candidates[index];
    if (!candidate) return;
    const nextCovered = new Set(covered);
    for (const item of candidate.coverage)
      if (required.has(item)) nextCovered.add(item);
    if (nextCovered.size > covered.size)
      visit(index + 1, [...selected, candidate], nextCovered);
    visit(index + 1, selected, covered);
  };
  visit(0, [], new Set());
  return nodes > nodeLimit ? undefined : best;
}

function greedySetCover(
  candidates: readonly ScoredCapability[],
  required: ReadonlySet<string>,
): ScoredCapability[] {
  const uncovered = new Set(required);
  const remaining = [...candidates];
  const selected: ScoredCapability[] = [];
  while (uncovered.size > 0) {
    remaining.sort((a, b) => {
      const aGain = a.coverage.filter((item) => uncovered.has(item)).length;
      const bGain = b.coverage.filter((item) => uncovered.has(item)).length;
      const aRatio = aGain / candidateCost(a);
      const bRatio = bGain / candidateCost(b);
      return (
        bRatio - aRatio || bGain - aGain || compareScoredCapabilities(a, b)
      );
    });
    const next = remaining.shift();
    if (!next || !next.coverage.some((item) => uncovered.has(item))) break;
    selected.push(next);
    for (const item of next.coverage) uncovered.delete(item);
  }
  return selected;
}

function selectionCost(selected: readonly ScoredCapability[]): number {
  const groups = new Map<string, number>();
  let cost = selected.length * 1_000;
  for (const item of selected) {
    cost += candidateCost(item);
    for (const group of item.candidate.overlapGroups)
      groups.set(group, (groups.get(group) ?? 0) + 1);
  }
  for (const count of groups.values()) if (count > 1) cost += (count - 1) * 100;
  return cost;
}

function candidateCost(item: ScoredCapability): number {
  const permissions = item.candidate.permissions;
  const privilege =
    (permissions.filesystem === "write"
      ? 30
      : permissions.filesystem === "read"
        ? 5
        : 0) +
    Number(permissions.shell) * 30 +
    Number(permissions.network) * 8 +
    permissions.secrets.length * 15 +
    (permissions.database === "write"
      ? 35
      : permissions.database === "read"
        ? 8
        : 0) +
    Number(permissions.device) * 25;
  const runtime =
    item.candidate.runtime?.kind === "docker"
      ? 20
      : item.candidate.runtime?.kind === "binary" ||
          item.candidate.runtime?.kind === "remote"
        ? 12
        : 5;
  return (
    item.candidate.contextCost * 2 + privilege + runtime + (100 - item.score)
  );
}

function explainAddedCost(item: ScoredCapability): string[] {
  const costs: string[] = [];
  if (
    item.candidate.permissions.filesystem === "write" ||
    item.candidate.permissions.shell ||
    item.candidate.permissions.database === "write" ||
    item.candidate.permissions.device
  )
    costs.push("privilege");
  if (item.candidate.contextCost > 0) costs.push("context/tool surface");
  if (item.candidate.runtime) costs.push("runtime complexity");
  return costs.length > 0 ? costs : ["duplicate overlap"];
}

function ids(items: readonly ScoredCapability[]): string {
  return items
    .map((item) => item.candidate.id)
    .sort()
    .join("\0");
}
