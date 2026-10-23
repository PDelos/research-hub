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
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status = 0,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RhError";
  }
}

export const isRhError = (e: unknown): e is RhError => e instanceof RhError;
