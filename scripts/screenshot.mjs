// Screenshot a hub page with headless Chromium over CDP, in light or dark mode, optionally evaluating a script
// first (its result is printed). Usage:
//   node scripts/screenshot.mjs <url> <out.png> [light|dark] [waitMs] [script]
// Example: node scripts/screenshot.mjs "http://proteins.localhost:4850/#/kb" kb.png dark 25000
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, out, scheme = "light", waitMs = "20000", script = ""] = process.argv.slice(2);
if (!url || !out) {
  console.error("usage: node scripts/screenshot.mjs <url> <out.png> [light|dark] [waitMs] [script]");
  process.exit(2);
}
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(
  process.env.CHROMIUM ?? "chromium",
  ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "rh-shot-"))}`, "about:blank"],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    } catch {
      await sleep(200);
    }
  }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 860, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  await sleep(Number(waitMs));
  if (script) console.log("eval:", JSON.stringify((await send("Runtime.evaluate", { expression: script, awaitPromise: true, returnByValue: true })).result?.result?.value));
  writeFileSync(out, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
  ws.close();
} finally {
  chrome.kill();
}
