import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ShellResult } from "./types.js";

export interface RunShellCommandOptions {
  cwd?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Kills `child` AND every process it spawned (e.g. a real shell running a
 * pipeline), not just the shell process itself - a bare `child.kill()`
 * only signals the immediate child, so a `sh -c '...'` subshell's own
 * children can keep running past a timeout. On win32, `taskkill /t`
 * walks and kills the whole process tree. On POSIX, `child` was spawned
 * as its own process group leader (see the `detached` option below), so
 * negating its pid targets the whole group.
 */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], () => {
      // Best-effort: taskkill errors (e.g. the process already exited on
      // its own between the timer firing and this call) are not fatal.
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The process group may already be gone; fall back to a direct kill.
    child.kill("SIGKILL");
  }
}

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
      // Makes `child` the leader of its own process group on POSIX, so
      // killProcessTree() can kill the whole group instead of just the
      // immediate shell process. No equivalent concept on win32 (handled
      // there via `taskkill /t` instead).
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
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
