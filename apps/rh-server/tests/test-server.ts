// Test harness: a real server on a random port with a temp data dir, offline by default, logs captured in memory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubClient } from "@rh/sdk";
import { loadConfig } from "../src/config.ts";
import type { HubOptions } from "../src/hub.ts";
import { createLogger } from "../src/logger.ts";
import { startServer, type Server } from "../src/server.ts";

export const TOKEN = "test-api-token-0123456789";

export function tempDir(prefix = "rh-srv-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface TestServer extends Server {
  client: HubClient;
  logs: string[];
  dataDir: string;
}

export async function startTestServer(
  options: { env?: Record<string, string>; hub?: HubOptions; dataDir?: string } = {},
): Promise<TestServer> {
  const dataDir = options.dataDir ?? tempDir().dir;
  const config = loadConfig({
    RH_MODE: "offline",
    RH_PORT: "4850",
    RH_DATA_DIR: dataDir,
    RH_API_TOKEN: TOKEN,
    RH_UI_DIR: join(dataDir, "no-ui"),
    ...options.env,
  } as NodeJS.ProcessEnv);
  config.port = 0;
  const logs: string[] = [];
  const log = createLogger({
    level: "debug",
    write: (l) => logs.push(l),
    secrets: [TOKEN, options.env?.OPENROUTER_API_KEY ?? ""],
    bindings: { project: config.projectName },
  });
  const server = await startServer(config, log, options.hub);
  const client = new HubClient({ base: `${server.url}/v1`, token: TOKEN });
  return {
    ...server,
    client,
    logs,
    dataDir,
    async stop() {
      await server.stop();
      // Telemetry projection errors are caught and only logged; never let one pass silently in a test.
      const failed = logs.filter((l) => l.includes("telemetry.project_failed"));
      if (failed.length) throw new Error(`telemetry projection failed:\n${failed.join("\n")}`);
    },
  };
}

export const until = async (check: () => boolean | Promise<boolean>, ms = 10_000, label = "condition") => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
