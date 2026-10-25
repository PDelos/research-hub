// A server process for crash tests: offline, slow faux model, prints its URL as the first stdout line.
//   server-host.ts <dataDir> <port>
import { loadConfig } from "../../src/config.ts";
import { createLogger } from "../../src/logger.ts";
import { startServer } from "../../src/server.ts";

const [dataDir, port] = process.argv.slice(2);
const config = loadConfig({
  RH_MODE: "offline",
  RH_DATA_DIR: dataDir,
  RH_PORT: port,
  RH_API_TOKEN: "test-api-token-0123456789",
} as NodeJS.ProcessEnv);
const server = await startServer(
  config,
  createLogger({ level: "warn", write: (l) => process.stderr.write(`${l}\n`) }),
  {
    fauxTokensPerSecond: Number(process.env.FAUX_TPS ?? 2000),
  },
);
process.stdout.write(`${server.url}\n`);
process.on("SIGTERM", () => void server.stop().then(() => process.exit(0)));
