// Usage: tsx check-plugin-jev.ts: the Jev lock check across every built-in plugin's contributed commands.
import { checkJevAcrossPlugins } from "../src/kernel/contributions.ts";
import { discover } from "../src/kernel/registry.ts";

const discovery = discover({});
for (const invalid of discovery.invalid) console.error(`plugin ${invalid.dir}: ${invalid.problems.join("; ")}`);
const problems = checkJevAcrossPlugins(discovery);
for (const p of problems) console.error(`jev lock: ${p}`);
if (problems.length || discovery.invalid.length) process.exit(1);
console.log(`plugin jev ok (${discovery.plugins.size} built-in plugins)`);
