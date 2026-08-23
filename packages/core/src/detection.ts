import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import type { DetectionSignal, ProjectProfile } from "./domain.js";

type JsonObject = Record<string, unknown>;

const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "fixtures",
  "node_modules",
  "target",
  "vendor",
]);

const agentConfigCandidates = [
  "AGENTS.md",
  "CLAUDE.md",
  ".claude",
  ".cursor",
  ".github/copilot-instructions.md",
  ".mcp.json",
  ".opencode",
  "opencode.json",
  "opencode.jsonc",
] as const;

const sorted = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort();

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const readJson = (path: string): JsonObject | undefined => {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
};

const stringRecord = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return {};
  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  );
};

const scan = (root: string, maxDepth = 4, maxEntries = 5_000): string[] => {
  const files: string[] = [];
  let visited = 0;
  const visit = (directory: string, depth: number): void => {
    if (depth > maxDepth || visited >= maxEntries) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited++ >= maxEntries) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) visit(path, depth + 1);
      } else if (entry.isFile()) {
        files.push(relative(root, path));
      }
    }
  };
  visit(root, 0);
  return files;
};

const pubspecPackages = (
  text: string | undefined,
): {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
} => {
  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};
  if (text === undefined) return { dependencies, devDependencies };
  let section: "dependencies" | "devDependencies" | undefined;
  for (const line of text.split(/\r?\n/u)) {
    if (/^dependencies:\s*$/u.test(line)) {
      section = "dependencies";
      continue;
    }
    if (/^dev_dependencies:\s*$/u.test(line)) {
      section = "devDependencies";
      continue;
    }
    if (/^[A-Za-z_][\w-]*:\s*/u.test(line)) section = undefined;
    if (!section) continue;
    const match = /^ {2}([\w-]+):\s*([^#\s][^#]*)?/u.exec(line);
    if (match?.[1]) {
      const target =
        section === "dependencies" ? dependencies : devDependencies;
      target[match[1]] = match[2]?.trim() || "manifest";
    }
  }
  return { dependencies, devDependencies };
};

const workspacePatterns = (
  root: string,
  packageJson: JsonObject | undefined,
): string[] => {
  const pnpm = readText(join(root, "pnpm-workspace.yaml"));
  const pnpmPatterns = (pnpm ?? "")
    .split(/\r?\n/u)
    .map((line) => /^\s*-\s*["']?([^"'#]+)["']?\s*$/u.exec(line)?.[1]?.trim())
    .filter((value): value is string => value !== undefined);
  const workspaces = packageJson?.["workspaces"];
  const packagePatterns = Array.isArray(workspaces)
    ? workspaces.filter((value): value is string => typeof value === "string")
    : workspaces !== null && typeof workspaces === "object"
      ? ((workspaces as JsonObject)["packages"] as unknown)
      : [];
  return [
    ...new Set([
      ...pnpmPatterns,
      ...(Array.isArray(packagePatterns)
        ? packagePatterns.filter(
            (value): value is string => typeof value === "string",
          )
        : []),
    ]),
  ];
};

const matchesWorkspace = (
  directory: string,
  patterns: readonly string[],
): boolean =>
  patterns.some((pattern) => {
    const normalized = pattern.replace(/^\.\//u, "").replace(/\/$/u, "");
    const expression = normalized
      .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
      .replaceAll("**", "\0")
      .replaceAll("*", "[^/]*")
      .replaceAll("\0", ".*");
    return new RegExp(`^${expression}$`, "u").test(directory);
  });

export const detectProject = (inputRoot: string): ProjectProfile => {
  const root = resolve(inputRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Project root is not a directory: ${inputRoot}`);
  }

  const files = scan(root);
  const has = (path: string): boolean => existsSync(join(root, path));
  const matching = (pattern: RegExp): string | undefined =>
    files.find((file) => pattern.test(file));
  const packageJson = readJson(join(root, "package.json"));
  const appJson = readJson(join(root, "app.json"));
  const composer = readJson(join(root, "composer.json"));
  const pubspecText = readText(join(root, "pubspec.yaml"));
  const dartPackages = pubspecPackages(pubspecText);
  const declaredWorkspaces = workspacePatterns(root, packageJson);
  const workspaceManifests = files
    .filter((file) => file !== "package.json" && file.endsWith("/package.json"))
    .filter((file) => matchesWorkspace(dirname(file), declaredWorkspaces))
    .map((path) => ({ path, value: readJson(join(root, path)) }))
    .filter(
      (manifest): manifest is { path: string; value: JsonObject } =>
        manifest.value !== undefined,
    );
  const workspaceDependencies = Object.assign(
    {},
    ...workspaceManifests.map((manifest) =>
      stringRecord(manifest.value["dependencies"]),
    ),
  ) as Record<string, string>;
  const workspaceDevDependencies = Object.assign(
    {},
    ...workspaceManifests.map((manifest) =>
      stringRecord(manifest.value["devDependencies"]),
    ),
  ) as Record<string, string>;
  const dependencies = {
    ...workspaceDependencies,
    ...stringRecord(packageJson?.["dependencies"]),
    ...stringRecord(composer?.["require"]),
    ...dartPackages.dependencies,
  };
  const devDependencies = {
    ...workspaceDevDependencies,
    ...stringRecord(packageJson?.["devDependencies"]),
    ...stringRecord(composer?.["require-dev"]),
    ...dartPackages.devDependencies,
  };
  const allPackages = { ...devDependencies, ...dependencies };
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const packageManagers = new Set<string>();
  const services = new Set<string>();
  const signals: DetectionSignal[] = [];
  const signal = (
    detector: string,
    message: string,
    path?: string,
    evidence?: string,
  ): void => {
    const value: DetectionSignal = { detector, message };
    if (path !== undefined) value.path = path;
    if (evidence !== undefined) value.evidence = evidence;
    signals.push(value);
  };
  const dependency = (name: string): string | undefined => allPackages[name];
  const addFramework = (name: string, path: string, evidence: string): void => {
    frameworks.add(name);
    signal(`framework:${name}`, `${name} detected`, path, evidence);
  };
  const addService = (name: string, path: string, evidence: string): void => {
    services.add(name);
    signal(`service:${name}`, `${name} detected`, path, evidence);
  };
  for (const manifest of workspaceManifests) {
    signal(
      "manifest:workspace-package",
      "Workspace package manifest inspected",
      manifest.path,
      "Dependencies included in project detection",
    );
  }

  const packageManagerField = packageJson?.["packageManager"];
  if (typeof packageManagerField === "string") {
    const name = packageManagerField.split("@")[0];
    if (name) {
      packageManagers.add(name);
      signal(
        `package-manager:${name}`,
        `${name} detected`,
        "package.json",
        `packageManager ${packageManagerField}`,
      );
    }
  }
  for (const [path, manager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ] as const) {
    if (has(path)) {
      packageManagers.add(manager);
      signal(
        `package-manager:${manager}`,
        `${manager} detected`,
        path,
        "lockfile present",
      );
    }
  }
  if (has("pubspec.yaml")) {
    packageManagers.add("pub");
    signal(
      "package-manager:pub",
      "pub detected",
      "pubspec.yaml",
      "Dart package manifest present",
    );
  }
  if (has("go.mod") || has("go.work")) {
    packageManagers.add("go");
    signal(
      "package-manager:go",
      "go detected",
      has("go.mod") ? "go.mod" : "go.work",
      "Go module or workspace manifest present",
    );
  }
  if (has("composer.json")) {
    packageManagers.add("composer");
    signal(
      "package-manager:composer",
      "composer detected",
      "composer.json",
      "Composer manifest present",
    );
  }

  if (
    has("tsconfig.json") ||
    dependency("typescript") !== undefined ||
    matching(/\.(?:ts|tsx)$/u)
  ) {
    languages.add("typescript");
    signal(
      "language:typescript",
      "TypeScript detected",
      has("tsconfig.json") ? "tsconfig.json" : "package.json",
      "TypeScript configuration, dependency, or source present",
    );
  }
  if (has("package.json") || matching(/\.(?:js|jsx|mjs|cjs)$/u)) {
    languages.add("javascript");
    signal(
      "language:javascript",
      "JavaScript detected",
      has("package.json") ? "package.json" : matching(/\.(?:js|jsx|mjs|cjs)$/u),
      "JavaScript package manifest or source present",
    );
  }
  if (has("pubspec.yaml") || matching(/\.dart$/u)) {
    languages.add("dart");
    addFramework("dart", "pubspec.yaml", "Dart manifest or source present");
  }
  if (has("go.mod") || has("go.work") || matching(/\.go$/u)) {
    languages.add("go");
    addFramework(
      "go",
      has("go.mod")
        ? "go.mod"
        : has("go.work")
          ? "go.work"
          : matching(/\.go$/u)!,
      "Go module, workspace, or source present",
    );
  }
  if (has("composer.json") || matching(/\.php$/u)) {
    languages.add("php");
    signal(
      "language:php",
      "PHP detected",
      has("composer.json") ? "composer.json" : matching(/\.php$/u),
      "Composer manifest or PHP source present",
    );
  }

  const nextConfig = matching(/(^|\/)next\.config\.(?:js|mjs|cjs|ts)$/u);
  if (dependency("next") !== undefined || nextConfig)
    addFramework(
      "next.js",
      dependency("next") ? "package.json" : nextConfig!,
      dependency("next") ? `next ${dependency("next")}` : "next.config present",
    );
  if (dependency("react") !== undefined)
    addFramework("react", "package.json", `react ${dependency("react")}`);
  if (
    dependency("react-native") !== undefined ||
    matching(/(^|\/)metro\.config\.(?:js|cjs|mjs|ts)$/u)
  )
    addFramework(
      "react-native",
      "package.json",
      dependency("react-native")
        ? `react-native ${dependency("react-native")}`
        : "Metro config present",
    );
  const expoConfig = matching(/(^|\/)app\.config\.(?:js|ts)$/u);
  const expoAppJson =
    appJson?.["expo"] !== null && typeof appJson?.["expo"] === "object";
  if (
    dependency("expo") !== undefined ||
    expoAppJson ||
    expoConfig ||
    has("eas.json")
  )
    addFramework(
      "expo",
      dependency("expo")
        ? "package.json"
        : expoAppJson
          ? "app.json"
          : (expoConfig ?? "eas.json"),
      dependency("expo")
        ? `expo ${dependency("expo")}`
        : "Expo application configuration present",
    );
  if (
    /\bsdk:\s*flutter\b/u.test(pubspecText ?? "") ||
    dartPackages.dependencies["flutter"] !== undefined
  )
    addFramework("flutter", "pubspec.yaml", "Flutter SDK dependency present");
  if (allPackages["widgetbook"] !== undefined)
    addFramework(
      "widgetbook",
      "pubspec.yaml",
      `widgetbook ${allPackages["widgetbook"]}`,
    );
  if (allPackages["patrol"] !== undefined)
    addFramework("patrol", "pubspec.yaml", `patrol ${allPackages["patrol"]}`);
  if (allPackages["laravel/framework"] !== undefined)
    addFramework(
      "laravel",
      "composer.json",
      `laravel/framework ${allPackages["laravel/framework"]}`,
    );
  const storybookPackage = Object.keys(allPackages).find(
    (name) => name === "storybook" || name.startsWith("@storybook/"),
  );
  if (storybookPackage || has(".storybook") || matching(/\.stories\.[^.]+$/u))
    addFramework(
      "storybook",
      storybookPackage
        ? "package.json"
        : has(".storybook")
          ? ".storybook"
          : matching(/\.stories\.[^.]+$/u)!,
      storybookPackage
        ? `${storybookPackage} ${allPackages[storybookPackage]}`
        : "Storybook configuration or stories present",
    );
  if (has("components.json"))
    addFramework(
      "shadcn",
      "components.json",
      "shadcn component manifest present",
    );

  const dependencyNames = Object.keys(allPackages);
  const postgresPackage = dependencyNames.find((name) =>
    ["pg", "postgres", "postgresql"].includes(name),
  );
  const prismaText = readText(join(root, "prisma/schema.prisma"));
  if (
    postgresPackage ||
    /provider\s*=\s*["']postgresql["']/u.test(prismaText ?? "")
  )
    addService(
      "postgresql",
      postgresPackage ? "package.json" : "prisma/schema.prisma",
      postgresPackage
        ? `${postgresPackage} ${allPackages[postgresPackage]}`
        : "PostgreSQL datasource provider present",
    );
  const supabasePackage = dependencyNames.find(
    (name) =>
      name.startsWith("@supabase/") ||
      name === "supabase" ||
      name === "supabase_flutter",
  );
  if (supabasePackage || has("supabase"))
    addService(
      "supabase",
      supabasePackage ? "package.json" : "supabase",
      supabasePackage
        ? `${supabasePackage} ${allPackages[supabasePackage]}`
        : "Supabase configuration directory present",
    );
  const neonPackage = dependencyNames.find((name) =>
    name.startsWith("@neondatabase/"),
  );
  if (neonPackage)
    addService(
      "neon",
      "package.json",
      `${neonPackage} ${allPackages[neonPackage]}`,
    );
  if (has("vercel.json") || has(".vercel"))
    addService(
      "vercel",
      has("vercel.json") ? "vercel.json" : ".vercel",
      "Vercel configuration present",
    );
  const wrangler = matching(/(^|\/)wrangler\.(?:jsonc?|toml)$/u);
  if (wrangler || dependency("wrangler") !== undefined)
    addService(
      "cloudflare",
      wrangler ?? "package.json",
      wrangler
        ? "Wrangler configuration present"
        : `wrangler ${dependency("wrangler")}`,
    );
  const docker =
    matching(/(^|\/)Dockerfile(?:\.[^/]+)?$/u) ??
    matching(/(^|\/)(?:docker-compose|compose)\.[^/]+$/u);
  if (docker) addService("docker", docker, "Docker configuration present");
  const terraform = matching(/\.tf$/u);
  if (terraform)
    addService("terraform", terraform, "Terraform configuration present");
  const kubernetes =
    matching(/(^|\/)(?:k8s|kubernetes|helm)\//u) ??
    matching(/(^|\/)Chart\.yaml$/u);
  if (kubernetes || has("k8s") || has("kubernetes") || has("helm"))
    addService(
      "kubernetes",
      kubernetes ??
        (has("k8s") ? "k8s" : has("kubernetes") ? "kubernetes" : "helm"),
      "Kubernetes or Helm configuration present",
    );
  if (has(".github/workflows"))
    addService(
      "github-actions",
      ".github/workflows",
      "GitHub Actions workflows present",
    );

  const monorepo =
    has("pnpm-workspace.yaml") ||
    has("turbo.json") ||
    has("nx.json") ||
    has("go.work") ||
    Array.isArray(packageJson?.["workspaces"]) ||
    (packageJson?.["workspaces"] !== null &&
      typeof packageJson?.["workspaces"] === "object");
  if (monorepo)
    signal(
      "project:monorepo",
      "Monorepo detected",
      has("pnpm-workspace.yaml")
        ? "pnpm-workspace.yaml"
        : has("turbo.json")
          ? "turbo.json"
          : has("nx.json")
            ? "nx.json"
            : has("go.work")
              ? "go.work"
              : "package.json",
      "Workspace configuration present",
    );

  const existingAgentConfigs = agentConfigCandidates.filter((path) =>
    has(path),
  );
  for (const path of existingAgentConfigs)
    signal(
      "agent-config",
      "Existing agent configuration detected",
      path,
      "Known agent configuration path present",
    );

  const mobileFramework =
    frameworks.has("flutter") ||
    frameworks.has("react-native") ||
    frameworks.has("expo");
  const web =
    frameworks.has("next.js") ||
    (frameworks.has("react") && !mobileFramework) ||
    frameworks.has("storybook") ||
    frameworks.has("laravel") ||
    matching(/(^|\/)(?:vite|astro)\.config\./u) !== undefined;
  const ui =
    web ||
    frameworks.has("flutter") ||
    frameworks.has("react-native") ||
    frameworks.has("expo") ||
    frameworks.has("shadcn");
  const mobile = mobileFramework;
  const apiPackages = [
    "express",
    "fastify",
    "hono",
    "@nestjs/core",
    "elysia",
  ].some((name) => dependency(name) !== undefined);
  const api =
    frameworks.has("next.js") ||
    frameworks.has("laravel") ||
    (frameworks.has("go") && matching(/\.go$/u) !== undefined) ||
    apiPackages ||
    has("routes/api.php");
  const databasePackages = dependencyNames.some((name) =>
    [
      "prisma",
      "@prisma/client",
      "drizzle-orm",
      "mongoose",
      "typeorm",
      "sequelize",
      "better-sqlite3",
      "sqlite3",
    ].includes(name),
  );
  const database =
    services.has("postgresql") ||
    services.has("supabase") ||
    services.has("neon") ||
    databasePackages ||
    has("prisma/schema.prisma") ||
    matching(/(^|\/)drizzle\.config\./u) !== undefined;
  for (const [detector, value, message, evidence] of [
    [
      "project:web",
      web,
      "Web project detected",
      "Web framework or configuration present",
    ],
    [
      "project:ui",
      ui,
      "UI project detected",
      "UI framework or component tooling present",
    ],
    [
      "project:mobile",
      mobile,
      "Mobile project detected",
      "Flutter, React Native, or Expo present",
    ],
    [
      "project:api",
      api,
      "API project detected",
      "API framework, route, or backend source present",
    ],
    [
      "project:database",
      database,
      "Database project detected",
      "Database package, schema, or service present",
    ],
  ] as const)
    if (value) signal(detector, message, undefined, evidence);

  const projectMarkers = [
    "package.json",
    "pubspec.yaml",
    "go.mod",
    "go.work",
    "composer.json",
    "artisan",
    "tsconfig.json",
  ];
  const lifecycle =
    projectMarkers.some(has) ||
    files.some((file) =>
      [".ts", ".tsx", ".js", ".jsx", ".dart", ".go", ".php"].includes(
        extname(file),
      ),
    )
      ? "brownfield"
      : "greenfield";
  signal(
    "project:lifecycle",
    `${lifecycle} project detected`,
    undefined,
    lifecycle === "brownfield"
      ? "Existing project manifest or source present"
      : "No project manifest or source found",
  );

  return {
    root: isAbsolute(inputRoot) ? root : resolve(inputRoot),
    lifecycle,
    languages: sorted(languages),
    frameworks: sorted(frameworks),
    packageManagers: sorted(packageManagers),
    dependencies,
    devDependencies,
    web,
    ui,
    mobile,
    api,
    database,
    monorepo,
    services: sorted(services),
    existingAgentConfigs: [...existingAgentConfigs].sort(),
    detectionSignals: signals,
  };
};

export const detectProjectProfile = detectProject;
