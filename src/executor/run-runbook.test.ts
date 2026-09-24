import { describe, expect, it } from "vitest";
import { parseRunbook } from "../runbook/parser.js";
import { runRunbook } from "./run-runbook.js";
import { createScriptedAcknowledge, createScriptedConfirm, createScriptedDecision } from "./confirm.js";

const RUNBOOK_YAML = `
id: integration-runbook
version: 1
name: "Integration"
steps:
  - id: check-load
    type: shell
    command: "echo load average: 9.9"
  - id: load-is-high
    type: check
    against: check-load
    operator: contains
    value: "load average"
    onTrue: notify
    onFalse: end
  - id: notify
    type: manual
    instructions: "Tell the team."
  - id: pick-fix
    type: decision
    prompt: "Restart?"
    options:
      - label: "yes"
        next: restart
      - label: "no"
        next: end
  - id: restart
    type: shell
    command: "echo restarted"
    next: end
`;

describe("runRunbook - full flow with branching", () => {
  it("follows the onTrue/decision path end-to-end when the human says yes", async () => {
    const runbook = parseRunbook(RUNBOOK_YAML);
    const outcomes = await runRunbook(runbook, {
      confirmShellStep: createScriptedConfirm([1, 5]), // confirm both shell steps by their 1-based step number
      askDecision: createScriptedDecision({ "pick-fix": "yes" }),
      acknowledgeManual: createScriptedAcknowledge(),
    });

    const ids = outcomes.map((o) => o.stepId);
    expect(ids).toEqual(["check-load", "load-is-high", "notify", "pick-fix", "restart"]);
    expect(outcomes[0].status).toBe("executed");
    expect(outcomes[0].shellResult?.stdout.trim()).toBe("load average: 9.9");
    expect(outcomes[1].status).toBe("passed");
    expect(outcomes[3].decisionLabel).toBe("yes");
    expect(outcomes[4].status).toBe("executed");
  });

  it("takes the onFalse / decline branch and stops early when the human says no", async () => {
    const runbook = parseRunbook(RUNBOOK_YAML);
    const outcomes = await runRunbook(runbook, {
      confirmShellStep: createScriptedConfirm([1]),
      askDecision: createScriptedDecision({ "pick-fix": "no" }),
      acknowledgeManual: createScriptedAcknowledge(),
    });

    const ids = outcomes.map((o) => o.stepId);
    expect(ids).toEqual(["check-load", "load-is-high", "notify", "pick-fix"]);
    expect(outcomes.find((o) => o.stepId === "restart")).toBeUndefined();
  });

  it("stops the run (does not crash) when a check's referenced step was never confirmed", async () => {
    const runbook = parseRunbook(RUNBOOK_YAML);
    const outcomes = await runRunbook(runbook, {
      confirmShellStep: createScriptedConfirm([]), // deny step 1 entirely
      askDecision: createScriptedDecision({}),
      acknowledgeManual: createScriptedAcknowledge(),
    });

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].status).toBe("skipped");
    expect(outcomes[1].status).toBe("skipped");
    expect(outcomes[1].note).toMatch(/no captured output/);
  });

  it("createScriptedDecision throws a clear error for an unscripted decision step instead of hanging", async () => {
    const runbook = parseRunbook(RUNBOOK_YAML);
    await expect(
      runRunbook(runbook, {
        confirmShellStep: createScriptedConfirm([1]),
        askDecision: createScriptedDecision({}), // no answer provided for "pick-fix"
        acknowledgeManual: createScriptedAcknowledge(),
      })
    ).rejects.toThrow(/no scripted answer/);
  });

  it("createScriptedDecision throws for an answer that is not one of the step's option labels", async () => {
    const runbook = parseRunbook(RUNBOOK_YAML);
    await expect(
      runRunbook(runbook, {
        confirmShellStep: createScriptedConfirm([1]),
        askDecision: createScriptedDecision({ "pick-fix": "maybe" }),
        acknowledgeManual: createScriptedAcknowledge(),
      })
    ).rejects.toThrow(/not one of/);
  });
});
