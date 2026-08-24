export const PRODUCT_NAME = "Loom";
export const CLI_NAME = "loom";
export const STATE_DIRECTORY = ".loom";
export const SCHEMA_VERSION = 1;
export const VERSION = "0.1.1";

export const PROJECT_STATE_FILES = {
  lock: "capabilities.lock.json",
  ownership: "ownership.json",
  policy: "policy.toml",
  project: "project.json",
  workflow: "workflow.json",
} as const;
