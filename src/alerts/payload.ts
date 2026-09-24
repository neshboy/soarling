import { AlertConfigError } from "./errors.js";
import type { AlertmanagerAlert, AlertmanagerPayload, AlertStatus } from "./types.js";

const STATUSES = new Set<AlertStatus>(["firing", "resolved"]);

export interface ParsePayloadOptions {
  source?: string;
}

/**
 * Parses and validates a real Alertmanager webhook JSON payload. Rejects
 * anything that doesn't match the documented shape with a clear error
 * naming the offending field, rather than letting a `TypeError` from a
 * missing/mistyped field escape later during matching.
 */
export function parseAlertmanagerPayload(text: string, options: ParsePayloadOptions = {}): AlertmanagerPayload {
  const label = options.source ? ` in ${options.source}` : "";

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AlertConfigError(`Could not parse JSON${label}: ${(err as Error).message}`, "malformed-json");
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AlertConfigError(`Alertmanager payload${label} must be a JSON object at the top level.`, "invalid-schema");
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.version !== "string") {
    throw new AlertConfigError(`Alertmanager payload${label} is missing a required string "version" field.`, "invalid-schema");
  }
  if (typeof obj.status !== "string" || !STATUSES.has(obj.status as AlertStatus)) {
    throw new AlertConfigError(
      `Alertmanager payload${label} has an invalid top-level "status" (${JSON.stringify(obj.status)}); expected "firing" or "resolved".`,
      "invalid-schema"
    );
  }
  if (typeof obj.receiver !== "string") {
    throw new AlertConfigError(`Alertmanager payload${label} is missing a required string "receiver" field.`, "invalid-schema");
  }
  if (!Array.isArray(obj.alerts) || obj.alerts.length === 0) {
    throw new AlertConfigError(`Alertmanager payload${label} is missing a required non-empty "alerts" list.`, "invalid-schema");
  }

  const alerts = obj.alerts.map((entry, index) => parseAlert(entry, index, label));

  return {
    version: obj.version,
    groupKey: typeof obj.groupKey === "string" ? obj.groupKey : "",
    status: obj.status as AlertStatus,
    receiver: obj.receiver,
    groupLabels: parseStringRecord(obj.groupLabels, "groupLabels", label),
    commonLabels: parseStringRecord(obj.commonLabels, "commonLabels", label),
    commonAnnotations: parseStringRecord(obj.commonAnnotations, "commonAnnotations", label),
    externalURL: typeof obj.externalURL === "string" ? obj.externalURL : "",
    alerts,
  };
}

function parseAlert(entry: unknown, index: number, label: string): AlertmanagerAlert {
  const where = `alerts[${index}]${label}`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new AlertConfigError(`${where} must be a JSON object.`, "invalid-schema");
  }
  const obj = entry as Record<string, unknown>;

  if (typeof obj.status !== "string" || !STATUSES.has(obj.status as AlertStatus)) {
    throw new AlertConfigError(
      `${where} has an invalid "status" (${JSON.stringify(obj.status)}); expected "firing" or "resolved".`,
      "invalid-schema"
    );
  }
  const labels = parseStringRecord(obj.labels, "labels", label, where);
  if (typeof labels.alertname !== "string" || labels.alertname.trim().length === 0) {
    throw new AlertConfigError(`${where} is missing a required "labels.alertname" string.`, "invalid-schema");
  }

  return {
    status: obj.status as AlertStatus,
    labels,
    annotations: parseStringRecord(obj.annotations, "annotations", label, where),
    startsAt: typeof obj.startsAt === "string" ? obj.startsAt : "",
    endsAt: typeof obj.endsAt === "string" ? obj.endsAt : "",
    generatorURL: typeof obj.generatorURL === "string" ? obj.generatorURL : "",
    fingerprint: typeof obj.fingerprint === "string" ? obj.fingerprint : undefined,
  };
}

function parseStringRecord(value: unknown, field: string, label: string, where?: string): Record<string, string> {
  if (value === undefined) return {};
  const context = where ?? `Alertmanager payload${label}`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AlertConfigError(`${context} field "${field}" must be an object of string values.`, "invalid-schema");
  }
  const obj = value as Record<string, unknown>;
  for (const [key, v] of Object.entries(obj)) {
    if (typeof v !== "string") {
      throw new AlertConfigError(`${context} field "${field}.${key}" must be a string, got ${JSON.stringify(v)}.`, "invalid-schema");
    }
  }
  return obj as Record<string, string>;
}
