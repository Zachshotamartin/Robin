export type GitToolErrorCode =
  | "invalid_request"
  | "executable_not_found"
  | "not_repository"
  | "unsafe_repository"
  | "git_failed"
  | "timeout"
  | "cancelled"
  | "output_limit"
  | "parse_failed"
  | "repository_changed"
  | "invariant_violated";

export class GitToolError extends Error {
  public readonly code: GitToolErrorCode;
  public readonly details: Readonly<Record<string, string | number | boolean>>;

  public constructor(
    code: GitToolErrorCode,
    message: string,
    details: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(message);
    this.name = "GitToolError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
