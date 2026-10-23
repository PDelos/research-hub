// Start and stop the whole server: hub + HTTP on one port. main.ts and the tests both use this.
import type { AddressInfo } from "node:net";
import { createHttpApp } from "./app.ts";
import type { Config } from "./config.ts";
import { DEFAULT_PROJECT, Hub, type HubOptions } from "./hub.ts";
import type { Logger } from "./logger.ts";

export interface Server {
  hub: Hub;
  url: string;
  port: number;
  stop(): Promise<void>;
}

export async function startServer(config: Config, log: Logger, options: HubOptions = {}): Promise<Server> {
  const hub = new Hub(config, log, options);
  // Open the default project at startup so a broken storage or model fails before we accept traffic.
  const project = await hub.project(DEFAULT_PROJECT);
  if (!project.check.fts5 || !project.check.vec)
    throw new Error(`SQLite self-check failed: fts5=${project.check.fts5} vec=${project.check.vec}`);
  const { http, streams } = createHttpApp(hub);
  const server = http.listen(config.port, config.host);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.keepAliveTimeout = 65_000;
  const port = (server.address() as AddressInfo).port;
  let stopping: Promise<void> | undefined;
  return {
    hub,
    port,
    url: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${port}`,
    stop() {
      stopping ??= (async () => {
        streams.closeAll();
        server.closeIdleConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await hub.close();
      })();
      return stopping;
    },
  };
}
