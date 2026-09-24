import type { CheckStep } from "../runbook/types.js";
import type { ShellResult } from "./types.js";

/**
 * Evaluates a `check` step's condition against a previously captured
 * ShellResult. Pure and side-effect free - a check never runs anything,
 * it only inspects output SOARling already captured from an earlier,
 * human-confirmed shell step.
 */
export function evaluateCheck(step: CheckStep, priorResult: ShellResult): boolean {
  const field = step.field ?? "stdout";
  const actual: string | number | null = field === "exitCode" ? priorResult.exitCode : priorResult[field];

  switch (step.operator) {
    case "equals":
      return String(actual ?? "") === String(step.value);
    case "contains":
      return String(actual ?? "").includes(String(step.value));
    case "notContains":
      return !String(actual ?? "").includes(String(step.value));
    case "matches":
      return new RegExp(String(step.value)).test(String(actual ?? ""));
    case "exitCodeEquals":
      return priorResult.exitCode === Number(step.value);
    case "exitCodeNotEquals":
      return priorResult.exitCode !== Number(step.value);
    default: {
      // Exhaustiveness guard - parseRunbook already rejects any other operator.
      const _never: never = step.operator;
      throw new Error(`Unsupported check operator: ${String(_never)}`);
    }
  }
}
