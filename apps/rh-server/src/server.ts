// Start and stop the whole server: data-directory ownership, the project, HTTP on one port.
// main.ts and the tests both use this.
import type { AddressInfo } from "node:net";
import { createHttpApp } from "./app.ts";
import type { Config } from "./config.ts";
import { Hub, type HubOptions } from "./hub.ts";
import type { Logger } from "./logger.ts";

export interface Server {
  hub: Hub;
  url: string;
  port: number;
  stop(): Promise<void>;
}

export class PortInUse extends Error {
  constructor(readonly port: number) {
    super(`port ${port} is in use; set RH_PUBLISH_PORT (compose) or RH_PORT to a free port`);
    this.name = "PortInUse";
  }
}

export async function startServer(config: Config, log: Logger, options: HubOptions = {}): Promise<Server> {
  const hub = new Hub(config, log, options);
  // Own the data directory and open the project before accepting traffic, so a broken storage or model fails early.
  const project = await hub.open();
  if (!project.check.fts5 || !project.check.vec) {
    await hub.close();
    throw new Error(`SQLite self-check failed: fts5=${project.check.fts5} vec=${project.check.vec}`);
  }
  const { http, streams } = createHttpApp(hub);
  const server = http.listen(config.port, config.host);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch (error) {
    await hub.close();
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw new PortInUse(config.port);
    throw error;
  }
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
