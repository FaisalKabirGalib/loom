import { homedir } from "node:os";
import { join } from "node:path";

export interface LoomPaths {
  config: string;
  cache: string;
  state: string;
}

export function resolveLoomPaths(
  env: NodeJS.ProcessEnv = process.env,
): LoomPaths {
  const home = env.HOME ?? homedir();
  return {
    config: join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "loom"),
    cache: join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "loom"),
    state: join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "loom"),
  };
}
