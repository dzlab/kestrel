import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationService } from "../conversations/service";
import type { StoreRepository } from "../store/repository";
import { createHttpAuth } from "./auth";
import { createApiRouter, sendApiError } from "./router";
import { createStaticHandler } from "./static";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_UI_BUILD = resolve(dirname(fileURLToPath(import.meta.url)), "../../ui/dist");

export type StartKestrelHttpServerOptions = {
  repository: StoreRepository;
  conversations: ConversationService;
  workspace: string;
  port?: number;
  uiBuildDirectory?: string;
};

export type KestrelHttpServer = {
  listen: Readonly<{ host: typeof LOOPBACK_HOST; port: number }>;
  url: string;
  close(): Promise<void>;
};

export async function startKestrelHttpServer(
  options: StartKestrelHttpServerOptions,
): Promise<KestrelHttpServer> {
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("HTTP server port must be an integer between 0 and 65535");
  }
  if (typeof options.workspace !== "string" || options.workspace.trim().length === 0) {
    throw new TypeError("HTTP server workspace must be a non-empty path");
  }

  const auth = createHttpAuth();
  const routeApi = createApiRouter({
    repository: options.repository,
    conversations: options.conversations,
    workspace: options.workspace,
    auth,
  });
  const serveStatic = createStaticHandler(options.uiBuildDirectory ?? DEFAULT_UI_BUILD);
  const server = createServer((request, response) => {
    void (async () => {
      const requestTarget = request.url ?? "/";
      if (!requestTarget.startsWith("/") || requestTarget.startsWith("//")) {
        sendApiError(response, new TypeError("invalid request target"));
        return;
      }
      let url: URL;
      try {
        url = new URL(requestTarget, "http://127.0.0.1");
      } catch (error) {
        sendApiError(response, error);
        return;
      }
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        try {
          await routeApi(request, response, url);
        } catch (error) {
          sendApiError(response, error);
        }
        return;
      }
      serveStatic(request, response, requestTarget.split("?", 1)[0]!);
    })().catch((error: unknown) => sendApiError(response, error));
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, LOOPBACK_HOST);
  });

  const address = server.address() as AddressInfo;
  let closePromise: Promise<void> | undefined;
  return {
    listen: Object.freeze({ host: LOOPBACK_HOST, port: address.port }),
    url: `http://${LOOPBACK_HOST}:${address.port}`,
    close() {
      closePromise ??= new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error === undefined) resolveClose();
          else rejectClose(error);
        });
        for (const socket of sockets) socket.destroy();
      });
      return closePromise;
    },
  };
}
