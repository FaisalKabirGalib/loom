import type { ProjectProfile } from "@loom/core";

export interface FrameworkProfile {
  id: string;
  label: string;
  matches: (project: ProjectProfile) => boolean;
  requiredCapabilities: readonly string[];
  usefulCapabilities: readonly string[];
}

export interface ComposedProfiles {
  profiles: string[];
  requiredCapabilities: string[];
  usefulCapabilities: string[];
}

const hasLanguage =
  (name: string) =>
  (project: ProjectProfile): boolean =>
    project.languages.includes(name);
const hasFramework =
  (name: string) =>
  (project: ProjectProfile): boolean =>
    project.frameworks.includes(name);

export const frameworkProfiles: readonly FrameworkProfile[] = [
  {
    id: "typescript",
    label: "TypeScript",
    matches: hasLanguage("typescript"),
    requiredCapabilities: [],
    usefulCapabilities: ["DOCS.package-docs", "CODE_CONTEXT.structural-search"],
  },
  {
    id: "nextjs-react",
    label: "Next.js / React",
    matches: (project) =>
      hasFramework("next.js")(project) ||
      (hasFramework("react")(project) &&
        !hasFramework("react-native")(project) &&
        !hasFramework("expo")(project)),
    requiredCapabilities: [],
    usefulCapabilities: [
      "DOCS.framework-docs",
      "UI.browser-test",
      "UI.react-runtime",
      "UI.accessibility",
    ],
  },
  {
    id: "flutter-dart",
    label: "Flutter / Dart",
    matches: (project) =>
      hasFramework("flutter")(project) || hasLanguage("dart")(project),
    requiredCapabilities: ["MOBILE.framework-analysis"],
    usefulCapabilities: ["MOBILE.runtime-inspection", "MOBILE.framework-docs"],
  },
  {
    id: "react-native",
    label: "React Native",
    matches: hasFramework("react-native"),
    requiredCapabilities: ["MOBILE.framework-analysis"],
    usefulCapabilities: ["MOBILE.runtime-inspection", "MOBILE.e2e-device-test"],
  },
  {
    id: "expo",
    label: "Expo",
    matches: hasFramework("expo"),
    requiredCapabilities: ["MOBILE.framework-analysis"],
    usefulCapabilities: ["MOBILE.e2e-device-test", "MOBILE.framework-docs"],
  },
  {
    id: "go",
    label: "Go",
    matches: hasLanguage("go"),
    requiredCapabilities: ["CODE_CONTEXT.symbol-navigation"],
    usefulCapabilities: ["DOCS.framework-docs"],
  },
  {
    id: "laravel-php",
    label: "Laravel / PHP",
    matches: hasFramework("laravel"),
    requiredCapabilities: ["DOCS.framework-docs"],
    usefulCapabilities: ["DATA.schema-inspection", "OPS.production-errors"],
  },
] as const;

export const profiles = frameworkProfiles;

export const getApplicableProfiles = (
  project: ProjectProfile,
): FrameworkProfile[] =>
  frameworkProfiles.filter((profile) => profile.matches(project));

export const composeProfiles = (project: ProjectProfile): ComposedProfiles => {
  const matched = getApplicableProfiles(project);
  const unique = (values: readonly string[]): string[] =>
    [...new Set(values)].sort();
  const requiredCapabilities = unique(
    matched.flatMap((profile) => profile.requiredCapabilities),
  );
  const required = new Set(requiredCapabilities);
  return {
    profiles: matched.map((profile) => profile.id),
    requiredCapabilities,
    usefulCapabilities: unique(
      matched.flatMap((profile) => profile.usefulCapabilities),
    ).filter((capability) => !required.has(capability)),
  };
};

export const resolveProfiles = composeProfiles;
export const composeProjectProfiles = composeProfiles;
