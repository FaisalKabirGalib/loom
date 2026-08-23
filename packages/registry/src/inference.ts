const RULES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/\b(browser|playwright|webdriver|chrome)\b/i, ["UI.browser-test"]],
  [/\b(debug|devtools|network)\b/i, ["UI.browser-debug"]],
  [/\b(accessibility|a11y|axe)\b/i, ["UI.accessibility"]],
  [/\b(react)\b/i, ["UI.react-runtime"]],
  [/\b(docs?|documentation|reference|context7)\b/i, ["DOCS.package-docs"]],
  [/\b(source|repository|github repo)\b/i, ["DOCS.repository-docs"]],
  [
    /\b(symbol|semantic|lsp|code search)\b/i,
    ["CODE_CONTEXT.semantic-search", "CODE_CONTEXT.symbol-navigation"],
  ],
  [
    /\b(call graph|dependency graph|impact)\b/i,
    ["CODE_CONTEXT.call-graph", "CODE_CONTEXT.impact-analysis"],
  ],
  [
    /\b(flutter|dart)\b/i,
    ["MOBILE.framework-analysis", "MOBILE.framework-docs"],
  ],
  [
    /\b(react native|expo)\b/i,
    ["MOBILE.framework-analysis", "MOBILE.framework-docs"],
  ],
  [
    /\b(device|emulator|simulator|maestro|appium)\b/i,
    ["MOBILE.emulator-control", "MOBILE.e2e-device-test"],
  ],
  [/\b(graphql|apollo)\b/i, ["API.graphql", "API.api-contract"]],
  [/\b(openapi|postman|api test)\b/i, ["API.api-contract", "API.api-testing"]],
  [/\b(mock|wiremock|mockoon)\b/i, ["API.mocking"]],
  [
    /\b(postgres|mysql|sqlite|database|sql|schema)\b/i,
    ["DATA.generic-sql", "DATA.schema-inspection"],
  ],
  [/\b(supabase)\b/i, ["DATA.supabase"]],
  [/\b(neon)\b/i, ["DATA.neon"]],
  [/\b(semgrep|sast|security scan)\b/i, ["SECURITY.sast"]],
  [
    /\b(dependency risk|supply chain|vulnerability)\b/i,
    ["SECURITY.dependency-risk"],
  ],
  [/\b(github|git hosting)\b/i, ["OPS.git-hosting"]],
  [/\b(kubernetes|helm)\b/i, ["OPS.kubernetes"]],
  [/\b(terraform)\b/i, ["OPS.terraform"]],
  [/\b(sentry|error tracking|production error)\b/i, ["OPS.production-errors"]],
  [/\b(deploy|deployment|vercel|cloudflare)\b/i, ["OPS.deployment"]],
];

export function inferCapabilities(text: string): string[] {
  return [
    ...new Set(
      RULES.flatMap(([pattern, capabilities]) =>
        pattern.test(text) ? capabilities : [],
      ),
    ),
  ].sort();
}
