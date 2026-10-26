// The plugin host process (spec plugin-system: Isolation of external code; design D6). One per external plugin,
// started by the kernel with Node's permission model: no network (requests go through rh.http, which checks the
// declared hosts), no child processes or workers, reads only its own folder and storage, writes only its storage,
// and an environment without secrets. The kernel and this process call each other over the IPC channel; functions
// in arguments and results travel as handles, so handlers, sources and disposables work across the boundary.
// Plain JavaScript: it runs before any loader, under the permission model.
import { pathToFileURL } from "node:url";

const local = new Map(); // handle → function in this process
let nextHandle = 1;
const pending = new Map(); // call id → { resolve, reject }
let nextCall = 1;
let plugin;

function encode(value) {
  if (typeof value === "function") {
    const handle = nextHandle++;
    local.set(handle, value);
    return { $fn: handle };
  }
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = encode(v);
    return out;
  }
  return value;
}

function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if (typeof value.$fn === "number" || typeof value.$fn === "string") return (...args) => call(value.$fn, args);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decode(v);
    return out;
  }
  return value;
}

function call(fn, args) {
  const id = nextCall++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send({ t: "call", id, fn, args: encode(args) });
  });
}

/** The rh API as seen from a plugin process: every call is asynchronous and checked by the kernel. */
function rhProxy(paths) {
  const rh = {};
  for (const path of paths) {
    const parts = path.split(".");
    let node = rh;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)] = (...args) => call(`rh.${path}`, args);
  }
  return rh;
}

const own = {
  async activate(context) {
    const module = await import(pathToFileURL(context.main).href);
    plugin = module;
    const ctx = {
      ...context,
      rh: rhProxy(context.rhPaths),
      subscriptions: [],
      exports: {},
      onSettingsChange: (handler) => call("ctx.onSettingsChange", [handler]),
      log: {
        info: (event, fields) => call("ctx.log", ["info", event, fields]),
        warn: (event, fields) => call("ctx.log", ["warn", event, fields]),
      },
    };
    own.context = ctx;
    return module.activate ? await module.activate(ctx) : undefined;
  },
  async deactivate() {
    try {
      await plugin?.deactivate?.();
    } finally {
      for (const s of (own.context?.subscriptions ?? []).splice(0).toReversed()) await s?.dispose?.();
    }
  },
};

process.on("message", async (message) => {
  if (message.t === "reply") {
    const waiting = pending.get(message.id);
    pending.delete(message.id);
    if (!waiting) return;
    if (message.error) waiting.reject(Object.assign(new Error(message.error.message), { name: message.error.name }));
    else waiting.resolve(decode(message.value));
    return;
  }
  if (message.t !== "call") return;
  const fn = typeof message.fn === "number" ? local.get(message.fn) : own[message.fn];
  try {
    if (typeof fn !== "function") throw new Error(`unknown function ${message.fn}`);
    const value = await fn(...decode(message.args));
    process.send({ t: "reply", id: message.id, value: encode(value) });
  } catch (error) {
    process.send({
      t: "reply",
      id: message.id,
      error: { name: error?.name ?? "Error", message: error?.message ?? String(error) },
    });
  }
});
process.send({ t: "ready" });
