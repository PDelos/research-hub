// Usage: tsx check-lock.ts <commands dir> [--update]
import { checkLock, readLock, writeLock } from "../src/lock.ts";

const [dir, flag] = process.argv.slice(2);
if (!dir) {
  console.error("usage: check-lock.ts <commands dir> [--update]");
  process.exit(2);
}
if (flag === "--update") {
  const lock = writeLock(dir);
  console.log(`commands.lock.json updated: ${Object.keys(lock).length} commands`);
} else {
  const problems = checkLock(dir, readLock(dir));
  if (problems.length) {
    for (const p of problems) console.error(`jev lock: ${p}`);
    process.exit(1);
  }
  console.log("jev lock ok");
}
