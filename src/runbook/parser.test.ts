import { describe, expect, it } from "vitest";
import { parseRunbook } from "./parser.js";
import { RunbookValidationError } from "./errors.js";

const VALID_YAML = `
id: high-cpu-usage
version: 1
name: "High CPU Usage"
description: "Diagnose high CPU."
steps:
  - id: check-load
    type: shell
    command: "uptime"
  - id: load-is-high
    type: check
    against: check-load
    operator: contains
    value: "load average"
    onTrue: ask-human
    onFalse: end
  - id: ask-human
    type: manual
    instructions: "Page the secondary on-call."
  - id: pick-fix
    type: decision
    prompt: "Restart the service?"
    options:
      - label: "yes"
        next: restart
      - label: "no"
        next: end
  - id: restart
    type: shell
    command: "echo restart"
`;

describe("parseRunbook - valid runbooks", () => {
  it("parses a full runbook with every step type", () => {
    const runbook = parseRunbook(VALID_YAML);
    expect(runbook.id).toBe("high-cpu-usage");
    expect(runbook.version).toBe(1);
    expect(runbook.name).toBe("High CPU Usage");
    expect(runbook.steps).toHaveLength(5);
    expect(runbook.steps[0]).toMatchObject({ type: "shell", command: "uptime" });
    expect(runbook.steps[1]).toMatchObject({ type: "check", against: "check-load", operator: "contains" });
    expect(runbook.steps[2]).toMatchObject({ type: "manual" });
    expect(runbook.steps[3]).toMatchObject({ type: "decision" });
  });

  it("defaults check.field to undefined (stdout at evaluation time) when omitted", () => {
    const runbook = parseRunbook(VALID_YAML);
    const check = runbook.steps.find((s) => s.id === "load-is-high");
    expect(check && "field" in check ? check.field : undefined).toBeUndefined();
  });

  it("accepts a check step using the numeric exitCodeEquals operator", () => {
    const yaml = `
id: exit-code-check
version: 1
name: "Exit Code Check"
steps:
  - id: run-cmd
    type: shell
    command: "true"
  - id: check-exit
    type: check
    against: run-cmd
    operator: exitCodeEquals
    value: 0
`;
    const runbook = parseRunbook(yaml);
    expect(runbook.steps[1]).toMatchObject({ operator: "exitCodeEquals", value: 0 });
  });
});

describe("parseRunbook - invalid runbooks (distinct shapes)", () => {
  it("rejects malformed YAML with a malformed-yaml error, not a raw exception", () => {
    const badYaml = "id: [unterminated";
    expect(() => parseRunbook(badYaml)).toThrow(RunbookValidationError);
    try {
      parseRunbook(badYaml);
      throw new Error("expected parseRunbook to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RunbookValidationError);
      expect((err as RunbookValidationError).code).toBe("malformed-yaml");
    }
  });

  it("rejects an empty document", () => {
    expect(() => parseRunbook("")).toThrow(RunbookValidationError);
    expect(() => parseRunbook("")).toThrow(/empty/);
  });

  it("rejects a top-level list instead of a mapping", () => {
    expect(() => parseRunbook("- a\n- b\n")).toThrow(/must be a YAML mapping/);
  });

  it("rejects a non-kebab-case id", () => {
    const yaml = `
id: Not_Kebab_Case
version: 1
name: Test
steps:
  - id: a
    type: manual
    instructions: "x"
`;
    expect(() => parseRunbook(yaml)).toThrow(/invalid "id"/);
  });

  it("rejects an unsupported schema version", () => {
    const yaml = `
id: future-runbook
version: 99
name: Test
steps:
  - id: a
    type: manual
    instructions: "x"
`;
    try {
      parseRunbook(yaml);
      throw new Error("expected parseRunbook to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RunbookValidationError);
      expect((err as RunbookValidationError).code).toBe("unsupported-version");
      expect((err as RunbookValidationError).message).toMatch(/version 99/);
    }
  });

  it("rejects a missing name", () => {
    const yaml = `
id: no-name
version: 1
steps:
  - id: a
    type: manual
    instructions: "x"
`;
    expect(() => parseRunbook(yaml)).toThrow(/required non-empty "name"/);
  });

  it("rejects an empty steps list", () => {
    const yaml = `
id: no-steps
version: 1
name: Test
steps: []
`;
    expect(() => parseRunbook(yaml)).toThrow(/non-empty "steps" list/);
  });

  it("rejects a shell step with no command", () => {
    const yaml = `
id: shell-no-command
version: 1
name: Test
steps:
  - id: a
    type: shell
`;
    expect(() => parseRunbook(yaml)).toThrow(/required non-empty "command"/);
  });

  it("rejects a check step with a missing operator", () => {
    const yaml = `
id: check-no-operator
version: 1
name: Test
steps:
  - id: a
    type: shell
    command: "echo hi"
  - id: b
    type: check
    against: a
    value: "hi"
`;
    expect(() => parseRunbook(yaml)).toThrow(/invalid "operator"/);
  });

  it("rejects a check step whose numeric operator has a string value", () => {
    const yaml = `
id: check-bad-value-type
version: 1
name: Test
steps:
  - id: a
    type: shell
    command: "echo hi"
  - id: b
    type: check
    against: a
    operator: exitCodeEquals
    value: "zero"
`;
    expect(() => parseRunbook(yaml)).toThrow(/requires a numeric "value"/);
  });

  it("rejects a check step using operator \"matches\" with a syntactically invalid regular expression", () => {
    // Regression guard: this used to pass `soarling validate` and only blow
    // up later, as a raw unhandled error, when `soarling run` actually
    // evaluated the check step.
    const yaml = `
id: check-bad-regex
version: 1
name: Test
steps:
  - id: a
    type: shell
    command: "echo hi"
  - id: b
    type: check
    against: a
    operator: matches
    value: "[unclosed"
`;
    expect(() => parseRunbook(yaml)).toThrow(/not a valid regular expression/);
  });

  it("rejects a check step referencing a step that appears LATER in the list", () => {
    const yaml = `
id: check-forward-ref
version: 1
name: Test
steps:
  - id: a
    type: check
    against: b
    operator: contains
    value: "x"
  - id: b
    type: shell
    command: "echo hi"
`;
    expect(() => parseRunbook(yaml)).toThrow(/does not appear earlier/);
  });

  it("rejects a check step referencing a nonexistent step", () => {
    const yaml = `
id: check-dangling-ref
version: 1
name: Test
steps:
  - id: a
    type: check
    against: does-not-exist
    operator: contains
    value: "x"
`;
    try {
      parseRunbook(yaml);
      throw new Error("expected parseRunbook to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RunbookValidationError);
      expect((err as RunbookValidationError).code).toBe("dangling-reference");
    }
  });

  it("rejects a decision option with no next target", () => {
    const yaml = `
id: decision-no-next
version: 1
name: Test
steps:
  - id: a
    type: decision
    prompt: "Pick one"
    options:
      - label: "yes"
`;
    expect(() => parseRunbook(yaml)).toThrow(/required "next" step id/);
  });

  it("rejects a decision next that references a nonexistent step", () => {
    const yaml = `
id: decision-dangling
version: 1
name: Test
steps:
  - id: a
    type: decision
    prompt: "Pick one"
    options:
      - label: "yes"
        next: ghost-step
`;
    expect(() => parseRunbook(yaml)).toThrow(/does not exist in this runbook/);
  });

  it("rejects duplicate step ids", () => {
    const yaml = `
id: dup-ids
version: 1
name: Test
steps:
  - id: same
    type: manual
    instructions: "x"
  - id: same
    type: manual
    instructions: "y"
`;
    try {
      parseRunbook(yaml);
      throw new Error("expected parseRunbook to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RunbookValidationError);
      expect((err as RunbookValidationError).code).toBe("duplicate-id");
    }
  });

  it("rejects an unknown step type", () => {
    const yaml = `
id: unknown-type
version: 1
name: Test
steps:
  - id: a
    type: teleport
    command: "echo hi"
`;
    expect(() => parseRunbook(yaml)).toThrow(/invalid "type"/);
  });

  it("includes the provided source label in error messages", () => {
    expect(() => parseRunbook("", { source: "example.yaml" })).toThrow(/in example\.yaml/);
  });
});
