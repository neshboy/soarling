import { describe, expect, it } from "vitest";
import { evaluateCheck } from "./check.js";
import type { CheckStep } from "../runbook/types.js";
import type { ShellResult } from "./types.js";

function checkStep(partial: Partial<CheckStep>): CheckStep {
  return {
    id: "chk",
    type: "check",
    against: "prior",
    operator: "contains",
    value: "x",
    ...partial,
  } as CheckStep;
}

function result(partial: Partial<ShellResult>): ShellResult {
  return { stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: 1, ...partial };
}

describe("evaluateCheck", () => {
  it("contains: true when stdout includes the value", () => {
    expect(evaluateCheck(checkStep({ operator: "contains", value: "load average" }), result({ stdout: "load average: 4.2" }))).toBe(true);
  });

  it("contains: false when stdout does not include the value", () => {
    expect(evaluateCheck(checkStep({ operator: "contains", value: "load average" }), result({ stdout: "all quiet" }))).toBe(false);
  });

  it("notContains: inverse of contains", () => {
    expect(evaluateCheck(checkStep({ operator: "notContains", value: "error" }), result({ stdout: "all good" }))).toBe(true);
    expect(evaluateCheck(checkStep({ operator: "notContains", value: "error" }), result({ stdout: "an error occurred" }))).toBe(false);
  });

  it("equals: exact string match on the chosen field", () => {
    expect(evaluateCheck(checkStep({ operator: "equals", value: "ready" }), result({ stdout: "ready\n" }))).toBe(false);
    expect(evaluateCheck(checkStep({ operator: "equals", value: "ready" }), result({ stdout: "ready" }))).toBe(true);
  });

  it("matches: evaluates the value as a regular expression", () => {
    expect(evaluateCheck(checkStep({ operator: "matches", value: "^\\d+ users$" }), result({ stdout: "42 users" }))).toBe(true);
    expect(evaluateCheck(checkStep({ operator: "matches", value: "^\\d+ users$" }), result({ stdout: "users: 42" }))).toBe(false);
  });

  it("exitCodeEquals / exitCodeNotEquals operate on the real exit code, not stdout", () => {
    expect(evaluateCheck(checkStep({ operator: "exitCodeEquals", value: 0 }), result({ exitCode: 0, stdout: "irrelevant" }))).toBe(true);
    expect(evaluateCheck(checkStep({ operator: "exitCodeEquals", value: 0 }), result({ exitCode: 1 }))).toBe(false);
    expect(evaluateCheck(checkStep({ operator: "exitCodeNotEquals", value: 0 }), result({ exitCode: 1 }))).toBe(true);
  });

  it("field: stderr inspects stderr instead of stdout", () => {
    const step = checkStep({ operator: "contains", value: "permission denied", field: "stderr" });
    expect(evaluateCheck(step, result({ stdout: "permission denied", stderr: "ok" }))).toBe(false);
    expect(evaluateCheck(step, result({ stdout: "ok", stderr: "permission denied" }))).toBe(true);
  });
});
