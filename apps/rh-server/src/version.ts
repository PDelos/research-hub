import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

export const VERSION: string = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../package.json"), "utf8"),
).version;

export function packageVersion(name: string): string {
  try {
    return (require(`${name}/package.json`) as { version: string }).version;
  } catch {
    return "unknown";
  }
}
