import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION, redactLockSecrets } from "@loom/core";
import { z } from "zod";

import {
  capabilityResolveInputSchema,
  capabilitySearchInputSchema,
  createLoomToolHandlers,
  explainInputSchema,
  projectDetectInputSchema,
  projectPlanInputSchema,
  statusInputSchema,
  type LoomMcpDependencies,
} from "./handlers.js";

export const LOOM_TOOL_NAMES = [
  "loom_project_detect",
  "loom_project_plan",
  "loom_explain",
  "loom_capability_search",
  "loom_capability_resolve",
  "loom_capability_status",
  "loom_workflow_status",
  "loom_doctor",
] as const;

const outputSchema = z
  .object({
    ok: z.boolean(),
    data: z.record(z.string(), z.json()).optional(),
    error: z
      .object({ code: z.string(), message: z.string() })
      .strict()
      .optional(),
  })
  .strict();

type Handler = (input: unknown) => Promise<Record<string, unknown>>;

export function createLoomMcpServer(
  dependencies: LoomMcpDependencies = {},
): McpServer {
  const server = new McpServer(
    { name: "loom", version: VERSION },
    { capabilities: { tools: {} } },
  );
  const handlers = createLoomToolHandlers(dependencies);
  const register = (
    name: (typeof LOOM_TOOL_NAMES)[number],
    description: string,
    inputSchema: z.ZodType,
    handler: Handler,
    openWorld = false,
  ): void => {
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        outputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: openWorld,
        },
      },
      async (input) => result(() => handler(input)),
    );
  };

  register(
    "loom_project_detect",
    "Detect a project's stack without mutation",
    projectDetectInputSchema,
    handlers.projectDetect,
  );
  register(
    "loom_project_plan",
    "Create a minimal capability plan without mutation",
    projectPlanInputSchema,
    handlers.projectPlan,
    true,
  );
  register(
    "loom_explain",
    "Explain project and capability planning decisions",
    explainInputSchema,
    handlers.explain,
    true,
  );
  register(
    "loom_capability_search",
    "Search local capabilities, with optional network discovery",
    capabilitySearchInputSchema,
    handlers.capabilitySearch,
    true,
  );
  register(
    "loom_capability_resolve",
    "Resolve one capability by id or name",
    capabilityResolveInputSchema,
    handlers.capabilityResolve,
    true,
  );
  register(
    "loom_capability_status",
    "Read project capability lock status safely",
    statusInputSchema,
    handlers.capabilityStatus,
  );
  register(
    "loom_workflow_status",
    "Read project workflow status safely",
    statusInputSchema,
    handlers.workflowStatus,
  );
  register(
    "loom_doctor",
    "Diagnose project and Loom state without network access",
    statusInputSchema,
    handlers.doctor,
  );
  return server;
}

export async function runLoomMcpServer(
  dependencies: LoomMcpDependencies = {},
): Promise<void> {
  await createLoomMcpServer(dependencies).connect(new StdioServerTransport());
}

async function result(run: () => Promise<Record<string, unknown>>) {
  try {
    const structuredContent = toJson({ ok: true, data: await run() });
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(structuredContent) },
      ],
      structuredContent,
    };
  } catch (cause) {
    const structuredContent = toJson({
      ok: false,
      error: {
        code: cause instanceof z.ZodError ? "INVALID_INPUT" : "LOOM_ERROR",
        message: cause instanceof Error ? cause.message : "Unknown error",
      },
    });
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(structuredContent) },
      ],
      structuredContent,
      isError: true,
    };
  }
}

function toJson(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(redactLockSecrets(value))) as Record<
    string,
    unknown
  >;
}
