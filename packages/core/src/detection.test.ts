import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { detectProject } from "./detection.js";

const roots: string[] = [];
const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), "loom-detection-"));
  roots.push(root);
  return root;
};
const write = (root: string, path: string, content = ""): void => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("detectProject", () => {
  it("detects an empty project deterministically", () => {
    const root = fixture();

    expect(detectProject(root)).toMatchObject({
      root,
      lifecycle: "greenfield",
      languages: [],
      frameworks: [],
      packageManagers: [],
      services: [],
      monorepo: false,
    });
  });

  it("detects exact Next.js ecosystem manifests and infrastructure", () => {
    const root = fixture();
    write(
      root,
      "package.json",
      JSON.stringify({
        packageManager: "pnpm@10.0.0",
        dependencies: {
          "@neondatabase/serverless": "1.0.1",
          "@supabase/supabase-js": "2.50.0",
          next: "15.2.0",
          pg: "8.13.0",
          react: "19.0.0",
        },
        devDependencies: { "@storybook/nextjs": "8.6.0", typescript: "5.8.2" },
      }),
    );
    for (const path of [
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "components.json",
      "vercel.json",
      "wrangler.toml",
      "Dockerfile",
      "infra/main.tf",
      "helm/app/Chart.yaml",
      ".mcp.json",
    ])
      write(root, path);

    const profile = detectProject(root);

    expect(profile.lifecycle).toBe("brownfield");
    expect(profile.languages).toEqual(["javascript", "typescript"]);
    expect(profile.frameworks).toEqual([
      "next.js",
      "react",
      "shadcn",
      "storybook",
    ]);
    expect(profile.packageManagers).toEqual(["pnpm"]);
    expect(profile.dependencies["next"]).toBe("15.2.0");
    expect(profile.devDependencies["typescript"]).toBe("5.8.2");
    expect(profile.services).toEqual([
      "cloudflare",
      "docker",
      "kubernetes",
      "neon",
      "postgresql",
      "supabase",
      "terraform",
      "vercel",
    ]);
    expect(profile).toMatchObject({
      web: true,
      ui: true,
      mobile: false,
      api: true,
      database: true,
      monorepo: true,
    });
    expect(profile.existingAgentConfigs).toEqual([".mcp.json"]);
    expect(
      profile.detectionSignals.some((item) => item.detector === "service:neon"),
    ).toBe(true);
  });

  it("aggregates only declared workspace package manifests", () => {
    const root = fixture();
    write(
      root,
      "package.json",
      JSON.stringify({ private: true, workspaces: ["apps/*"] }),
    );
    write(
      root,
      "apps/web/package.json",
      JSON.stringify({ dependencies: { next: "15.2.0", react: "19.0.0" } }),
    );
    write(
      root,
      "scratch/example/package.json",
      JSON.stringify({ dependencies: { vue: "3.5.0" } }),
    );

    const profile = detectProject(root);

    expect(profile.dependencies).toMatchObject({
      next: "15.2.0",
      react: "19.0.0",
    });
    expect(profile.dependencies["vue"]).toBeUndefined();
    expect(profile.frameworks).toContain("next.js");
    expect(profile.frameworks).not.toContain("vue");
    expect(
      profile.detectionSignals.some(
        (signal) =>
          signal.detector === "manifest:workspace-package" &&
          signal.path === "apps/web/package.json",
      ),
    ).toBe(true);
  });

  it("detects Flutter, Expo, Go, and Laravel only from concrete signals", () => {
    const root = fixture();
    write(
      root,
      "pubspec.yaml",
      "dependencies:\n  flutter:\n    sdk: flutter\n  patrol: ^3.0.0\n",
    );
    write(
      root,
      "package.json",
      JSON.stringify({
        dependencies: { expo: "52.0.0", "react-native": "0.76.0" },
      }),
    );
    write(
      root,
      "composer.json",
      JSON.stringify({ require: { "laravel/framework": "^12.0" } }),
    );
    write(root, "go.mod", "module example.test/app\n");
    write(root, "app.json", "{}");

    const profile = detectProject(root);

    expect(profile.languages).toEqual(["dart", "go", "javascript", "php"]);
    expect(profile.frameworks).toEqual([
      "dart",
      "expo",
      "flutter",
      "go",
      "laravel",
      "patrol",
      "react-native",
    ]);
    expect(profile.dependencies["patrol"]).toBe("^3.0.0");
    expect(profile.packageManagers).toEqual(["composer", "go", "pub"]);
    expect(profile).toMatchObject({
      web: true,
      ui: true,
      mobile: true,
      api: true,
    });
  });
});
