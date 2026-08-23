import { z } from "zod";

export const lifecycleSchema = z.enum(["greenfield", "brownfield"]);
export const capabilityKindSchema = z.enum([
  "mcp",
  "skill",
  "plugin",
  "cli",
  "framework-tool",
]);
export const scopeSchema = z.enum(["global", "project", "on-demand"]);
export const trustTierSchema = z.enum([
  "official",
  "verified-maintainer",
  "community-reviewed",
  "community",
  "experimental",
  "blocked",
]);

export const detectionSignalSchema = z.object({
  detector: z.string(),
  message: z.string(),
  path: z.string().optional(),
  evidence: z.string().optional(),
});

export const projectProfileSchema = z.object({
  root: z.string(),
  lifecycle: lifecycleSchema,
  languages: z.array(z.string()),
  frameworks: z.array(z.string()),
  packageManagers: z.array(z.string()),
  dependencies: z.record(z.string(), z.string()),
  devDependencies: z.record(z.string(), z.string()),
  web: z.boolean(),
  ui: z.boolean(),
  mobile: z.boolean(),
  api: z.boolean(),
  database: z.boolean(),
  monorepo: z.boolean(),
  services: z.array(z.string()),
  existingAgentConfigs: z.array(z.string()),
  detectionSignals: z.array(detectionSignalSchema),
});

export const taskProfileSchema = z.object({
  summary: z.string().optional(),
  intents: z.array(z.string()),
  requiredCapabilities: z.array(z.string()),
  usefulCapabilities: z.array(z.string()),
  risk: z.enum(["low", "medium", "high"]),
});

export const permissionsSchema = z.object({
  filesystem: z.enum(["none", "read", "write"]),
  shell: z.boolean(),
  network: z.boolean(),
  secrets: z.array(z.string()),
  database: z.enum(["none", "read", "write"]),
  device: z.boolean(),
});

export const provenanceSchema = z.object({
  official: z.boolean(),
  namespaceVerified: z.boolean(),
  knownMaintainer: z.boolean(),
  repositoryVerified: z.boolean(),
  packageRepositoryMatch: z.boolean().optional(),
});

export const capabilityCandidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: capabilityKindSchema,
  source: z.object({
    registry: z.string(),
    repository: z.string().optional(),
    package: z.string().optional(),
    publisher: z.string().optional(),
  }),
  version: z.string().optional(),
  updatedAt: z.string().optional(),
  ecosystems: z.array(z.string()),
  provides: z.array(z.string()),
  tags: z.array(z.string()),
  transport: z.enum(["stdio", "http"]).optional(),
  runtime: z
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
      args: z.array(z.string()).optional(),
    })
    .optional(),
  permissions: permissionsSchema,
  provenance: provenanceSchema,
  metrics: z
    .object({
      stars: z.number().nonnegative().optional(),
      installs: z.number().nonnegative().optional(),
      registryScore: z.number().min(0).max(100).optional(),
      toolCount: z.number().nonnegative().optional(),
    })
    .optional(),
  overlapGroups: z.array(z.string()),
  recommendedScope: scopeSchema,
  trustTier: trustTierSchema,
  taskTriggers: z.array(z.string()).default([]),
  contextCost: z.number().min(0).max(100).default(20),
  portability: z.number().min(0).max(100).default(50),
  notes: z.array(z.string()).default([]),
});

export const scoreBreakdownSchema = z.object({
  taskFit: z.number(),
  projectFit: z.number(),
  coverage: z.number(),
  maintenance: z.number(),
  provenance: z.number(),
  security: z.number(),
  contextEfficiency: z.number(),
  portability: z.number(),
  penalties: z.number(),
});

export const scoredCapabilitySchema = z.object({
  candidate: capabilityCandidateSchema,
  score: z.number(),
  reasons: z.array(z.string()),
  penalties: z.array(z.string()),
  coverage: z.array(z.string()),
  breakdown: scoreBreakdownSchema,
});

export const approvalRequestSchema = z.object({
  capabilityId: z.string(),
  reasons: z.array(z.string()),
});

export const rejectedCapabilitySchema = z.object({
  capability: scoredCapabilitySchema,
  reason: z.string(),
});

export const capabilityPlanSchema = z.object({
  project: projectProfileSchema,
  task: taskProfileSchema.optional(),
  selected: z.array(scoredCapabilitySchema),
  optional: z.array(scoredCapabilitySchema),
  rejected: z.array(rejectedCapabilitySchema),
  uncovered: z.array(z.string()),
  requiredApprovals: z.array(approvalRequestSchema),
});

export const policySchema = z.object({
  mcp: z
    .object({
      allowRemote: z.boolean().default(false),
      allowShell: z.boolean().default(false),
    })
    .default({ allowRemote: false, allowShell: false }),
  database: z
    .object({
      maxAccess: z.enum(["none", "read", "write"]).default("read"),
    })
    .default({ maxAccess: "read" }),
  skills: z
    .object({
      requireReviewForScripts: z.boolean().default(true),
    })
    .default({ requireReviewForScripts: true }),
  capabilities: z
    .object({
      minScore: z.number().min(0).max(100).default(50),
      minTrustTier: trustTierSchema.default("community"),
    })
    .default({ minScore: 50, minTrustTier: "community" }),
});

export type Lifecycle = z.infer<typeof lifecycleSchema>;
export type CapabilityKind = z.infer<typeof capabilityKindSchema>;
export type Scope = z.infer<typeof scopeSchema>;
export type TrustTier = z.infer<typeof trustTierSchema>;
export type DetectionSignal = z.infer<typeof detectionSignalSchema>;
export type ProjectProfile = z.infer<typeof projectProfileSchema>;
export type TaskProfile = z.infer<typeof taskProfileSchema>;
export type Permissions = z.infer<typeof permissionsSchema>;
export type CapabilityCandidate = z.infer<typeof capabilityCandidateSchema>;
export type ScoredCapability = z.infer<typeof scoredCapabilitySchema>;
export type CapabilityPlan = z.infer<typeof capabilityPlanSchema>;
export type Policy = z.infer<typeof policySchema>;
