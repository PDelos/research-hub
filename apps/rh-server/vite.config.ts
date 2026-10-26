// The server bundle (design v1-1 D1): `vp pack` puts src/main.ts and everything it uses into dist/server.mjs, so
// the image needs no tsx and no node_modules beyond sqlite-vec (a native SQLite extension loaded from its package).
// pi-ai loads model providers lazily; the hub only configures OpenRouter (an OpenAI-compatible client) and the
// offline faux provider, so the other providers' SDKs are left out.
import { defineConfig } from "vite-plus";

const external = [/^sqlite-vec/, /^@anthropic-ai\//, /^@google\/genai/, /^@aws-sdk\//, /^@smithy\//, /^@mistralai\//];
const isExternal = (id: string) => external.some((re) => re.test(id));

export default defineConfig({
  pack: {
    entry: { server: "src/main.ts" },
    format: "esm",
    platform: "node",
    target: "node26",
    outDir: "dist",
    clean: true,
    dts: false,
    deps: {
      neverBundle: external,
      alwaysBundle: (id: string) => !isExternal(id),
      onlyBundle: false,
    },
  },
});
