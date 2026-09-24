#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { parseRunbook } from "./runbook/parser.js";
import { RunbookValidationError } from "./runbook/errors.js";
import { parseAlertmanagerPayload } from "./alerts/payload.js";
import { parseBindings } from "./alerts/bindings.js";
import { matchAlerts } from "./alerts/matcher.js";
import { AlertConfigError } from "./alerts/errors.js";
import { runRunbook } from "./executor/run-runbook.js";
import {
  createInteractivePrompts,
  createScriptedAcknowledge,
  createScriptedConfirm,
  createScriptedDecision,
} from "./executor/confirm.js";
import type { RunRunbookOptions, StepOutcome } from "./executor/types.js";
import type { RunbookStep } from "./runbook/types.js";

const DEFAULT_BINDINGS_FILENAME = "soarling.bindings.yaml";

function readFileOrExit(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    console.error(`soarling: file not found: ${resolved}`);
    process.exit(1);
  }
  try {
    return readFileSync(resolved, "utf8");
  } catch (err) {
    console.error(`soarling: could not read ${resolved}: ${(err as Error).message}`);
    process.exit(1);
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectStepNumber(value: string, previous: number[]): number[] {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`soarling: --yes-to-step expects a positive integer, got "${value}"`);
    process.exit(1);
  }
  return [...previous, n];
}

function parseAnswers(raw: string[]): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq === -1) {
      console.error(`soarling: --answer expects "<stepId>=<label>", got "${entry}"`);
      process.exit(1);
    }
    answers[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return answers;
}

function describeStep(step: RunbookStep): string {
  switch (step.type) {
    case "shell":
      return `run \`${step.command}\``;
    case "check":
      return `check against "${step.against}"`;
    case "manual":
      return step.instructions;
    case "decision":
      return step.prompt;
  }
}

function printOutcome(outcome: StepOutcome): void {
  const prefix = `[${outcome.stepNumber}] ${outcome.stepId} (${outcome.type})`;
  switch (outcome.status) {
    case "executed":
      console.log(`${prefix}: executed - exit ${outcome.shellResult?.exitCode}`);
      if (outcome.shellResult?.stdout) {
        console.log(indent(outcome.shellResult.stdout));
      }
      if (outcome.shellResult?.stderr) {
        console.log(indent(outcome.shellResult.stderr));
      }
      break;
    case "skipped":
      console.log(`${prefix}: SKIPPED - ${outcome.note ?? "not confirmed"}`);
      break;
    case "passed":
    case "failed":
      console.log(`${prefix}: condition ${outcome.status}`);
      break;
    case "acknowledged":
      console.log(`${prefix}: acknowledged`);
      break;
    case "chosen":
      console.log(`${prefix}: chose "${outcome.decisionLabel}"`);
      break;
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => `    ${line}`)
    .join("\n");
}

const program = new Command();
program.name("soarling").description("Runbook-as-code engine for incident response").version("0.1.0");

program
  .command("validate")
  .description("Validate a runbook YAML file against the SOARling schema")
  .argument("<runbook>", "path to a runbook YAML file")
  .action((runbookPath: string) => {
    const text = readFileOrExit(runbookPath);
    try {
      const runbook = parseRunbook(text, { source: runbookPath });
      console.log(`OK: ${runbookPath} is a valid runbook ("${runbook.name}", ${runbook.steps.length} step(s)).`);
    } catch (err) {
      if (err instanceof RunbookValidationError) {
        console.error(`INVALID [${err.code}]: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  });

program
  .command("match")
  .description("Resolve which runbook an Alertmanager webhook payload maps to")
  .argument("<payload>", "path to an Alertmanager webhook JSON payload")
  .option("--bindings <path>", `path to a bindings YAML file (default: ./${DEFAULT_BINDINGS_FILENAME})`)
  .action((payloadPath: string, opts: { bindings?: string }) => {
    const bindingsPath = opts.bindings ?? DEFAULT_BINDINGS_FILENAME;
    if (!opts.bindings && !existsSync(resolve(bindingsPath))) {
      console.error(
        `soarling: no bindings file found at ./${DEFAULT_BINDINGS_FILENAME} and --bindings was not given.`
      );
      process.exit(1);
    }

    const payloadText = readFileOrExit(payloadPath);
    const bindingsText = readFileOrExit(bindingsPath);

    try {
      const payload = parseAlertmanagerPayload(payloadText, { source: payloadPath });
      const bindingsConfig = parseBindings(bindingsText, { source: bindingsPath });
      const results = matchAlerts(payload, bindingsConfig, bindingsPath);

      for (const { alert, runbookPath } of results) {
        const name = alert.labels.alertname;
        if (runbookPath) {
          console.log(`${name} [${alert.status}] -> ${runbookPath}`);
        } else {
          console.log(`${name} [${alert.status}] -> NO MATCH`);
        }
      }

      if (results.some((r) => r.runbookPath === null)) {
        process.exit(1);
      }
    } catch (err) {
      if (err instanceof AlertConfigError) {
        console.error(`INVALID [${err.code}]: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  });

program
  .command("run")
  .description("Run a runbook, step by step, with a human confirming every shell step")
  .argument("<runbook>", "path to a runbook YAML file")
  .option(
    "--yes-to-step <n>",
    "pre-confirm shell step number n (repeatable); only used with --non-interactive",
    collectStepNumber,
    []
  )
  .option("--answer <stepId=label>", "scripted answer for a decision step (repeatable)", collect, [])
  .option("--non-interactive", "use only --yes-to-step/--answer, never prompt (for scripts and tests)", false)
  .action(async (runbookPath: string, opts: { yesToStep: number[]; answer: string[]; nonInteractive: boolean }) => {
    const text = readFileOrExit(runbookPath);

    let runbook;
    try {
      runbook = parseRunbook(text, { source: runbookPath });
    } catch (err) {
      if (err instanceof RunbookValidationError) {
        console.error(`INVALID [${err.code}]: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }

    console.log(`Running "${runbook.name}" (${runbook.steps.length} step(s))`);
    console.log(
      "Every shell step requires explicit confirmation before it runs. Nothing executes automatically.\n"
    );

    let close = () => {};
    let runOptions: RunRunbookOptions;

    if (opts.nonInteractive) {
      runOptions = {
        confirmShellStep: createScriptedConfirm(opts.yesToStep),
        askDecision: createScriptedDecision(parseAnswers(opts.answer)),
        acknowledgeManual: createScriptedAcknowledge(),
        onStepStart: (step, n) => console.log(`\n[${n}] ${step.id}: ${describeStep(step)}`),
        onStepEnd: printOutcome,
      };
    } else {
      const prompts = createInteractivePrompts();
      close = prompts.close;
      runOptions = {
        confirmShellStep: prompts.confirmShellStep,
        askDecision: prompts.askDecision,
        acknowledgeManual: prompts.acknowledgeManual,
        onStepEnd: printOutcome,
      };
    }

    try {
      const outcomes = await runRunbook(runbook, runOptions);
      const executed = outcomes.filter((o) => o.status === "executed").length;
      const skipped = outcomes.filter((o) => o.status === "skipped").length;
      console.log(`\nDone. ${outcomes.length} step(s) reached, ${executed} shell command(s) run, ${skipped} skipped.`);
    } finally {
      close();
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`soarling: unexpected error: ${(err as Error).message}`);
  process.exit(1);
});
