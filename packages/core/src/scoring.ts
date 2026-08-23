import type {
  CapabilityCandidate,
  ProjectProfile,
  ScoredCapability,
  TaskProfile,
} from "./domain.js";

export const SCORE_WEIGHTS = {
  taskFit: 25,
  projectFit: 20,
  coverage: 15,
  maintenance: 10,
  provenance: 10,
  security: 10,
  contextEfficiency: 5,
  portability: 5,
} as const;

export const SCORE_PENALTIES = {
  stale: 8,
  deprecated: 20,
  provenanceMismatch: 30,
  unknownBinary: 15,
  filesystemWrite: 6,
  shell: 8,
  network: 3,
  unrelatedSecrets: 8,
  databaseWrite: 10,
  hugeToolSurface: 8,
  unclearTelemetry: 5,
  duplicateCoverage: 5,
  experimentalRuntime: 10,
  unverifiedInstaller: 15,
  ecosystemMismatch: 25,
} as const;

export interface ScoreCapabilityOptions {
  now?: Date;
  coveredBySelected?: ReadonlySet<string>;
}

export function scoreCapability(
  candidate: CapabilityCandidate,
  project: ProjectProfile,
  task?: TaskProfile,
  options: ScoreCapabilityOptions = {},
): ScoredCapability {
  const wanted = new Set([
    ...(task?.requiredCapabilities ?? []),
    ...(task?.usefulCapabilities ?? []),
  ]);
  const required = new Set(task?.requiredCapabilities ?? []);
  const coverage = candidate.provides.filter((item) => wanted.has(item)).sort();
  const requiredCoverage = coverage.filter((item) => required.has(item));
  const taskTerms = new Set([
    ...(task?.intents ?? []),
    ...(task?.summary?.toLowerCase().split(/\W+/) ?? []),
  ]);
  const triggerHits = candidate.taskTriggers.filter((trigger) =>
    taskTerms.has(trigger.toLowerCase()),
  ).length;
  const taskFitRatio = task
    ? Math.min(
        1,
        (required.size > 0
          ? ratio(requiredCoverage.length, required.size)
          : wanted.size === 0
            ? 0.25
            : ratio(coverage.length, wanted.size)) +
          Math.min(0.25, triggerHits * 0.125),
      )
    : 0.5;
  const projectTerms = new Set(
    [
      ...project.languages,
      ...project.frameworks,
      ...project.packageManagers,
      ...project.services,
      ...Object.keys(project.dependencies),
      ...Object.keys(project.devDependencies),
      ...(project.web ? ["web"] : []),
      ...(project.ui ? ["ui"] : []),
      ...(project.mobile ? ["mobile"] : []),
      ...(project.api ? ["api"] : []),
      ...(project.database ? ["database"] : []),
    ].map((value) => value.toLowerCase()),
  );
  const ecosystemHits = candidate.ecosystems.filter((item) =>
    projectTerms.has(item.toLowerCase()),
  ).length;
  const genericEcosystem = candidate.ecosystems.some((item) =>
    ["all", "any", "code", "git", "packages"].includes(item.toLowerCase()),
  );
  const projectFitRatio =
    candidate.ecosystems.length === 0
      ? 0.5
      : ecosystemHits > 0
        ? Math.min(1, 0.75 + ecosystemHits * 0.125)
        : genericEcosystem
          ? 0.6
          : 0;
  const maintenance = maintenancePoints(
    candidate.updatedAt,
    options.now ?? new Date(),
  );
  const provenance = provenancePoints(candidate);
  const security = securityPoints(candidate);
  const breakdown = {
    taskFit: round(SCORE_WEIGHTS.taskFit * taskFitRatio),
    projectFit: round(SCORE_WEIGHTS.projectFit * projectFitRatio),
    coverage: round(
      SCORE_WEIGHTS.coverage *
        (required.size > 0
          ? ratio(requiredCoverage.length, required.size)
          : wanted.size === 0
            ? 0.5
            : ratio(coverage.length, wanted.size)),
    ),
    maintenance,
    provenance,
    security,
    contextEfficiency: round(
      SCORE_WEIGHTS.contextEfficiency * (1 - candidate.contextCost / 100),
    ),
    portability: round(
      (SCORE_WEIGHTS.portability * candidate.portability) / 100,
    ),
    penalties: 0,
  };
  const penalties = collectPenalties(
    candidate,
    task,
    options.coveredBySelected,
    options.now ?? new Date(),
    candidate.ecosystems.length > 0 && ecosystemHits === 0 && !genericEcosystem,
  );
  breakdown.penalties = -penalties.reduce((sum, item) => sum + item.points, 0);
  const score = Math.max(
    0,
    Math.min(
      100,
      round(Object.values(breakdown).reduce((sum, value) => sum + value, 0)),
    ),
  );
  const reasons = buildReasons(
    candidate,
    coverage,
    ecosystemHits,
    maintenance,
    provenance,
    security,
  );
  return {
    candidate,
    score,
    reasons,
    penalties: penalties.map((item) => `-${item.points} ${item.reason}`),
    coverage,
    breakdown,
  };
}

export function scoreCapabilities(
  candidates: readonly CapabilityCandidate[],
  project: ProjectProfile,
  task?: TaskProfile,
  options: ScoreCapabilityOptions = {},
): ScoredCapability[] {
  return candidates
    .map((candidate) => scoreCapability(candidate, project, task, options))
    .sort(compareScoredCapabilities);
}

export function compareScoredCapabilities(
  a: ScoredCapability,
  b: ScoredCapability,
): number {
  return b.score - a.score || a.candidate.id.localeCompare(b.candidate.id);
}

function collectPenalties(
  candidate: CapabilityCandidate,
  task?: TaskProfile,
  covered?: ReadonlySet<string>,
  now = new Date(),
  ecosystemMismatch = false,
): Array<{ reason: string; points: number }> {
  const result: Array<{ reason: string; points: number }> = [];
  const labels = [...candidate.tags, ...candidate.notes].join(" ");
  const add = (condition: boolean, reason: string, points: number): void => {
    if (condition) result.push({ reason, points });
  };
  const updatedAt = candidate.updatedAt
    ? Date.parse(candidate.updatedAt)
    : Number.NaN;
  const staleByAge =
    Number.isFinite(updatedAt) && now.getTime() - updatedAt > 730 * 86_400_000;
  add(
    /\bstale\b/i.test(labels) || staleByAge,
    "stale maintenance",
    SCORE_PENALTIES.stale,
  );
  add(
    /\bdeprecated\b/i.test(labels),
    "deprecated capability",
    SCORE_PENALTIES.deprecated,
  );
  add(
    candidate.provenance.packageRepositoryMatch === false,
    "package/repository mismatch",
    SCORE_PENALTIES.provenanceMismatch,
  );
  add(
    candidate.runtime?.kind === "binary" &&
      !candidate.provenance.repositoryVerified,
    "unknown binary provenance",
    SCORE_PENALTIES.unknownBinary,
  );
  add(
    candidate.permissions.filesystem === "write",
    "filesystem write capability",
    SCORE_PENALTIES.filesystemWrite,
  );
  add(
    candidate.permissions.shell,
    "shell execution capability",
    SCORE_PENALTIES.shell,
  );
  add(
    candidate.permissions.network &&
      !taskNeeds(task, /api|network|browser|deploy|docs|research/),
    "network access unrelated to task",
    SCORE_PENALTIES.network,
  );
  add(
    candidate.permissions.secrets.length > 0 &&
      !taskNeeds(task, /secret|auth|deploy|database|api/),
    "secrets unrelated to task",
    SCORE_PENALTIES.unrelatedSecrets,
  );
  add(
    candidate.permissions.database === "write",
    "database write access",
    SCORE_PENALTIES.databaseWrite,
  );
  add(
    (candidate.metrics?.toolCount ?? 0) > 50 || candidate.contextCost >= 80,
    "huge always-loaded tool surface",
    SCORE_PENALTIES.hugeToolSurface,
  );
  add(
    /telemetry/i.test(labels) &&
      !/no telemetry|telemetry disabled/i.test(labels),
    "telemetry behavior is unclear",
    SCORE_PENALTIES.unclearTelemetry,
  );
  add(
    Boolean(covered && candidate.provides.some((item) => covered.has(item))),
    "duplicate capability coverage",
    SCORE_PENALTIES.duplicateCoverage,
  );
  add(
    /runtime-(patch|instrumentation)|experimental-runtime/i.test(labels),
    "experimental runtime patching",
    SCORE_PENALTIES.experimentalRuntime,
  );
  add(
    /curl\s*\|\s*(bash|sh)|unverified installer/i.test(labels),
    "unverified community installer",
    SCORE_PENALTIES.unverifiedInstaller,
  );
  add(
    ecosystemMismatch,
    "no matching project ecosystem",
    SCORE_PENALTIES.ecosystemMismatch,
  );
  return result;
}

function maintenancePoints(updatedAt: string | undefined, now: Date): number {
  if (!updatedAt) return 4;
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return 0;
  const days = Math.max(0, (now.getTime() - timestamp) / 86_400_000);
  return days <= 180 ? 10 : days <= 365 ? 8 : days <= 730 ? 5 : 2;
}

function provenancePoints(candidate: CapabilityCandidate): number {
  const value =
    Number(candidate.provenance.official) * 3 +
    Number(candidate.provenance.namespaceVerified) * 2 +
    Number(candidate.provenance.knownMaintainer) * 2 +
    Number(candidate.provenance.repositoryVerified) * 2 +
    Number(candidate.provenance.packageRepositoryMatch !== false);
  return Math.min(10, value);
}

function securityPoints(candidate: CapabilityCandidate): number {
  let value = 10;
  if (candidate.permissions.filesystem === "read") value -= 1;
  if (candidate.permissions.filesystem === "write") value -= 3;
  if (candidate.permissions.shell) value -= 2;
  if (candidate.permissions.network) value -= 1;
  if (candidate.permissions.secrets.length > 0) value -= 2;
  if (candidate.permissions.database === "read") value -= 1;
  if (candidate.permissions.database === "write") value -= 3;
  if (candidate.permissions.device) value -= 2;
  return Math.max(0, value);
}

function buildReasons(
  candidate: CapabilityCandidate,
  coverage: string[],
  ecosystemHits: number,
  maintenance: number,
  provenance: number,
  security: number,
): string[] {
  const reasons: string[] = [];
  if (coverage.length > 0) reasons.push(`covers ${coverage.join(", ")}`);
  if (ecosystemHits > 0)
    reasons.push(
      `matches ${ecosystemHits} project ecosystem signal${ecosystemHits === 1 ? "" : "s"}`,
    );
  if (maintenance >= 8) reasons.push("actively maintained");
  if (provenance >= 8) reasons.push("strong verified provenance");
  if (security >= 8) reasons.push("bounded permission profile");
  reasons.push(
    `${candidate.recommendedScope} scope; context cost ${candidate.contextCost}/100`,
  );
  return reasons;
}

function taskNeeds(task: TaskProfile | undefined, pattern: RegExp): boolean {
  return Boolean(
    task && pattern.test([task.summary ?? "", ...task.intents].join(" ")),
  );
}

function ratio(value: number, total: number): number {
  return Math.min(1, value / total);
}
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
