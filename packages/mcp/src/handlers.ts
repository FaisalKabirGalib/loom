import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  capabilityLockSchema,
  canonicalJson,
  detectProject,
  encodeSetupIntent,
  loadEffectivePolicy,
  policySchema,
  projectStateSchema,
  projectProfileSchema,
  redactLockSecrets,
  redactSecrets,
  sha256,
  type CapabilityCandidate,
  type CapabilityPlan,
  type Policy,
  type ProjectProfile,
  type TaskProfile,
  workflowStateSchema,
  ownershipStateSchema,
} from "@loom/core";
import {
  BuiltinRegistry,
  GitHubProvenanceRegistry,
  OfficialMcpRegistry,
  capabilityQuerySchema,
  planProject,
  registryVersionSchema,
  type CapabilityQueryInput,
  type CapabilityRegistry,
} from "@loom/registry";
import { z } from "zod";

const MAX_STATE_BYTES = 1_048_576;
const nonBlank = z.string().trim().min(1);
const rootSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0"), "Path contains a null byte")
  .optional();
const networkDiscoverySchema = z.boolean().default(false);
const setupNetworkDiscoverySchema = z.boolean().default(true);

export const projectDetectInputSchema = z.object({ root: rootSchema }).strict();
export const projectPlanInputSchema = z
  .object({
    root: rootSchema,
    task: z.string().trim().max(10_000).optional(),
    policy: policySchema.optional(),
    networkDiscovery: networkDiscoverySchema,
  })
  .strict();
export const explainInputSchema = projectPlanInputSchema;
export const capabilitySearchInputSchema = capabilityQuerySchema
  .omit({ cursor: true, includeDeleted: true })
  .extend({ networkDiscovery: networkDiscoverySchema })
  .strict();
export const capabilityResolveInputSchema = z
  .object({
    id: nonBlank.max(200),
    version: registryVersionSchema.optional(),
    networkDiscovery: networkDiscoverySchema,
  })
  .strict();
export const statusInputSchema = z.object({ root: rootSchema }).strict();
export const setupRecommendInputSchema = z
  .object({
    root: rootSchema,
    task: z.string().trim().min(1).max(10_000).optional(),
    harness: z.literal("opencode").default("opencode"),
    networkDiscovery: setupNetworkDiscoverySchema,
  })
  .strict();

export interface LoomMcpDependencies {
  cwd?: () => string;
  detectProject?: (root: string) => ProjectProfile;
  planProject?: (
    root: string,
    options?: {
      task?: string;
      policy?: Policy;
      registries?: readonly CapabilityRegistry[];
    },
  ) => Promise<ProjectResolution>;
  localRegistries?: readonly CapabilityRegistry[];
  networkRegistries?: () => readonly CapabilityRegistry[];
}

export interface ProjectResolution {
  project: ProjectProfile;
  task: TaskProfile;
  candidates: CapabilityCandidate[];
  plan: CapabilityPlan;
}

type ToolData = Record<string, unknown>;

export interface LoomToolHandlers {
  projectDetect(input: unknown): Promise<ToolData>;
  projectPlan(input: unknown): Promise<ToolData>;
  explain(input: unknown): Promise<ToolData>;
  capabilitySearch(input: unknown): Promise<ToolData>;
  capabilityResolve(input: unknown): Promise<ToolData>;
  capabilityStatus(input: unknown): Promise<ToolData>;
  workflowStatus(input: unknown): Promise<ToolData>;
  doctor(input: unknown): Promise<ToolData>;
  setupRecommend(input: unknown): Promise<ToolData>;
}

interface StateResult {
  status: "absent" | "valid" | "invalid";
  path: string;
  value?: unknown;
  error?: string;
}

export function createLoomToolHandlers(
  dependencies: LoomMcpDependencies = {},
): LoomToolHandlers {
  const cwd = dependencies.cwd ?? (() => process.cwd());
  const detector = dependencies.detectProject ?? detectProject;
  const planner =
    dependencies.planProject ??
    ((root, options = {}) => planProject(root, options));
  const localRegistries = dependencies.localRegistries ?? [
    new BuiltinRegistry(),
  ];
  const networkRegistries =
    dependencies.networkRegistries ??
    (() => [new OfficialMcpRegistry(), new GitHubProvenanceRegistry()]);

  const registriesFor = (
    networkDiscovery: boolean,
  ): readonly CapabilityRegistry[] =>
    networkDiscovery
      ? [...localRegistries, ...networkRegistries()]
      : localRegistries;

  const resolveRoot = async (input: string | undefined): Promise<string> => {
    const candidate = resolve(input ?? cwd());
    const info = await stat(candidate).catch(() => undefined);
    if (!info?.isDirectory())
      throw new Error(`Project root is not a directory: ${candidate}`);
    return realpath(candidate);
  };

  const createSafeRegistries = (
    registries: readonly CapabilityRegistry[],
    warnings: string[],
  ): CapabilityRegistry[] =>
    registries.map((registry) => ({
      id: registry.id,
      async search(query) {
        try {
          return await registry.search(query);
        } catch (cause) {
          warnings.push(`${registry.id}: ${errorMessage(cause)}`);
          return [];
        }
      },
      async resolve(id, version) {
        try {
          return await registry.resolve(id, version);
        } catch (cause) {
          warnings.push(`${registry.id}: ${errorMessage(cause)}`);
          return null;
        }
      },
    }));

  const runPlan = async (
    input: z.output<typeof projectPlanInputSchema>,
  ): Promise<{ resolution: ProjectResolution; discovery: ToolData }> => {
    const root = await resolveRoot(input.root);
    const warnings: string[] = [];
    const registries = createSafeRegistries(
      registriesFor(input.networkDiscovery),
      warnings,
    );
    const options = {
      ...(input.task === undefined ? {} : { task: input.task }),
      policy: input.policy ?? (await loadEffectivePolicy(root)),
      registries,
    };
    const resolution = await planner(root, options);
    return {
      resolution,
      discovery: {
        network: input.networkDiscovery,
        registries: registries.map((registry) => registry.id),
        warnings,
      },
    };
  };

  return {
    async projectDetect(rawInput) {
      const input = projectDetectInputSchema.parse(rawInput);
      const root = await resolveRoot(input.root);
      return { project: projectProfileSchema.parse(detector(root)) };
    },

    async projectPlan(rawInput) {
      const input = projectPlanInputSchema.parse(rawInput);
      const { resolution, discovery } = await runPlan(input);
      return { ...resolution, discovery };
    },

    async explain(rawInput) {
      const input = explainInputSchema.parse(rawInput);
      const { resolution, discovery } = await runPlan(input);
      return {
        project: {
          root: resolution.project.root,
          lifecycle: resolution.project.lifecycle,
          languages: resolution.project.languages,
          frameworks: resolution.project.frameworks,
          services: resolution.project.services,
        },
        task: resolution.task,
        selected: resolution.plan.selected.map((item) => ({
          id: item.candidate.id,
          name: item.candidate.name,
          score: item.score,
          coverage: item.coverage,
          reasons: item.reasons,
          penalties: item.penalties,
        })),
        optional: resolution.plan.optional.map((item) => ({
          id: item.candidate.id,
          name: item.candidate.name,
          score: item.score,
          reasons: item.reasons,
        })),
        rejected: resolution.plan.rejected.map((item) => ({
          id: item.capability.candidate.id,
          reason: item.reason,
        })),
        uncovered: resolution.plan.uncovered,
        requiredApprovals: resolution.plan.requiredApprovals,
        discovery,
      };
    },

    async setupRecommend(rawInput) {
      const input = setupRecommendInputSchema.parse(rawInput);
      const { resolution, discovery } = await runPlan(input);
      const requestedCapabilities = [
        ...new Set(resolution.plan.selected.flatMap((item) => item.coverage)),
      ].sort((a, b) => a.localeCompare(b));
      const {
        detectionSignals: _detectionSignals,
        existingAgentConfigs: _existingAgentConfigs,
        ...projectBinding
      } = resolution.project;
      const intent = encodeSetupIntent({
        schemaVersion: 1,
        root: resolution.project.root,
        projectFingerprint: sha256(canonicalJson(projectBinding)),
        mode: "apply",
        harness: input.harness,
        ...(input.task === undefined
          ? {}
          : { task: String(redactSecrets(input.task)) }),
        requestedCapabilities,
      });
      return {
        intent,
        command: `loom setup --intent ${intent}`,
        selected: resolution.plan.selected.map((item) => ({
          id: item.candidate.id,
          name: item.candidate.name,
          score: item.score,
          coverage: item.coverage,
          reasons: item.reasons,
          penalties: item.penalties,
        })),
        approvals: resolution.plan.requiredApprovals,
        uncovered: resolution.plan.uncovered,
        warnings: discovery["warnings"],
      };
    },

    async capabilitySearch(rawInput) {
      const input = capabilitySearchInputSchema.parse(rawInput);
      const { networkDiscovery, ...query } = input;
      const warnings: string[] = [];
      const registries = registriesFor(networkDiscovery);
      const settled = await Promise.all(
        registries.map(async (registry) => {
          try {
            return await registry.search(query as CapabilityQueryInput);
          } catch (cause) {
            warnings.push(`${registry.id}: ${errorMessage(cause)}`);
            return [];
          }
        }),
      );
      const candidates = deduplicate(settled.flat()).slice(0, query.limit);
      return {
        query,
        networkDiscovery,
        registries: registries.map((registry) => registry.id),
        warnings,
        count: candidates.length,
        candidates,
      };
    },

    async capabilityResolve(rawInput) {
      const input = capabilityResolveInputSchema.parse(rawInput);
      const warnings: string[] = [];
      const registries = registriesFor(input.networkDiscovery);
      for (const registry of registries) {
        try {
          const candidate = await registry.resolve(input.id, input.version);
          if (candidate !== null)
            return {
              found: true,
              candidate,
              registry: registry.id,
              networkDiscovery: input.networkDiscovery,
              warnings,
            };
        } catch (cause) {
          warnings.push(`${registry.id}: ${errorMessage(cause)}`);
        }
      }
      return {
        found: false,
        id: input.id,
        networkDiscovery: input.networkDiscovery,
        warnings,
      };
    },

    async capabilityStatus(rawInput) {
      const input = statusInputSchema.parse(rawInput);
      const root = await resolveRoot(input.root);
      const state = await readState(
        root,
        "capabilities.lock.json",
        capabilityLockSchema,
      );
      const lock = state.status === "valid" ? state.value : undefined;
      return {
        root,
        state: stateSummary(state),
        capabilities:
          lock === undefined
            ? []
            : capabilityLockSchema
                .parse(lock)
                .entries.map((entry) => redactLockSecrets(entry)),
      };
    },

    async workflowStatus(rawInput) {
      const input = statusInputSchema.parse(rawInput);
      const root = await resolveRoot(input.root);
      const state = await readState(root, "workflow.json", workflowStateSchema);
      return {
        root,
        state: stateSummary(state),
        workflow:
          state.status === "valid" ? redactLockSecrets(state.value) : null,
      };
    },

    async doctor(rawInput) {
      const input = statusInputSchema.parse(rawInput);
      const root = await resolveRoot(input.root);
      const diagnostics: ToolData[] = [];
      try {
        detector(root);
        diagnostics.push({
          level: "info",
          code: "project.detect",
          message: "Project detection succeeded",
        });
      } catch (cause) {
        diagnostics.push({
          level: "error",
          code: "project.detect",
          message: errorMessage(cause),
        });
      }
      const files = await Promise.all([
        readState(root, "project.json", projectStateSchema),
        readState(root, "workflow.json", workflowStateSchema),
        readState(root, "capabilities.lock.json", capabilityLockSchema),
        readState(root, "ownership.json", ownershipStateSchema),
      ]);
      for (const state of files) {
        diagnostics.push({
          level:
            state.status === "invalid"
              ? "error"
              : state.status === "absent"
                ? "info"
                : "info",
          code: `state.${state.status}`,
          message:
            state.status === "invalid"
              ? state.error
              : `${relative(root, state.path)} is ${state.status}`,
          path: state.path,
        });
      }
      return {
        root,
        healthy: diagnostics.every((item) => item["level"] !== "error"),
        networkDiscovery: false,
        diagnostics,
      };
    },
  };
}

async function readState(
  root: string,
  name: string,
  schema: z.ZodType,
): Promise<StateResult> {
  const path = join(root, ".loom", name);
  try {
    const stateDirectory = join(root, ".loom");
    const directoryInfo = await lstat(stateDirectory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
      return {
        status: "invalid",
        path,
        error: ".loom must be a real directory",
      };
    const canonicalDirectory = await realpath(stateDirectory);
    if (!isWithin(root, canonicalDirectory))
      return {
        status: "invalid",
        path,
        error: ".loom resolves outside the project root",
      };
    const pathInfo = await lstat(path);
    if (pathInfo.isSymbolicLink())
      return {
        status: "invalid",
        path,
        error: "State file must not be a symbolic link",
      };
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile())
        return {
          status: "invalid",
          path,
          error: "State path is not a regular file",
        };
      if (info.size > MAX_STATE_BYTES)
        return {
          status: "invalid",
          path,
          error: `State file exceeds ${MAX_STATE_BYTES} bytes`,
        };
      const source = await file.readFile("utf8");
      const value: unknown = JSON.parse(source);
      return { status: "valid", path, value: schema.parse(value) };
    } finally {
      await file.close();
    }
  } catch (cause) {
    if (isNodeError(cause, "ENOENT")) return { status: "absent", path };
    if (isNodeError(cause, "ELOOP"))
      return {
        status: "invalid",
        path,
        error: "State file must not be a symbolic link",
      };
    return { status: "invalid", path, error: errorMessage(cause) };
  }
}

function stateSummary(state: StateResult): ToolData {
  return {
    status: state.status,
    path: state.path,
    ...(state.error === undefined ? {} : { error: state.error }),
  };
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

function isNodeError(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Unknown error";
}

function deduplicate<T extends { id: string }>(values: readonly T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()].sort(
    (a, b) => a.id.localeCompare(b.id),
  );
}
