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
    const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u.exec(apiOrigin);
    const port = match === null ? Number.NaN : Number(match[1]);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error("KESTREL_API_ORIGIN must match the printed http://127.0.0.1:<port> server origin");
    }
    proxyTarget = apiOrigin;
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
