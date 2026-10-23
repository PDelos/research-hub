// Preloaded into the knowledge-base viewer (Ignis) with `node --require`: every server it starts listens on
// 127.0.0.1 only, so the viewer is reachable solely through the hub's proxy. Ignis itself stays unmodified.
"use strict";
const net = require("node:net");
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (typeof args[0] === "number" || (typeof args[0] === "string" && /^\d+$/.test(args[0]))) {
    const port = Number(args[0]);
    const rest = args.slice(1).filter((a) => typeof a === "function" || (typeof a === "number" && false));
    const callback = args.find((a) => typeof a === "function");
    return listen.call(this, { port, host: "127.0.0.1" }, callback);
  }
  if (args[0] && typeof args[0] === "object" && !Array.isArray(args[0]) && "port" in args[0]) {
    return listen.call(this, { ...args[0], host: "127.0.0.1" }, ...args.slice(1));
  }
  return listen.apply(this, args);
};
