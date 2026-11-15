import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  const apiOrigin = environment.KESTREL_API_ORIGIN;
  const uiRoot = dirname(fileURLToPath(import.meta.url));
  if (command === "serve" && (apiOrigin === undefined || apiOrigin.length === 0)) {
    throw new Error(
      "KESTREL_API_ORIGIN is required for ui:dev; set it to the loopback URL printed by the Kestrel API server",
    );
  }
  let proxyTarget: string | undefined;
  if (apiOrigin !== undefined && apiOrigin.length > 0) {
    const parsedApiOrigin = new URL(apiOrigin);
    if (
      parsedApiOrigin.protocol !== "http:" ||
      (parsedApiOrigin.hostname !== "127.0.0.1" && parsedApiOrigin.hostname !== "localhost") ||
      parsedApiOrigin.pathname !== "/" ||
      parsedApiOrigin.search.length > 0 ||
      parsedApiOrigin.hash.length > 0
    ) {
      throw new Error("KESTREL_API_ORIGIN must be an http://127.0.0.1:<port> loopback origin");
    }
    proxyTarget = parsedApiOrigin.origin;
  }

  return {
    root: resolve(uiRoot),
    plugins: [react()],
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
    server: {
      host: "127.0.0.1",
      ...(proxyTarget === undefined ? {} : { proxy: {
        "/api": {
          target: proxyTarget,
          changeOrigin: false,
        },
      } }),
    },
  };
});
