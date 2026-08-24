import { z } from "zod";
import type { CapabilityPlan, ScoredCapability } from "./domain.js";
import {
  capabilityKindSchema,
  permissionsSchema,
  scopeSchema,
  trustTierSchema,
} from "./domain.js";

const exactVersionSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value === value.trim() &&
      value.toLowerCase() !== "latest" &&
      !/[\s*^~<>=|]/u.test(value) &&
      !/(?:^|[.-])[xX](?:$|[.-])/u.test(value),
    "lock version must be exact",
  );
const lockSourceSchema = z
  .object({
    registry: z.string().min(1),
    repository: z.string().optional(),
    package: z.string().optional(),
  })
  .strict();
const lockRuntimeSchema = z
  .object({
    kind: z.enum([
      "node",
      "python",
      "go",
      "dart",
      "docker",
      "binary",
      "remote",
    ]),
    command: z.string().optional(),
  })
  .strict();

export const capabilityLockEntrySchema = z
  .object({
    id: z.string().min(1),
    kind: capabilityKindSchema,
    source: lockSourceSchema,
    version: exactVersionSchema,
    transport: z.enum(["stdio", "http"]).optional(),
    runtime: lockRuntimeSchema.optional(),
    trustTier: trustTierSchema,
    permissions: permissionsSchema,
    scope: scopeSchema,
    reasons: z.array(z.string()),
    overlapGroups: z.array(z.string()),
    ownership: z.enum(["loom", "external"]),
    state: z.enum(["recommended", "approved", "installed", "active"]),
  })
  .strict();

export const capabilityLockSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().datetime(),
    entries: z.array(capabilityLockEntrySchema),
    harnesses: z
      .record(z.string(), z.array(capabilityLockEntrySchema))
      .default({}),
  })
  .strict();

export type CapabilityLockEntry = z.infer<typeof capabilityLockEntrySchema>;
export type CapabilityLock = z.infer<typeof capabilityLockSchema>;

export interface CreateLockOptions {
  generatedAt?: Date;
  ownership?: Readonly<Record<string, "loom" | "external">>;
  states?: Readonly<
    Record<string, "recommended" | "approved" | "installed" | "active">
  >;
}

export function createCapabilityLock(
  plan: CapabilityPlan,
  options: CreateLockOptions = {},
): CapabilityLock {
  const approvalRequired = new Set(
    plan.requiredApprovals.map((request) => request.capabilityId),
  );
  const entries = plan.selected
    .map((item) =>
      toLockEntry(item, options, approvalRequired.has(item.candidate.id)),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  return capabilityLockSchema.parse({
    schemaVersion: 1,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    entries,
  });
}

export function serializeCapabilityLock(lock: CapabilityLock): string {
  const parsed = capabilityLockSchema.parse(lock);
  return `${JSON.stringify(redactLockSecrets(parsed), null, 2)}\n`;
}

export function parseCapabilityLock(source: string): CapabilityLock {
  return capabilityLockSchema.parse(JSON.parse(source) as unknown);
}

export function redactLockSecrets<T>(value: T): T {
  return sanitize(value, []) as T;
}

function toLockEntry(
  item: ScoredCapability,
  options: CreateLockOptions,
  approvalRequired: boolean,
): CapabilityLockEntry {
  const candidate = item.candidate;
  if (!candidate.version)
    throw new Error(
      `cannot lock ${candidate.id}: exact version or revision is required`,
    );
  const source = {
    registry: candidate.source.registry,
    ...(candidate.source.repository
      ? { repository: candidate.source.repository }
      : {}),
    ...(candidate.source.package ? { package: candidate.source.package } : {}),
  };
  return capabilityLockEntrySchema.parse({
    id: candidate.id,
    kind: candidate.kind,
    source,
    version: candidate.version,
    ...(candidate.transport ? { transport: candidate.transport } : {}),
    ...(candidate.runtime
      ? {
          runtime: {
            kind: candidate.runtime.kind,
            ...(candidate.runtime.command
              ? { command: candidate.runtime.command }
              : {}),
          },
        }
      : {}),
    trustTier: candidate.trustTier,
    permissions: candidate.permissions,
    scope: candidate.recommendedScope,
    reasons: [...item.reasons],
    overlapGroups: [...candidate.overlapGroups].sort(),
    ownership: options.ownership?.[candidate.id] ?? "external",
    state:
      options.states?.[candidate.id] ??
      (approvalRequired ? "recommended" : "approved"),
  });
}

function sanitize(
  value: unknown,
  path: readonly string[],
  permissionName = false,
): unknown {
  if (Array.isArray(value)) {
    const preservePermissionNames =
      path.at(-2) === "permissions" && path.at(-1) === "secrets";
    return value.map((item) => sanitize(item, path, preservePermissionNames));
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        sanitize(item, [...path, name]),
      ]),
    );
  if (typeof value !== "string") return value;
  const key = path.at(-1) ?? "";
  if (
    /password|secret|token|credential|authorization|api[-_]?key|dsn/i.test(
      key,
    ) &&
    !permissionName
  )
    return "[REDACTED]";
  return value
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(
      /\b(password|secret|token|api[-_]?key)=([^\s&]+)/gi,
      "$1=[REDACTED]",
    );
}
