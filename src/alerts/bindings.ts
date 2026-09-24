import { parse as parseYaml } from "yaml";
import { AlertConfigError } from "./errors.js";
import type { BindingRule, BindingsConfig } from "./types.js";

const SUPPORTED_VERSION = 1;

export interface ParseBindingsOptions {
  source?: string;
}

/**
 * Parses and validates a bindings file: the config that maps
 * `{alertname, labels}` match criteria to a runbook file path. This is the
 * "right runbook surfaces automatically" half of SOARling - it never
 * executes anything, it only resolves a path.
 */
export function parseBindings(text: string, options: ParseBindingsOptions = {}): BindingsConfig {
  const label = options.source ? ` in ${options.source}` : "";

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new AlertConfigError(`Could not parse YAML${label}: ${(err as Error).message}`, "malformed-yaml");
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AlertConfigError(`Bindings file${label} must be a YAML mapping at the top level.`, "invalid-schema");
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.version !== "number" || !Number.isInteger(obj.version)) {
    throw new AlertConfigError(`Bindings file${label} is missing a required integer "version" field.`, "invalid-schema");
  }
  if (obj.version !== SUPPORTED_VERSION) {
    throw new AlertConfigError(
      `Bindings file${label} declares version ${obj.version}, but this build of SOARling only supports version ${SUPPORTED_VERSION}.`,
      "invalid-schema"
    );
  }

  if (!Array.isArray(obj.bindings) || obj.bindings.length === 0) {
    throw new AlertConfigError(`Bindings file${label} is missing a required non-empty "bindings" list.`, "invalid-schema");
  }

  const bindings = obj.bindings.map((entry, index) => parseBindingRule(entry, index, label));

  return { version: 1, bindings };
}

function parseBindingRule(entry: unknown, index: number, label: string): BindingRule {
  const where = `bindings[${index}]${label}`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new AlertConfigError(`${where} must be a mapping.`, "invalid-schema");
  }
  const obj = entry as Record<string, unknown>;

  if (typeof obj.match !== "object" || obj.match === null || Array.isArray(obj.match)) {
    throw new AlertConfigError(`${where} is missing a required "match" mapping.`, "invalid-schema");
  }
  const match = obj.match as Record<string, unknown>;

  if (typeof match.alertname !== "string" || match.alertname.trim().length === 0) {
    throw new AlertConfigError(`${where} field "match.alertname" must be a non-empty string.`, "invalid-schema");
  }

  let labels: Record<string, string> | undefined;
  if (match.labels !== undefined) {
    if (typeof match.labels !== "object" || match.labels === null || Array.isArray(match.labels)) {
      throw new AlertConfigError(`${where} field "match.labels" must be a mapping of string values.`, "invalid-schema");
    }
    const labelsObj = match.labels as Record<string, unknown>;
    for (const [key, value] of Object.entries(labelsObj)) {
      if (typeof value !== "string") {
        throw new AlertConfigError(
          `${where} field "match.labels.${key}" must be a string, got ${JSON.stringify(value)}.`,
          "invalid-schema"
        );
      }
    }
    labels = labelsObj as Record<string, string>;
  }

  if (typeof obj.runbook !== "string" || obj.runbook.trim().length === 0) {
    throw new AlertConfigError(`${where} is missing a required non-empty "runbook" path string.`, "invalid-schema");
  }

  return {
    match: { alertname: match.alertname, labels },
    runbook: obj.runbook,
  };
}
