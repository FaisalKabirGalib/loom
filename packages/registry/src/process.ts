import { spawn } from "node:child_process";

import type { ProcessResult, ProcessRunner } from "./types.js";

export class NodeProcessRunner implements ProcessRunner {
  public constructor(
    private readonly timeoutMs = 30_000,
    private readonly maxOutputBytes = 1_048_576,
  ) {}

  public run(command: string, args: readonly string[]): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env: safeEnvironment(process.env),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let exceeded = false;
      let timedOut = false;
      let forceKill: NodeJS.Timeout | undefined;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      }, this.timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > this.maxOutputBytes) {
          exceeded = true;
          child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (Buffer.byteLength(stderr) > this.maxOutputBytes) {
          exceeded = true;
          child.kill("SIGTERM");
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        if (forceKill !== undefined) clearTimeout(forceKill);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (forceKill !== undefined) clearTimeout(forceKill);
        resolve({
          stdout: stdout.slice(0, this.maxOutputBytes),
          stderr: exceeded
            ? `${stderr.slice(0, this.maxOutputBytes)}\nProcess output limit exceeded`
            : timedOut
              ? `${stderr}\nProcess timed out after ${this.timeoutMs}ms`
              : stderr,
          exitCode: exceeded || timedOut ? 1 : (code ?? 1),
        });
      });
    });
  }
}

function safeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "CI",
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "NO_PROXY",
    "PATH",
    "TEMP",
    "TMP",
    "TMPDIR",
    "XDG_CACHE_HOME",
  ];
  return Object.fromEntries(
    allowed.flatMap((key) =>
      environment[key] === undefined ? [] : [[key, environment[key]]],
    ),
  );
}
