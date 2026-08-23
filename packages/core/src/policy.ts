import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "smol-toml";
import {
  policySchema,
  type CapabilityCandidate,
  type Policy,
  type TaskProfile,
  type TrustTier,
} from "./domain.js";
import { resolveLoomPaths } from "./paths.js";

const TRUST: readonly TrustTier[] = [
  "blocked",
  "experimental",
  "community",
  "community-reviewed",
  "verified-maintainer",
  "official",
];

export type PolicyDecision = "allowed" | "approval-required" | "blocked";

export interface PolicyEvaluation {
  decision: PolicyDecision;
  reasons: string[];
}

export function parsePolicyToml(
  source: string,
  base: Policy = policySchema.parse({}),
): Policy {
  const document = parse(source) as Record<string, unknown>;
  const mcp = record(document.mcp);
  const database = record(document.database);
  const skills = record(document.skills);
  const capabilities = record(document.capabilities);
  return policySchema.parse({
    mcp: {
      allowRemote: mcp.allow_remote ?? base.mcp.allowRemote,
      allowShell: mcp.allow_shell ?? base.mcp.allowShell,
    },
    database: { maxAccess: database.max_access ?? base.database.maxAccess },
    skills: {
      requireReviewForScripts:
        skills.require_review_for_scripts ??
        base.skills.requireReviewForScripts,
    },
    capabilities: {
      minScore:
        capabilities.min_score ??
        capabilities.min_trust_score ??
        base.capabilities.minScore,
      minTrustTier:
        capabilities.min_trust_tier ?? base.capabilities.minTrustTier,
    },
  });
}

export async function loadEffectivePolicy(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Policy> {
  let policy = policySchema.parse({});
  for (const path of [
    join(resolveLoomPaths(environment).config, "preferences.toml"),
    join(root, ".loom", "policy.toml"),
  ]) {
    try {
      policy = parsePolicyToml(await readFile(path, "utf8"), policy);
    } catch (error) {
      if (isMissing(error)) continue;
      throw new Error(`Invalid Loom policy at ${path}: ${message(error)}`);
    }
  }
  return policy;
}

export function mergePolicies(base: Policy, override: Policy): Policy {
  return policySchema.parse({
    mcp: { ...base.mcp, ...override.mcp },
    database: { ...base.database, ...override.database },
    skills: { ...base.skills, ...override.skills },
    capabilities: { ...base.capabilities, ...override.capabilities },
  });
}

export function evaluatePolicy(
  candidate: CapabilityCandidate,
  policy: Policy,
  task?: TaskProfile,
): PolicyEvaluation {
  const blocked: string[] = [];
  const approvals: string[] = [];
  const unfamiliar =
    !candidate.provenance.official && !candidate.provenance.knownMaintainer;
  const labels = [...candidate.tags, ...candidate.notes].join(" ");

  if (candidate.trustTier === "blocked")
    blocked.push("candidate trust tier is blocked");
  if (
    TRUST.indexOf(candidate.trustTier) <
    TRUST.indexOf(policy.capabilities.minTrustTier)
  ) {
    blocked.push(
      `trust tier ${candidate.trustTier} is below policy minimum ${policy.capabilities.minTrustTier}`,
    );
  }
  if (candidate.provenance.packageRepositoryMatch === false)
    blocked.push("package and repository provenance mismatch");
  if (
    unfamiliar &&
    !candidate.provenance.repositoryVerified &&
    !candidate.provenance.namespaceVerified
  ) {
    blocked.push("unresolved provenance");
  }
  if (/deprecated with (a )?(known )?replacement/i.test(labels))
    blocked.push("deprecated with known replacement");
  if (/unsafe installer|curl\s*\|\s*(bash|sh)/i.test(labels))
    blocked.push("unsafe installer");
  if (candidate.runtime?.kind === "binary" && /suspicious binary/i.test(labels))
    blocked.push("suspicious binary");
  if (
    candidate.kind === "mcp" &&
    candidate.transport === "http" &&
    !policy.mcp.allowRemote
  ) {
    blocked.push("remote MCP is disabled by policy");
  }
  if (
    candidate.kind === "mcp" &&
    candidate.permissions.shell &&
    !policy.mcp.allowShell
  )
    blocked.push("shell execution is disabled by policy");
  if (
    accessRank(candidate.permissions.database) >
    accessRank(policy.database.maxAccess)
  ) {
    blocked.push(
      `database ${candidate.permissions.database} exceeds policy maximum ${policy.database.maxAccess}`,
    );
  }

  if (
    candidate.kind === "mcp" &&
    unfamiliar &&
    candidate.trustTier === "community"
  )
    approvals.push("unknown community capability");
  if (candidate.permissions.filesystem === "write" && unfamiliar)
    approvals.push("filesystem write from unfamiliar source");
  if (candidate.permissions.shell && unfamiliar)
    approvals.push("shell execution from unfamiliar source");
  if (candidate.permissions.database === "write")
    approvals.push("database write access");
  if (candidate.permissions.device) approvals.push("device control");
  if (candidate.permissions.secrets.length > 0)
    approvals.push("secret or API-key access");
  if (candidate.transport === "http" && !candidate.provenance.official)
    approvals.push("remote third-party data access");
  if (/production|cloud[- ]write/i.test(labels))
    approvals.push("production or cloud write access");
  if (
    candidate.tags.some((tag) =>
      /runtime-(patch|instrumentation)|experimental-runtime/i.test(tag),
    )
  ) {
    approvals.push("experimental runtime instrumentation");
  }
  if (
    candidate.kind === "skill" &&
    policy.skills.requireReviewForScripts &&
    candidate.permissions.shell
  ) {
    approvals.push("skill scripts require review");
  }
  if (task?.risk === "high" && candidate.permissions.filesystem === "write")
    approvals.push("high-risk task with write access");

  const reasons = [...new Set(blocked.length > 0 ? blocked : approvals)].sort();
  return {
    decision:
      blocked.length > 0
        ? "blocked"
        : approvals.length > 0
          ? "approval-required"
          : "allowed",
    reasons,
  };
}

export function compareTrust(a: TrustTier, b: TrustTier): number {
  return TRUST.indexOf(a) - TRUST.indexOf(b);
}

function accessRank(value: "none" | "read" | "write"): number {
  return value === "none" ? 0 : value === "read" ? 1 : 2;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
