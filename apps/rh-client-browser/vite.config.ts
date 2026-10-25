import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite-plus";

// `npm run dev` proxies the API to a running rh-server on 4850; production builds are served by rh-server itself.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue()],
  server: {
    host: "127.0.0.1",
    proxy: { "/ui": "http://127.0.0.1:4850" },
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
