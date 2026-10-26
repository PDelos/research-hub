// Every environment variable the code reads must be documented in .env.example.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const documented = new Set(
  readFileSync(join(root, ".env.example"), "utf8")
    .split("\n")
    .map((l) => l.match(/^#?\s*([A-Z][A-Z0-9_]+)=/)?.[1])
    .filter(Boolean),
);
// Variables set by tooling rather than by the user (E2E_PORT, CHROMIUM: the Playwright UI tests).
const ignored = new Set([
  "NODE_ENV",
  "NODE_TEST_CONTEXT",
  "HOME",
  "PATH",
  "JEV_BACKEND",
  "JEV_LIVE",
  "E2E_PORT",
  "CHROMIUM",
]);

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", "tests", "fe"].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|mjs|js)$/.test(name)) files.push(path);
  }
};
for (const dir of ["packages", "apps"]) walk(join(root, dir));

const missing = new Map();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]+)|env\[["']([A-Z][A-Z0-9_]+)["']\]|["'](RH_[A-Z0-9_]+)["']/g)) {
    const name = m[1] ?? m[2] ?? m[3];
    if (!documented.has(name) && !ignored.has(name)) missing.set(name, file.replace(root, ""));
  }
}
if (missing.size) {
  for (const [name, file] of missing) console.error(`undocumented env var ${name} (read in ${file})`);
  process.exit(1);
}
console.log(`env check ok: ${files.length} files, ${documented.size} documented variables`);
