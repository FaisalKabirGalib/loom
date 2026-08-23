import { z } from "zod";
import type { CapabilityPlan } from "./domain.js";

export const diagnosticSchema = z.object({
  level: z.enum(["info", "warning", "error"]),
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
});

export const configMutationSchema = z.object({
  kind: z.enum(["create-file", "update-file", "delete-file"]),
  path: z.string(),
  description: z.string(),
  content: z.string().optional(),
  expectedHash: z.string().optional(),
});

export const harnessStateSchema = z.object({
  id: z.string(),
  installed: z.boolean(),
  configPaths: z.array(z.string()),
  diagnostics: z.array(diagnosticSchema),
});

export const configMutationPlanSchema = z.object({
  harness: z.string(),
  root: z.string(),
  mutations: z.array(configMutationSchema),
  diagnostics: z.array(diagnosticSchema),
});

export const applyResultSchema = z.object({
  changed: z.array(z.string()),
  skipped: z.array(z.string()),
  diagnostics: z.array(diagnosticSchema),
});

export type Diagnostic = z.infer<typeof diagnosticSchema>;
export type ConfigMutation = z.infer<typeof configMutationSchema>;
export type HarnessState = z.infer<typeof harnessStateSchema>;
export type ConfigMutationPlan = z.infer<typeof configMutationPlanSchema>;
export type ApplyResult = z.infer<typeof applyResultSchema>;

export interface HarnessAdapter {
  id: string;
  inspect(root: string): Promise<HarnessState>;
  planInstall(root: string, plan: CapabilityPlan): Promise<ConfigMutationPlan>;
  apply(mutations: ConfigMutationPlan, dryRun?: boolean): Promise<ApplyResult>;
  verify(root: string): Promise<Diagnostic[]>;
  uninstallOwned(root: string, dryRun?: boolean): Promise<ApplyResult>;
}
