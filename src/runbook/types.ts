/**
 * Types for the SOARling runbook format (schema version 1).
 *
 * A runbook is a versioned, executable diagnostic playbook: an ordered list
 * of steps that either run a real shell command, check a condition against
 * a previous step's real output, show the human a manual instruction, or
 * ask the human to make a decision that branches execution.
 *
 * See README.md for the documented YAML schema. This file is the source of
 * truth for the in-memory shape that `parseRunbook` produces.
 */

export type StepId = string;

/** Every step field that can point elsewhere in the runbook. "end" stops execution. */
export type StepTarget = StepId | "end";

export interface BaseStep {
  id: StepId;
  description?: string;
}

/**
 * Runs a real shell command via a real child process. This is the ONLY step
 * type that touches the outside world, and the ONLY step type gated by the
 * human-confirmation boundary enforced in src/executor/run-runbook.ts.
 */
export interface ShellStep extends BaseStep {
  type: "shell";
  command: string;
  /** Working directory for the command. Defaults to process.cwd(). */
  cwd?: string;
  /** Kill the command if it runs longer than this. Defaults to 30_000ms. */
  timeoutMs?: number;
  /** Next step to run. Defaults to the next step in the list. */
  next?: StepTarget;
}

export type CheckField = "stdout" | "stderr" | "exitCode";

export type CheckOperator =
  | "equals"
  | "contains"
  | "notContains"
  | "matches"
  | "exitCodeEquals"
  | "exitCodeNotEquals";

/**
 * Evaluates a real condition against the captured output of a PRIOR step
 * (referenced by `against`, which must appear earlier in `steps`). Never
 * executes anything itself.
 */
export interface CheckStep extends BaseStep {
  type: "check";
  /** id of an earlier step whose captured output this check inspects. */
  against: StepId;
  /** Which part of that step's output to inspect. Defaults to "stdout". */
  field?: CheckField;
  operator: CheckOperator;
  value: string | number;
  /** Step to jump to if the condition is true. Defaults to the next step. */
  onTrue?: StepTarget;
  /** Step to jump to if the condition is false. Defaults to the next step. */
  onFalse?: StepTarget;
}

/** A human-readable instruction with no command to run. */
export interface ManualStep extends BaseStep {
  type: "manual";
  instructions: string;
  next?: StepTarget;
}

export interface DecisionOption {
  label: string;
  next: StepTarget;
}

/** Asks the human to choose one of several labeled options; branches on the answer. */
export interface DecisionStep extends BaseStep {
  type: "decision";
  prompt: string;
  options: DecisionOption[];
}

export type RunbookStep = ShellStep | CheckStep | ManualStep | DecisionStep;

export type RunbookStepType = RunbookStep["type"];

export interface Runbook {
  id: string;
  version: 1;
  name: string;
  description?: string;
  steps: RunbookStep[];
}
