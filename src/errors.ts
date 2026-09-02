/**
 * An error whose message is intended for the user and needs no stack trace.
 * The CLI prints these plainly and exits with `exitCode`.
 */
export class UserFacingError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "UserFacingError";
    this.exitCode = exitCode;
  }
}

/** Raised when validation fails; `validate` exits 2 so scripts can branch. */
export class ValidationFailedError extends UserFacingError {
  constructor(message: string) {
    super(message, 2);
    this.name = "ValidationFailedError";
  }
}
