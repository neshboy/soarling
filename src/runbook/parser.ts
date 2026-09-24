import { parse as parseYaml } from "yaml";
import { RunbookValidationError } from "./errors.js";
import type {
  CheckField,
  CheckOperator,
  CheckStep,
  DecisionOption,
  DecisionStep,
  ManualStep,
  Runbook,
  RunbookStep,
  ShellStep,
  StepTarget,
} from "./types.js";

const SUPPORTED_VERSION = 1;
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const STEP_TYPES = new Set(["shell", "check", "manual", "decision"]);
const CHECK_FIELDS = new Set<CheckField>(["stdout", "stderr", "exitCode"]);
const CHECK_OPERATORS = new Set<CheckOperator>([
  "equals",
  "contains",
  "notContains",
  "matches",
  "exitCodeEquals",
  "exitCodeNotEquals",
]);
const NUMERIC_OPERATORS = new Set<CheckOperator>(["exitCodeEquals", "exitCodeNotEquals"]);

export interface ParseRunbookOptions {
  /** Where the runbook text came from, used only for error messages. */
  source?: string;
}

/**
 * The only place runbook YAML text is turned into a validated Runbook.
 * Every rejection throws a RunbookValidationError with a message that names
 * the exact field/step at fault - readable errors, not swallowed
 * exceptions and not a raw yaml/type-cast error escaping to a caller.
 */
export function parseRunbook(text: string, options: ParseRunbookOptions = {}): Runbook {
  const label = options.source ? ` in ${options.source}` : "";

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new RunbookValidationError(`Could not parse YAML${label}: ${(err as Error).message}`, "malformed-yaml");
  }

  if (raw === null || raw === undefined) {
    throw new RunbookValidationError(`Runbook${label} is empty.`, "invalid-schema");
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RunbookValidationError(`Runbook${label} must be a YAML mapping at the top level.`, "invalid-schema");
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.id !== "string" || !ID_PATTERN.test(obj.id)) {
    throw new RunbookValidationError(
      `Runbook${label} has an invalid "id" (${JSON.stringify(obj.id)}); expected a kebab-case string matching ${ID_PATTERN}.`,
      "invalid-schema"
    );
  }

  if (typeof obj.version !== "number" || !Number.isInteger(obj.version)) {
    throw new RunbookValidationError(`Runbook${label} is missing a required integer "version" field.`, "invalid-schema");
  }
  if (obj.version !== SUPPORTED_VERSION) {
    throw new RunbookValidationError(
      `Runbook${label} declares version ${obj.version}, but this build of SOARling only supports version ${SUPPORTED_VERSION}.`,
      "unsupported-version"
    );
  }

  if (typeof obj.name !== "string" || obj.name.trim().length === 0) {
    throw new RunbookValidationError(`Runbook${label} is missing a required non-empty "name" field.`, "invalid-schema");
  }

  if (obj.description !== undefined && typeof obj.description !== "string") {
    throw new RunbookValidationError(`Runbook${label} field "description" must be a string.`, "invalid-schema");
  }

  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    throw new RunbookValidationError(
      `Runbook${label} is missing a required non-empty "steps" list.`,
      "invalid-schema"
    );
  }

  const seenIds = new Set<string>();
  const steps = obj.steps.map((entry, index) => parseStep(entry, index, label, seenIds));

  validateReferences(steps, label);

  return {
    id: obj.id,
    version: 1,
    name: obj.name,
    description: obj.description as string | undefined,
    steps,
  };
}

function parseStep(entry: unknown, index: number, label: string, seenIds: Set<string>): RunbookStep {
  const where = `steps[${index}]${label}`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new RunbookValidationError(`${where} must be a mapping.`, "invalid-schema");
  }
  const obj = entry as Record<string, unknown>;

  if (typeof obj.id !== "string" || !ID_PATTERN.test(obj.id)) {
    throw new RunbookValidationError(
      `${where} has an invalid "id" (${JSON.stringify(obj.id)}); expected a kebab-case string matching ${ID_PATTERN}.`,
      "invalid-schema"
    );
  }
  if (seenIds.has(obj.id)) {
    throw new RunbookValidationError(`${where} reuses step id "${obj.id}", which must be unique.`, "duplicate-id");
  }
  seenIds.add(obj.id);

  if (typeof obj.type !== "string" || !STEP_TYPES.has(obj.type)) {
    throw new RunbookValidationError(
      `${where} (id "${obj.id}") has an invalid "type" (${JSON.stringify(obj.type)}); expected one of shell, check, manual, decision.`,
      "invalid-schema"
    );
  }

  if (obj.description !== undefined && typeof obj.description !== "string") {
    throw new RunbookValidationError(
      `${where} (id "${obj.id}") field "description" must be a string.`,
      "invalid-schema"
    );
  }

  const stepWhere = `${where} (id "${obj.id}", type "${obj.type}")`;

  switch (obj.type) {
    case "shell":
      return parseShellStep(obj, stepWhere);
    case "check":
      return parseCheckStep(obj, stepWhere);
    case "manual":
      return parseManualStep(obj, stepWhere);
    case "decision":
      return parseDecisionStep(obj, stepWhere);
    default:
      // Unreachable: obj.type was already checked against STEP_TYPES above.
      throw new RunbookValidationError(`${stepWhere} has an unsupported type.`, "invalid-schema");
  }
}

function parseTarget(value: unknown, field: string, where: string): StepTarget | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunbookValidationError(`${where} field "${field}" must be a non-empty string step id, or "end".`, "invalid-schema");
  }
  return value as StepTarget;
}

function parseShellStep(obj: Record<string, unknown>, where: string): ShellStep {
  if (typeof obj.command !== "string" || obj.command.trim().length === 0) {
    throw new RunbookValidationError(`${where} is missing a required non-empty "command" string.`, "invalid-schema");
  }
  if (obj.cwd !== undefined && typeof obj.cwd !== "string") {
    throw new RunbookValidationError(`${where} field "cwd" must be a string.`, "invalid-schema");
  }
  if (obj.timeoutMs !== undefined && (typeof obj.timeoutMs !== "number" || obj.timeoutMs <= 0)) {
    throw new RunbookValidationError(`${where} field "timeoutMs" must be a positive number.`, "invalid-schema");
  }
  return {
    id: obj.id as string,
    type: "shell",
    description: obj.description as string | undefined,
    command: obj.command,
    cwd: obj.cwd as string | undefined,
    timeoutMs: obj.timeoutMs as number | undefined,
    next: parseTarget(obj.next, "next", where),
  };
}

function parseCheckStep(obj: Record<string, unknown>, where: string): CheckStep {
  if (typeof obj.against !== "string" || obj.against.trim().length === 0) {
    throw new RunbookValidationError(
      `${where} is missing a required "against" field naming the earlier step id whose output to inspect.`,
      "invalid-schema"
    );
  }
  let field: CheckField | undefined;
  if (obj.field !== undefined) {
    if (typeof obj.field !== "string" || !CHECK_FIELDS.has(obj.field as CheckField)) {
      throw new RunbookValidationError(
        `${where} has an invalid "field" (${JSON.stringify(obj.field)}); expected one of stdout, stderr, exitCode.`,
        "invalid-schema"
      );
    }
    field = obj.field as CheckField;
  }
  if (typeof obj.operator !== "string" || !CHECK_OPERATORS.has(obj.operator as CheckOperator)) {
    throw new RunbookValidationError(
      `${where} has an invalid "operator" (${JSON.stringify(obj.operator)}); expected one of ${[...CHECK_OPERATORS].join(", ")}.`,
      "invalid-schema"
    );
  }
  const operator = obj.operator as CheckOperator;
  if (obj.value === undefined || obj.value === null) {
    throw new RunbookValidationError(`${where} is missing a required "value" field.`, "invalid-schema");
  }
  if (NUMERIC_OPERATORS.has(operator) && typeof obj.value !== "number") {
    throw new RunbookValidationError(
      `${where} operator "${operator}" requires a numeric "value", got ${JSON.stringify(obj.value)}.`,
      "invalid-schema"
    );
  }
  if (!NUMERIC_OPERATORS.has(operator) && typeof obj.value !== "string") {
    throw new RunbookValidationError(
      `${where} operator "${operator}" requires a string "value", got ${JSON.stringify(obj.value)}.`,
      "invalid-schema"
    );
  }

  return {
    id: obj.id as string,
    type: "check",
    description: obj.description as string | undefined,
    against: obj.against,
    field,
    operator,
    value: obj.value as string | number,
    onTrue: parseTarget(obj.onTrue, "onTrue", where),
    onFalse: parseTarget(obj.onFalse, "onFalse", where),
  };
}

function parseManualStep(obj: Record<string, unknown>, where: string): ManualStep {
  if (typeof obj.instructions !== "string" || obj.instructions.trim().length === 0) {
    throw new RunbookValidationError(
      `${where} is missing a required non-empty "instructions" string.`,
      "invalid-schema"
    );
  }
  return {
    id: obj.id as string,
    type: "manual",
    description: obj.description as string | undefined,
    instructions: obj.instructions,
    next: parseTarget(obj.next, "next", where),
  };
}

function parseDecisionStep(obj: Record<string, unknown>, where: string): DecisionStep {
  if (typeof obj.prompt !== "string" || obj.prompt.trim().length === 0) {
    throw new RunbookValidationError(`${where} is missing a required non-empty "prompt" string.`, "invalid-schema");
  }
  if (!Array.isArray(obj.options) || obj.options.length === 0) {
    throw new RunbookValidationError(`${where} is missing a required non-empty "options" list.`, "invalid-schema");
  }
  const seenLabels = new Set<string>();
  const options: DecisionOption[] = obj.options.map((entry, optIndex) => {
    const optWhere = `${where} options[${optIndex}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new RunbookValidationError(`${optWhere} must be a mapping.`, "invalid-schema");
    }
    const optObj = entry as Record<string, unknown>;
    if (typeof optObj.label !== "string" || optObj.label.trim().length === 0) {
      throw new RunbookValidationError(`${optWhere} is missing a required non-empty "label" string.`, "invalid-schema");
    }
    if (seenLabels.has(optObj.label)) {
      throw new RunbookValidationError(`${optWhere} reuses option label "${optObj.label}", which must be unique.`, "duplicate-id");
    }
    seenLabels.add(optObj.label);
    const next = parseTarget(optObj.next, "next", optWhere);
    if (next === undefined) {
      throw new RunbookValidationError(`${optWhere} is missing a required "next" step id (or "end").`, "invalid-schema");
    }
    return { label: optObj.label, next };
  });

  return {
    id: obj.id as string,
    type: "decision",
    description: obj.description as string | undefined,
    prompt: obj.prompt,
    options,
  };
}

/**
 * Second pass, after every step has parsed structurally in isolation:
 * every id a step points at (next/onTrue/onFalse/option.next/against) must
 * exist in the runbook or be the literal "end", and `check.against` must
 * point at a step that appears EARLIER in the list (it inspects already-
 * captured output, so a forward or self reference can never be satisfied).
 */
function validateReferences(steps: RunbookStep[], label: string): void {
  const idToIndex = new Map(steps.map((step, index) => [step.id, index] as const));

  const checkTarget = (target: StepTarget | undefined, where: string, field: string): void => {
    if (target === undefined || target === "end") return;
    if (!idToIndex.has(target)) {
      throw new RunbookValidationError(
        `${where} field "${field}" references step id "${target}", which does not exist in this runbook.`,
        "dangling-reference"
      );
    }
  };

  steps.forEach((step, index) => {
    const where = `steps[${index}]${label} (id "${step.id}")`;
    switch (step.type) {
      case "shell":
        checkTarget(step.next, where, "next");
        break;
      case "manual":
        checkTarget(step.next, where, "next");
        break;
      case "check": {
        const againstIndex = idToIndex.get(step.against);
        if (againstIndex === undefined) {
          throw new RunbookValidationError(
            `${where} field "against" references step id "${step.against}", which does not exist in this runbook.`,
            "dangling-reference"
          );
        }
        if (againstIndex >= index) {
          throw new RunbookValidationError(
            `${where} field "against" references step id "${step.against}", which does not appear earlier in "steps" ` +
              `(a check can only inspect output already captured by a prior step).`,
            "dangling-reference"
          );
        }
        checkTarget(step.onTrue, where, "onTrue");
        checkTarget(step.onFalse, where, "onFalse");
        break;
      }
      case "decision":
        step.options.forEach((option, optIndex) => {
          checkTarget(option.next, `${where} options[${optIndex}]`, "next");
        });
        break;
    }
  });
}
