export type ProcessToolErrorCode =
  | "invalid_request"
  | "cwd_invalid"
  | "executable_not_found"
  | "executable_changed"
  | "environment_denied"
  | "spawn_failed"
  | "cancelled"
  | "timeout"
  | "output_limit"
  | "termination_incomplete"
  | "invariant_violated";

export class ProcessToolError extends Error {
  public readonly code: ProcessToolErrorCode;
  public readonly details: Readonly<Record<string, string | number | boolean>>;

  public constructor(
    code: ProcessToolErrorCode,
    message: string,
    details: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(message);
    this.name = "ProcessToolError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
