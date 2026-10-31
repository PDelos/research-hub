// The error envelope {error: {code, message}} with one status per code. Adapted from disler/pi-durable-news-agent.
import type { ErrorRequestHandler } from "express";
import { ConversationBusy } from "@earendil-works/pi-durable";
import type { Logger } from "./logger.ts";

export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "busy"
  | "conflict"
  | "feature_off"
  | "unavailable"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  busy: 409,
  conflict: 409,
  feature_off: 409,
  unavailable: 503,
  internal: 500,
};

export class ApiFault extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Sent as error.details (the problems of a refused install, the dependents of a plugin). */
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export const invalid = (message: string) => new ApiFault("invalid", message);
export const notFound = (message: string) => new ApiFault("not_found", message);

export function errorMiddleware(log: Logger): ErrorRequestHandler {
  return (error, request, response, _next) => {
    let fault: ApiFault;
    if (error instanceof ApiFault) fault = error;
    else if (error instanceof ConversationBusy) fault = new ApiFault("busy", "The agent is busy");
    else if (error?.type === "entity.parse.failed") fault = invalid("Body must be valid JSON");
    else if (error?.type === "entity.too.large") fault = invalid("Body too large");
    else {
      log.error("http.error", {
        method: request.method,
        path: request.path,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      fault = new ApiFault("internal", "Internal error");
    }
    if (response.headersSent) return void response.end();
    response.status(fault.status).json({
      error: {
        code: fault.code,
        message: fault.message,
        ...(fault.details === undefined ? {} : { details: fault.details }),
      },
    });
  };
}

export function int(value: unknown, name: string, fallback?: number): number {
  if ((value === undefined || value === "") && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw invalid(`${name} must be a whole number`);
  return parsed;
}

export const optInt = (value: unknown, name: string): number | undefined =>
  value === undefined || value === "" ? undefined : int(value, name);
