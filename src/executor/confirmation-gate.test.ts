import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShellStep } from "../runbook/types.js";
import { executeShellStep, runRunbook } from "./run-runbook.js";
import * as shellModule from "./shell.js";

/**
 * THE adversarial test for the human-in-the-loop safety boundary.
 *
 * The claim being tested: a `shell` step's command is NEVER executed
 * unless its confirmation gate resolves to `true`. This is proven two
 * ways, deliberately not relying on mocked child_process:
 *
 *  1. A real side effect (writing a real marker file to a real temp
 *     directory via a real child process) either exists on the real
 *     filesystem afterwards, or it doesn't. There is no way to fake this
 *     assertion passing short of the process having actually run.
 *  2. A spy on the exact function that is allowed to spawn a process
 *     (runShellCommand) shows it was never even called.
 *
 * A positive control (confirmation granted -> marker file DOES appear)
 * proves the harness itself isn't just accidentally skipping every step.
 */
describe("confirmation gate (adversarial: shell steps must never run unconfirmed)", () => {
  let dir: string;
  let markerFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "soarling-gate-"));
    markerFile = join(dir, "marker.txt");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeMarkerStep(): ShellStep {
    // Write the marker-writing logic to its own real script file rather than
    // an inline `-e "..."` snippet, so the outer shell command only ever
    // needs to quote plain file paths (no nested quoting of a JS string
    // literal inside a shell-quoted argument, which cmd.exe on Windows does
    // not handle the same way POSIX shells do).
    const scriptPath = join(dir, "write-marker.js");
    writeFileSync(scriptPath, `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, "ran");\n`);
    return {
      id: "danger",
      type: "shell",
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
    };
  }

  it("never creates the marker file - i.e. the process is never spawned - when confirmation is denied", async () => {
    const denyConfirm = vi.fn().mockResolvedValue(false);
    const outcome = await executeShellStep(writeMarkerStep(), 1, denyConfirm);

    expect(outcome.confirmed).toBe(false);
    expect(outcome.result).toBeUndefined();
    expect(existsSync(markerFile)).toBe(false); // real filesystem check, not a mock assertion
    expect(denyConfirm).toHaveBeenCalledTimes(1);
    expect(denyConfirm).toHaveBeenCalledWith(expect.objectContaining({ id: "danger" }), 1);
  });

  it("never calls the real shell-spawning function at all when confirmation is denied", async () => {
    const spy = vi.spyOn(shellModule, "runShellCommand");
    try {
      const denyConfirm = vi.fn().mockResolvedValue(false);
      await executeShellStep(writeMarkerStep(), 1, denyConfirm);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("positive control: DOES create the marker file when confirmation is granted (proves the gate isn't just always skipping)", async () => {
    const allowConfirm = vi.fn().mockResolvedValue(true);
    const outcome = await executeShellStep(writeMarkerStep(), 1, allowConfirm);

    expect(outcome.confirmed).toBe(true);
    expect(outcome.result?.exitCode).toBe(0);
    expect(existsSync(markerFile)).toBe(true);
  });

  it("fails closed, not open: a throwing confirm function still results in no process spawned", async () => {
    const throwingConfirm = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(executeShellStep(writeMarkerStep(), 1, throwingConfirm)).rejects.toThrow("boom");
    expect(existsSync(markerFile)).toBe(false);
  });

  it("holds at the full runRunbook level too, not just in the isolated helper", async () => {
    const runbook = {
      id: "adversarial-runbook",
      version: 1 as const,
      name: "Adversarial",
      steps: [writeMarkerStep()],
    };

    const outcomes = await runRunbook(runbook, {
      confirmShellStep: async () => false,
      askDecision: async () => {
        throw new Error("no decision steps exist in this runbook");
      },
      acknowledgeManual: async () => {
        throw new Error("no manual steps exist in this runbook");
      },
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe("skipped");
    expect(existsSync(markerFile)).toBe(false);
  });

  it("only confirms the exact step numbers named by a scripted allow-list, denying every other shell step", async () => {
    const { createScriptedConfirm } = await import("./confirm.js");
    const confirm = createScriptedConfirm([2]); // only step 2 is pre-authorized

    const stepOne = await executeShellStep(writeMarkerStep(), 1, confirm);
    expect(stepOne.confirmed).toBe(false);
    expect(existsSync(markerFile)).toBe(false);

    const stepTwo = await executeShellStep(writeMarkerStep(), 2, confirm);
    expect(stepTwo.confirmed).toBe(true);
    expect(existsSync(markerFile)).toBe(true);
  });
});
