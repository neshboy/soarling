import type { RunbookStep, StepTarget } from "../runbook/types.js";

/** Real captured output of an executed shell step. */
export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export type StepStatus = "executed" | "skipped" | "passed" | "failed" | "acknowledged" | "chosen";

/** One entry in the run log returned by runRunbook, in execution order. */
export interface StepOutcome {
  stepId: string;
  stepNumber: number;
  type: RunbookStep["type"];
  status: StepStatus;
  /** Present only for shell steps that were actually executed. */
  shellResult?: ShellResult;
  /** Present only for check steps: the boolean result of the condition. */
  checkPassed?: boolean;
  /** Present only for decision steps: the option label the human picked. */
  decisionLabel?: string;
  /** Human-readable reason a step was skipped (e.g. confirmation denied). */
  note?: string;
  next: StepTarget | undefined;
}

/**
 * Called before EVERY shell step, and only before a shell step. Must
 * resolve `true` for the shell command to run. This is the single seam
 * the confirmation gate is built on - see src/executor/run-runbook.ts.
 */
export type ConfirmShellStep = (step: Extract<RunbookStep, { type: "shell" }>, stepNumber: number) => Promise<boolean>;

/** Called for decision steps to obtain the human's chosen option label. */
export type AskDecision = (step: Extract<RunbookStep, { type: "decision" }>, stepNumber: number) => Promise<string>;

/** Called for manual steps to let the human acknowledge before continuing. */
export type AcknowledgeManual = (step: Extract<RunbookStep, { type: "manual" }>, stepNumber: number) => Promise<void>;

export interface RunRunbookOptions {
  confirmShellStep: ConfirmShellStep;
  askDecision: AskDecision;
  acknowledgeManual: AcknowledgeManual;
  /** Called once per step before it runs, for CLI progress output. Optional. */
  onStepStart?: (step: RunbookStep, stepNumber: number) => void;
  /** Called once per step after it completes, for CLI progress output. Optional. */
  onStepEnd?: (outcome: StepOutcome) => void;
}
