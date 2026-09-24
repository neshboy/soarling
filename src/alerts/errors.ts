export type AlertErrorCode = "malformed-json" | "malformed-yaml" | "invalid-schema";

/** Thrown for every rejected Alertmanager payload or bindings file. */
export class AlertConfigError extends Error {
  readonly code: AlertErrorCode;

  constructor(message: string, code: AlertErrorCode) {
    super(message);
    this.name = "AlertConfigError";
    this.code = code;
  }
}
