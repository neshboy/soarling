import { describe, expect, it } from "vitest";
import { runShellCommand } from "./shell.js";

/**
 * No mocked child_process anywhere in this file: every command below is a
 * real process, and every assertion is against real captured output.
 */
describe("runShellCommand (real child process)", () => {
  it("captures real stdout and a real zero exit code from `echo`", async () => {
    const result = await runShellCommand("echo hello-from-soarling");
    expect(result.stdout.trim()).toBe("hello-from-soarling");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("captures a real non-zero exit code from a real failing command", async () => {
    // Node ships everywhere SOARling runs, so use it to fail predictably
    // and portably (this repo runs on both Windows and POSIX CI).
    const result = await runShellCommand(`${JSON.stringify(process.execPath)} -e "process.exit(7)"`);
    expect(result.exitCode).toBe(7);
  });

  it("captures real stderr output separately from stdout", async () => {
    const result = await runShellCommand(
      `${JSON.stringify(process.execPath)} -e "console.error('to-stderr'); console.log('to-stdout')"`
    );
    expect(result.stdout.trim()).toBe("to-stdout");
    expect(result.stderr.trim()).toBe("to-stderr");
  });

  it("respects cwd for a real command that reports its working directory", async () => {
    const result = await runShellCommand(`${JSON.stringify(process.execPath)} -e "console.log(process.cwd())"`, {
      cwd: process.env.TEMP ?? process.env.TMPDIR ?? "/tmp",
    });
    // Resolve both sides the same way to avoid short-path/8.3 vs long-path
    // mismatches on Windows temp directories.
    const { realpathSync } = await import("node:fs");
    const expected = realpathSync(process.env.TEMP ?? process.env.TMPDIR ?? "/tmp");
    expect(realpathSync(result.stdout.trim())).toBe(expected);
  });

  it("kills a real long-running command once timeoutMs elapses", async () => {
    const result = await runShellCommand(
      `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 5000)"`,
      { timeoutMs: 200 }
    );
    expect(result.timedOut).toBe(true);
  }, 10000);
});
