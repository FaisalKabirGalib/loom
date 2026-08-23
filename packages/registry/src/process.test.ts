import { describe, expect, it } from "vitest";

import { NodeProcessRunner } from "./process.js";

describe("NodeProcessRunner", () => {
  it("bounds runtime, output, and inherited environment", async () => {
    process.env.LOOM_TEST_SECRET = "do-not-inherit";
    const runner = new NodeProcessRunner(1_000, 64);
    const environment = await runner.run(process.execPath, [
      "-e",
      "process.stdout.write(process.env.LOOM_TEST_SECRET ?? 'clean')",
    ]);
    const output = await runner.run(process.execPath, [
      "-e",
      "process.stdout.write('x'.repeat(1000))",
    ]);
    const timeout = await new NodeProcessRunner(20, 64).run(process.execPath, [
      "-e",
      "setTimeout(() => {}, 10000)",
    ]);
    delete process.env.LOOM_TEST_SECRET;

    expect(environment.stdout).toBe("clean");
    expect(output.exitCode).toBe(1);
    expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(64);
    expect(timeout.exitCode).toBe(1);
  });
});
