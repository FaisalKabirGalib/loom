import { z } from "zod";

import { projectProfileSchema, taskProfileSchema } from "./domain.js";

export const projectStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string(),
    project: projectProfileSchema,
  })
  .strict();

export const workflowHarnessStateSchema = z
  .object({
    task: taskProfileSchema,
    selected: z.array(z.string()),
    approvals: z.array(z.string()),
  })
  .strict();

export const workflowStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string(),
    harnesses: z.record(z.string(), workflowHarnessStateSchema),
  })
  .strict();

export const ownershipStateSchema = z
  .object({
    version: z.literal(1),
    harnesses: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ProjectState = z.infer<typeof projectStateSchema>;
export type WorkflowState = z.infer<typeof workflowStateSchema>;
