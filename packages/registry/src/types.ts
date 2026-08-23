import {
  capabilityKindSchema,
  trustTierSchema,
  type CapabilityCandidate,
} from "@loom/core";
import { z } from "zod";

const nonBlank = z.string().trim().min(1);

export const registryVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value === "latest" ||
      (!/[\s*^~<>=|]/u.test(value) && !/(?:^|[.-])[xX](?:$|[.-])/u.test(value)),
    "Expected 'latest' or an exact version",
  );

export const registryCursorSchema = nonBlank.max(2_048);

export const capabilityQuerySchema = z
  .object({
    text: nonBlank.max(200).optional(),
    provides: z.array(nonBlank.max(100)).max(100).default([]),
    ecosystems: z.array(nonBlank.max(100)).max(100).default([]),
    kinds: z.array(capabilityKindSchema).max(5).default([]),
    minTrustTier: trustTierSchema.optional(),
    version: registryVersionSchema.optional(),
    updatedSince: z.iso.datetime({ offset: true }).optional(),
    cursor: registryCursorSchema.optional(),
    limit: z.number().int().min(1).max(100).default(30),
    includeDeleted: z.boolean().default(false),
  })
  .strict();

export type CapabilityQueryInput = z.input<typeof capabilityQuerySchema>;
export type CapabilityQuery = z.output<typeof capabilityQuerySchema>;

export interface RegistryPage {
  candidates: CapabilityCandidate[];
  nextCursor?: string;
  count: number;
}

export interface CapabilityRegistry {
  readonly id: string;
  search(query: CapabilityQueryInput): Promise<CapabilityCandidate[]>;
  resolve(id: string, version?: string): Promise<CapabilityCandidate | null>;
}

export interface PaginatedCapabilityRegistry extends CapabilityRegistry {
  searchPage(query: CapabilityQueryInput): Promise<RegistryPage>;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessRunner {
  run(command: string, args: readonly string[]): Promise<ProcessResult>;
}
