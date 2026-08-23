import type { ProjectProfile, TaskProfile } from "./domain.js";

const INTENTS: ReadonlyArray<readonly [string, RegExp, readonly string[]]> = [
  [
    "debug",
    /\b(debug|bug|crash|error|fix|regression|failing)\b/i,
    [
      "CODE_CONTEXT.semantic-search",
      "CODE_CONTEXT.symbol-navigation",
      "MOBILE.runtime-inspection",
    ],
  ],
  [
    "test",
    /\b(test|spec|coverage|playwright|vitest|jest|e2e)\b/i,
    ["API.api-testing", "UI.browser-test"],
  ],
  [
    "database",
    /\b(database|sql|schema|migration|postgres|mysql|mongo)\b/i,
    ["DATA.schema-inspection", "DATA.generic-sql"],
  ],
  [
    "api",
    /\b(api|endpoint|rest|graphql|openapi|server)\b/i,
    ["API.api-contract", "API.api-testing"],
  ],
  [
    "ui",
    /\b(ui|component|page|css|accessibility|frontend|design|react)\b/i,
    ["UI.accessibility", "UI.browser-test"],
  ],
  [
    "mobile",
    /\b(mobile|android|ios|flutter|react native|emulator)\b/i,
    ["MOBILE.framework-analysis", "MOBILE.logs"],
  ],
  [
    "security",
    /\b(security|vulnerability|audit|secret|auth|permission)\b/i,
    ["SECURITY.sast", "SECURITY.dependency-risk"],
  ],
  [
    "deploy",
    /\b(deploy|release|production|kubernetes|terraform|ci\/?cd)\b/i,
    ["OPS.deployment", "OPS.ci"],
  ],
  [
    "research",
    /\b(documentation|docs|research|reference|library)\b/i,
    ["DOCS.package-docs", "DOCS.source-inspection"],
  ],
  [
    "refactor",
    /\b(refactor|architecture|restructure|modernize|migrate)\b/i,
    ["CODE_CONTEXT.semantic-search", "CODE_CONTEXT.impact-analysis"],
  ],
];

const HIGH_RISK =
  /\b(production|prod|credential|secret|delete|drop|payment|release|deploy|infrastructure)\b/i;
const MEDIUM_RISK =
  /\b(write|modify|update|install|migration|database|shell|device|network)\b/i;

export interface ClassifyTaskOptions {
  requiredCapabilities?: readonly string[];
  usefulCapabilities?: readonly string[];
}

export function classifyTask(
  summary: string,
  project?: ProjectProfile,
  options: ClassifyTaskOptions = {},
): TaskProfile {
  const text = summary.trim();
  const matches = INTENTS.filter(([, pattern]) => pattern.test(text));
  const intents = matches.map(([intent]) => intent);
  if (intents.length === 0) intents.push("implementation");

  const inferred = matches.flatMap(([, , capabilities]) => capabilities);
  if (project?.lifecycle === "brownfield")
    inferred.push("CODE_CONTEXT.semantic-search");
  if (project?.monorepo) inferred.push("CODE_CONTEXT.impact-analysis");

  return {
    ...(text ? { summary: text } : {}),
    intents: uniqueSorted(intents),
    requiredCapabilities: uniqueSorted(options.requiredCapabilities ?? []),
    usefulCapabilities: uniqueSorted([
      ...(options.usefulCapabilities ?? []),
      ...inferred,
    ]),
    risk: HIGH_RISK.test(text)
      ? "high"
      : MEDIUM_RISK.test(text)
        ? "medium"
        : "low",
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ].sort();
}
