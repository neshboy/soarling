import * as readline from "node:readline/promises";
import type { DecisionStep, ManualStep, ShellStep } from "../runbook/types.js";
import type { AcknowledgeManual, AskDecision, ConfirmShellStep } from "./types.js";

/**
 * Interactive human-in-the-loop implementations, backed by a real readline
 * prompt on the given input/output streams (stdin/stdout by default).
 * Nothing here defaults to "yes" - an unanswered or EOF'd prompt resolves
 * to `false` for shell confirmation, never `true`.
 */
export function createInteractivePrompts(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): {
  confirmShellStep: ConfirmShellStep;
  askDecision: AskDecision;
  acknowledgeManual: AcknowledgeManual;
  close: () => void;
} {
  const rl = readline.createInterface({ input, output });

  const confirmShellStep: ConfirmShellStep = async (step: ShellStep, stepNumber: number) => {
    const answer = await rl
      .question(`\nStep ${stepNumber} [shell] ${step.id}: run \`${step.command}\`? [y/N] `)
      .catch(() => "");
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  };

  const askDecision: AskDecision = async (step: DecisionStep, stepNumber: number) => {
    const labels = step.options.map((o) => o.label);
    for (;;) {
      const answer = await rl
        .question(`\nStep ${stepNumber} [decision] ${step.prompt} (${labels.join(" / ")}) `)
        .catch(() => "");
      const match = step.options.find((o) => o.label.toLowerCase() === answer.trim().toLowerCase());
      if (match) return match.label;
      output.write(`Please answer one of: ${labels.join(", ")}\n`);
    }
  };

  const acknowledgeManual: AcknowledgeManual = async (step: ManualStep, stepNumber: number) => {
    await rl
      .question(`\nStep ${stepNumber} [manual] ${step.instructions}\nPress Enter once done. `)
      .catch(() => "");
  };

  return { confirmShellStep, askDecision, acknowledgeManual, close: () => rl.close() };
}

/**
 * Scripted confirmation for non-interactive / test use: `soarling run` with
 * `--yes-to-step <n>` (repeatable). Only the EXACT step numbers named are
 * confirmed - every other shell step is denied. There is deliberately no
 * "confirm everything" option: a scripted run still requires the caller to
 * enumerate which steps they're authorizing.
 */
export function createScriptedConfirm(confirmedStepNumbers: readonly number[]): ConfirmShellStep {
  const allowed = new Set(confirmedStepNumbers);
  return async (_step, stepNumber) => allowed.has(stepNumber);
}

/** Scripted decision answers for non-interactive / test use: a map of stepId -> chosen option label. */
export function createScriptedDecision(answers: Readonly<Record<string, string>>): AskDecision {
  return async (step, stepNumber) => {
    const answer = answers[step.id];
    if (answer === undefined) {
      throw new Error(
        `Decision step "${step.id}" (step ${stepNumber}) has no scripted answer; pass --answer ${step.id}=<label>.`
      );
    }
    const match = step.options.find((o) => o.label === answer);
    if (!match) {
      throw new Error(
        `Decision step "${step.id}" (step ${stepNumber}) got scripted answer "${answer}", which is not one of: ` +
          step.options.map((o) => o.label).join(", ")
      );
    }
    return match.label;
  };
}

/** Scripted manual acknowledgement for non-interactive / test use: always resolves immediately. */
export function createScriptedAcknowledge(): AcknowledgeManual {
  return async () => {};
}
