import { spawn } from "node:child_process";
import type { ShellResult } from "./types.js";

export interface RunShellCommandOptions {
  cwd?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Actually runs `command` in a real shell (a real child process - not a
 * mock) and captures its real stdout/stderr/exit code. This is the ONLY
 * function in SOARling that spawns a process, and it is called from
 * exactly one place: the confirmed branch of executeShellStep in
 * run-runbook.ts. Never throws on a non-zero exit code - a failing
 * diagnostic command is normal signal for `check` steps to evaluate, not
 * an executor error.
 */
export function runShellCommand(command: string, options: RunShellCommandOptions = {}): Promise<ShellResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += (stderr ? "\n" : "") + `[soarling] failed to launch command: ${(err as Error).message}`;
      resolvePromise({
        stdout,
        stderr,
        exitCode: null,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
