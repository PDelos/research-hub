export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "busy"
  | "conflict"
  | "unavailable"
  | "internal"
  | "offline";

/** Every client-side failure: `offline` when the server can't be reached, otherwise the server's error code. */
export class RhError extends Error {
  /** Extra detail some errors carry (the problems of a refused install, the dependents of a plugin). */
  readonly details?: unknown;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status = 0,
    options?: { cause?: unknown; details?: unknown },
  ) {
    super(message, options);
    this.details = options?.details;
    this.name = "RhError";
  }
}

export const isRhError = (e: unknown): e is RhError => e instanceof RhError;
