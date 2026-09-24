export type RunbookErrorCode =
  | "malformed-yaml"
  | "invalid-schema"
  | "unsupported-version"
  | "dangling-reference"
  | "duplicate-id";

/**
 * Thrown by parseRunbook for every rejection. Callers (CLI, tests) get a
 * single error type with a machine-readable `code` and a message that
 * already names the offending field/step - never a swallowed exception and
 * never a raw YAML-library or type-cast error escaping to the user.
 */
export class RunbookValidationError extends Error {
  readonly code: RunbookErrorCode;

  constructor(message: string, code: RunbookErrorCode) {
    super(message);
    this.name = "RunbookValidationError";
    this.code = code;
  }
}
