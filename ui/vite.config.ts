import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const apiOrigin = environment.KESTREL_API_ORIGIN ?? "http://127.0.0.1:4317";
  const uiRoot = dirname(fileURLToPath(import.meta.url));

  return {
    root: resolve(uiRoot),
    plugins: [react()],
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
    server: {
      host: "127.0.0.1",
      proxy: {
        "/api": {
          target: apiOrigin,
          changeOrigin: false,
        },
      },
    },
  };
});
