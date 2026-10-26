// rh-server entry: load .env if present, read configuration (fail closed), start, and stop cleanly on signals.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError, loadConfig, secretsOf } from "./config.ts";
import { REPO_ROOT } from "./paths.ts";
import { createLogger } from "./logger.ts";
import { DataDirOwned } from "./owner.ts";
import { PortInUse, startServer, type Server } from "./server.ts";
import { packageVersion, VERSION } from "./version.ts";

const envFile = process.env.RH_ENV_FILE ?? resolve(REPO_ROOT, ".env");
if (envFile !== "none" && existsSync(envFile)) process.loadEnvFile(envFile);

let config;
try {
  config = loadConfig();
} catch (error) {
  const variable = error instanceof ConfigError ? error.variable : undefined;
  createLogger().error("config.invalid", { variable, error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
const log = createLogger({
  level: config.logLevel,
  secrets: secretsOf(config),
  bindings: { project: config.projectName },
});
process.on("unhandledRejection", (reason) => log.error("process.unhandled_rejection", { error: reason }));
if (config.generatedTokens.length)
  log.warn("config.generated_tokens", {
    variables: config.generatedTokens,
    note: "random per process; set them in .env to call the API from outside the UI",
  });
if (!config.papers.contactEmail)
  log.warn("config.contact_email_missing", {
    note: "set CONTACT_EMAIL so OpenAlex and Europe PMC requests use their polite pools; searches still work without it",
  });

let server: Server;
try {
  server = await startServer(config, log);
} catch (error) {
  if (error instanceof DataDirOwned) {
    log.error("startup.data_dir_owned", { dataDir: error.dir, owner: error.owner, message: error.message });
    process.exit(1);
  }
  if (error instanceof PortInUse) {
    log.error("startup.port_in_use", { port: error.port, message: error.message });
    process.exit(1);
  }
  throw error;
}
log.info("server.listening", {
  url: server.url,
  version: VERSION,
  mode: config.mode,
  providers: server.hub.providers,
  models: server.hub.catalog.jobs,
  piDurable: packageVersion("@earendil-works/pi-durable"),
  dataDir: config.dataDir,
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("server.stopping", { signal });
  await server.stop();
  log.info("server.stopped", { signal });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
