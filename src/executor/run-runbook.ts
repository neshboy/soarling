import type { Runbook, ShellStep, StepTarget } from "../runbook/types.js";
import { evaluateCheck } from "./check.js";
import { runShellCommand } from "./shell.js";
import type { ConfirmShellStep, RunRunbookOptions, ShellResult, StepOutcome } from "./types.js";

/**
 * THE confirmation gate.
 *
 * This is the only function in SOARling that is allowed to call
 * runShellCommand, and it only does so after `confirmShellStep` has
 * resolved to exactly `true`. There is no other code path - anywhere in
 * this package - that invokes runShellCommand. That single call site is
 * what test/executor/confirmation-gate.test.ts asserts adversarially: with
 * a confirm function that always returns `false`, runShellCommand must
 * never be reached and no process must ever be spawned.
 */
export async function executeShellStep(
  step: ShellStep,
  stepNumber: number,
  confirmShellStep: ConfirmShellStep
): Promise<{ confirmed: boolean; result?: ShellResult }> {
  const confirmed = await confirmShellStep(step, stepNumber);
  if (!confirmed) {
    return { confirmed: false };
  }
  const result = await runShellCommand(step.command, { cwd: step.cwd, timeoutMs: step.timeoutMs });
  return { confirmed: true, result };
}

/**
 * Runs a validated runbook end to end, following `next`/`onTrue`/`onFalse`/
 * decision-option branches (defaulting to the next step in file order).
 * Returns the full, ordered log of what actually happened - including
 * every shell step that was proposed but declined - so a caller (the CLI,
 * or a test) can render or assert on the real run.
 */
export async function runRunbook(runbook: Runbook, options: RunRunbookOptions): Promise<StepOutcome[]> {
  const idToIndex = new Map(runbook.steps.map((step, index) => [step.id, index] as const));
  const capturedByStepId = new Map<string, ShellResult>();
  const outcomes: StepOutcome[] = [];

  let currentIndex: number | null = runbook.steps.length > 0 ? 0 : null;

  while (currentIndex !== null) {
    const index = currentIndex;
    const step = runbook.steps[index];
    const stepNumber = index + 1;
    options.onStepStart?.(step, stepNumber);

    let outcome: StepOutcome;

    switch (step.type) {
      case "shell": {
        const { confirmed, result } = await executeShellStep(step, stepNumber, options.confirmShellStep);
        if (confirmed && result) {
          capturedByStepId.set(step.id, result);
        }
        outcome = {
          stepId: step.id,
          stepNumber,
          type: "shell",
          status: confirmed ? "executed" : "skipped",
          shellResult: result,
          note: confirmed ? undefined : "confirmation denied - shell command was NOT run",
          next: step.next,
        };
        break;
      }

      case "check": {
        const priorResult = capturedByStepId.get(step.against);
        if (!priorResult) {
          outcome = {
            stepId: step.id,
            stepNumber,
            type: "check",
            status: "skipped",
            note: `referenced step "${step.against}" has no captured output (its shell command may not have been confirmed); stopping run`,
            next: "end",
          };
        } else {
          const checkPassed = evaluateCheck(step, priorResult);
          outcome = {
            stepId: step.id,
            stepNumber,
            type: "check",
            status: checkPassed ? "passed" : "failed",
            checkPassed,
            next: checkPassed ? step.onTrue : step.onFalse,
          };
        }
        break;
      }

      case "manual": {
        await options.acknowledgeManual(step, stepNumber);
        outcome = {
          stepId: step.id,
          stepNumber,
          type: "manual",
          status: "acknowledged",
          next: step.next,
        };
        break;
      }

      case "decision": {
        const label = await options.askDecision(step, stepNumber);
        const chosen = step.options.find((o) => o.label === label);
        if (!chosen) {
          // askDecision implementations are responsible for only returning a
          // valid label; this is a defensive guard, not an expected path.
          throw new Error(`Decision step "${step.id}" returned unknown option label "${label}".`);
        }
        outcome = {
          stepId: step.id,
          stepNumber,
          type: "decision",
          status: "chosen",
          decisionLabel: label,
          next: chosen.next,
        };
        break;
      }
    }

    options.onStepEnd?.(outcome);
    outcomes.push(outcome);
    currentIndex = resolveNextIndex(outcome.next, index, runbook, idToIndex);
  }

  return outcomes;
}

function resolveNextIndex(
  target: StepTarget | undefined,
  currentIndex: number,
  runbook: Runbook,
  idToIndex: Map<string, number>
): number | null {
  if (target === "end") return null;
  if (target === undefined) {
    const next = currentIndex + 1;
    return next < runbook.steps.length ? next : null;
  }
  // parseRunbook's reference validation guarantees this id exists.
  return idToIndex.get(target) ?? null;
}
