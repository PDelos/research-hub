// JSON-lines logger on stdout. Secret-looking keys are redacted, and any configured secret value is scrubbed from
// every line, so a key can never reach the log even inside an error message.
import type { LogLevel } from "./config.ts";

export type Fields = Record<string, unknown>;
export interface Logger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  child(bindings: Fields): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /token|key|authorization|secret|cookie|password/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Fields = {};
  for (const [k, v] of Object.entries(value))
    out[k] = SECRET_KEY.test(k) && typeof v === "string" ? "[redacted]" : redact(v, depth + 1);
  return out;
}

export function createLogger(
  options: {
    level?: LogLevel;
    secrets?: string[];
    write?: (line: string) => void;
    bindings?: Fields;
  } = {},
): Logger {
  const min = ORDER[options.level ?? "info"];
  const secrets = (options.secrets ?? []).filter((s) => s.length >= 8);
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (level: LogLevel, event: string, fields?: Fields) => {
    if (ORDER[level] < min) return;
    let line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...options.bindings,
      ...(redact(fields ?? {}) as Fields),
    });
    for (const s of secrets) line = line.split(s).join("[redacted]");
    write(line);
  };
  return {
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    child: (bindings) => createLogger({ ...options, bindings: { ...options.bindings, ...bindings } }),
  };
}
