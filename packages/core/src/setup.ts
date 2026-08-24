import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

import { z } from "zod";

import { ALL_CAPABILITIES } from "./capabilities.js";

const textSchema = z.string().trim().min(1);
const identifierSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,127})$/i);
const candidateIdentifierSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9._:-]{0,199})$/i);
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const dateTimeSchema = z.iso.datetime({ offset: true });
const httpsUrlSchema = z.url({
  protocol: /^https$/,
  hostname: z.regexes.domain,
});
const capabilitySet = new Set<string>(ALL_CAPABILITIES);
const canonicalRootSchema = z
  .string()
  .refine(
    (root) =>
      root.length > 0 &&
      !root.includes("\0") &&
      isAbsolute(root) &&
      normalize(root) === root,
    { message: "Root must be an absolute canonical path" },
  );

export const setupModeSchema = z.enum(["plan", "apply"]);

export const setupIntentSchema = z
  .object({
    schemaVersion: z.literal(1),
    root: canonicalRootSchema,
    projectFingerprint: sha256Schema,
    harness: identifierSchema,
    task: textSchema.max(4_096).optional(),
    mode: setupModeSchema,
    requestedCapabilities: z
      .array(
        z.string().refine((value) => capabilitySet.has(value), {
          message: "Unknown capability",
        }),
      )
      .max(ALL_CAPABILITIES.length)
      .refine((values) => new Set(values).size === values.length, {
        message: "Capabilities must be unique",
      }),
  })
  .strict();

const npmRecipeSchema = z
  .object({
    kind: z.literal("npm"),
    package: z
      .string()
      .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();

const gitSkillRecipeSchema = z
  .object({
    kind: z.literal("git-skill"),
    repository: httpsUrlSchema,
    commit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
    path: z
      .string()
      .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/)
      .optional(),
  })
  .strict();

const binaryRecipeSchema = z
  .object({
    kind: z.literal("binary"),
    url: httpsUrlSchema,
    sha256: sha256Schema,
  })
  .strict();

const ociRecipeSchema = z
  .object({
    kind: z.literal("oci"),
    image: z.string().regex(/^[a-z0-9](?:[a-z0-9._:/-]*[a-z0-9])?$/),
    digest: sha256Schema,
  })
  .strict();

const remoteMcpRecipeSchema = z
  .object({
    kind: z.literal("remote-mcp"),
    url: httpsUrlSchema,
  })
  .strict();

export const installRecipeSchema = z.discriminatedUnion("kind", [
  npmRecipeSchema,
  gitSkillRecipeSchema,
  binaryRecipeSchema,
  ociRecipeSchema,
  remoteMcpRecipeSchema,
]);

const setupCandidateShapeSchema = z
  .object({
    id: candidateIdentifierSchema,
    capabilities: z.array(z.string()).min(1),
    recipe: installRecipeSchema,
    recipeDigest: sha256Schema,
  })
  .strict();

export const setupCandidateSchema = setupCandidateShapeSchema.superRefine(
  (candidate, context) => {
    if (candidate.recipeDigest !== computeRecipeDigest(candidate.recipe)) {
      context.addIssue({
        code: "custom",
        path: ["recipeDigest"],
        message: "Recipe digest does not match recipe",
      });
    }
  },
);

const setupPlanPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    root: canonicalRootSchema,
    projectFingerprint: sha256Schema,
    harness: identifierSchema,
    task: textSchema.max(4_096).optional(),
    mode: setupModeSchema,
    candidates: z.array(setupCandidateSchema),
    policyHash: sha256Schema,
    inputHash: sha256Schema,
    createdAt: dateTimeSchema,
    expiresAt: dateTimeSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    if (Date.parse(plan.expiresAt) <= Date.parse(plan.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Plan expiry must be after creation",
      });
    }
    if (
      new Set(plan.candidates.map(({ id }) => id)).size !==
      plan.candidates.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Candidate ids must be unique",
      });
    }
  });

const setupPlanShapeSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: sha256Schema,
    root: canonicalRootSchema,
    projectFingerprint: sha256Schema,
    harness: identifierSchema,
    task: textSchema.max(4_096).optional(),
    mode: setupModeSchema,
    candidates: z.array(setupCandidateSchema),
    policyHash: sha256Schema,
    inputHash: sha256Schema,
    createdAt: dateTimeSchema,
    expiresAt: dateTimeSchema,
  })
  .strict();

export const setupPlanSchema = setupPlanShapeSchema.superRefine(
  (plan, context) => {
    const { planId, ...payload } = plan;
    const payloadResult = setupPlanPayloadSchema.safeParse(payload);
    if (!payloadResult.success) {
      for (const issue of payloadResult.error.issues) {
        context.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
      }
      return;
    }
    if (planId !== computeSetupPlanId(payloadResult.data)) {
      context.addIssue({
        code: "custom",
        path: ["planId"],
        message: "Plan id does not match plan contents",
      });
    }
  },
);

export const setupApprovalSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: sha256Schema,
    approvedRecipeDigests: z.array(sha256Schema).min(1),
    approvedAt: dateTimeSchema,
    expiresAt: dateTimeSchema,
  })
  .strict()
  .superRefine((approval, context) => {
    if (Date.parse(approval.expiresAt) <= Date.parse(approval.approvedAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Approval expiry must be after approval",
      });
    }
    if (
      new Set(approval.approvedRecipeDigests).size !==
      approval.approvedRecipeDigests.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["approvedRecipeDigests"],
        message: "Approved recipe digests must be unique",
      });
    }
  });

export const setupReceiptItemSchema = z
  .object({
    candidateId: candidateIdentifierSchema,
    recipeDigest: sha256Schema,
    status: z.enum(["installed", "skipped", "failed", "rolled-back"]),
    error: textSchema.optional(),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.status === "failed" && item.error === undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Failure requires an error",
      });
    }
    if (item.status !== "failed" && item.error !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Only failures may include an error",
      });
    }
  });

export const setupReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    transactionId: z.uuid(),
    planId: sha256Schema,
    status: z.enum(["succeeded", "failed", "rolled-back"]),
    startedAt: dateTimeSchema,
    finishedAt: dateTimeSchema,
    items: z.array(setupReceiptItemSchema),
  })
  .strict()
  .refine(
    (receipt) =>
      Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt),
    {
      path: ["finishedAt"],
      message: "Receipt cannot finish before it starts",
    },
  );

export const setupTransactionSchema = z
  .object({
    schemaVersion: z.literal(1),
    transactionId: z.uuid(),
    planId: sha256Schema,
    status: z.enum([
      "pending",
      "running",
      "succeeded",
      "failed",
      "rolled-back",
    ]),
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    recipeDigests: z.array(sha256Schema),
    receipt: setupReceiptSchema.optional(),
  })
  .strict()
  .superRefine((transaction, context) => {
    const terminal = ["succeeded", "failed", "rolled-back"].includes(
      transaction.status,
    );
    if (terminal !== (transaction.receipt !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["receipt"],
        message: "Terminal transactions require a receipt",
      });
    }
    if (
      transaction.receipt !== undefined &&
      (transaction.receipt.transactionId !== transaction.transactionId ||
        transaction.receipt.planId !== transaction.planId ||
        transaction.receipt.status !== transaction.status)
    ) {
      context.addIssue({
        code: "custom",
        path: ["receipt"],
        message: "Receipt does not match transaction",
      });
    }
    if (Date.parse(transaction.updatedAt) < Date.parse(transaction.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "Transaction update cannot precede creation",
      });
    }
  });

export type SetupMode = z.infer<typeof setupModeSchema>;
export type SetupIntent = z.infer<typeof setupIntentSchema>;
export type InstallRecipe = z.infer<typeof installRecipeSchema>;
export type SetupCandidate = z.infer<typeof setupCandidateSchema>;
export type SetupPlanInput = z.infer<typeof setupPlanPayloadSchema>;
export type SetupPlan = z.infer<typeof setupPlanSchema>;
export type SetupApproval = z.infer<typeof setupApprovalSchema>;
export type SetupReceiptItem = z.infer<typeof setupReceiptItemSchema>;
export type SetupReceipt = z.infer<typeof setupReceiptSchema>;
export type SetupTransaction = z.infer<typeof setupTransactionSchema>;

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function computeRecipeDigest(recipe: InstallRecipe): string {
  return sha256(canonicalJson(installRecipeSchema.parse(recipe)));
}

export function computeSetupPlanId(plan: SetupPlanInput | SetupPlan): string {
  const { planId: _planId, ...payload } = plan as SetupPlan;
  const parsed = setupPlanPayloadSchema.parse(payload);
  const { createdAt: _createdAt, expiresAt: _expiresAt, ...binding } = parsed;
  return sha256(canonicalJson(binding));
}

export function createSetupPlan(input: SetupPlanInput): SetupPlan {
  const payload = setupPlanPayloadSchema.parse(input);
  return setupPlanSchema.parse({
    ...payload,
    planId: computeSetupPlanId(payload),
  });
}

export function verifySetupPlanId(plan: unknown): plan is SetupPlan {
  return setupPlanSchema.safeParse(plan).success;
}

export function encodeSetupIntent(intent: SetupIntent): string {
  const parsed = setupIntentSchema.parse(intent);
  return `loom1_${Buffer.from(canonicalJson(parsed)).toString("base64url")}`;
}

export function decodeSetupIntent(encoded: string): SetupIntent {
  const payload = encoded.startsWith("loom1_") ? encoded.slice(6) : "";
  if (!/^[A-Za-z0-9_-]+$/.test(payload))
    throw new Error("Invalid setup intent encoding");
  const bytes = Buffer.from(payload, "base64url");
  if (bytes.toString("base64url") !== payload)
    throw new Error("Invalid setup intent encoding");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Invalid setup intent encoding");
  }
  return setupIntentSchema.parse(value);
}

export function createSetupTransaction(
  plan: SetupPlan,
  now = new Date(),
): SetupTransaction {
  const parsed = setupPlanSchema.parse(plan);
  const timestamp = now.toISOString();
  return setupTransactionSchema.parse({
    schemaVersion: 1,
    transactionId: randomUUID(),
    planId: parsed.planId,
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp,
    recipeDigests: parsed.candidates.map(({ recipeDigest }) => recipeDigest),
  });
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON requires finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child === undefined)
        throw new TypeError("Canonical JSON does not allow undefined");
      result[key] = canonicalize(child);
    }
    return result;
  }
  throw new TypeError(`Canonical JSON does not allow ${typeof value}`);
}
