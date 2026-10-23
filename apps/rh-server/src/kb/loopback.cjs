// Preloaded into the knowledge-base viewer (Ignis) with `node --require`: every server it starts listens on
// 127.0.0.1 only, so the viewer is reachable solely through the hub's proxy. Ignis itself stays unmodified.
"use strict";
const net = require("node:net");
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const first = args[0];
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    const callback = args.find((a) => typeof a === "function");
    return listen.call(this, { port: Number(first), host: "127.0.0.1" }, callback);
  }
  if (first && typeof first === "object" && !Array.isArray(first) && "port" in first)
    return listen.call(this, { ...first, host: "127.0.0.1" }, ...args.slice(1));
  return listen.apply(this, args);
};
