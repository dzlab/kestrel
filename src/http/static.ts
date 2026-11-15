import { createReadStream, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function plain(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(message),
    "X-Content-Type-Options": "nosniff",
  });
  response.end(message);
}

export function createStaticHandler(buildDirectory: string) {
  const requestedRoot = resolve(buildDirectory);

  return function serveStatic(request: IncomingMessage, response: ServerResponse, pathname: string): void {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      plain(response, 405, "Method Not Allowed");
      return;
    }
    if (!existsSync(requestedRoot) || lstatSync(requestedRoot).isSymbolicLink()) {
      plain(response, 404, "UI build not found");
      return;
    }

    const root = realpathSync(requestedRoot);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      plain(response, 400, "Invalid path");
      return;
    }
    if (decoded.includes("\0") || decoded.split("/").includes("..")) {
      plain(response, 404, "Not Found");
      return;
    }

    const requestedPath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    let candidate = resolve(root, requestedPath);
    if (!isWithin(root, candidate)) {
      plain(response, 404, "Not Found");
      return;
    }
    const assetRequest = extname(requestedPath).length > 0;
    if (!existsSync(candidate) && !assetRequest) candidate = resolve(root, "index.html");
    if (!existsSync(candidate)) {
      plain(response, 404, "Not Found");
      return;
    }

    const entry = lstatSync(candidate);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      plain(response, 404, "Not Found");
      return;
    }
    const canonical = realpathSync(candidate);
    if (!isWithin(root, canonical)) {
      plain(response, 404, "Not Found");
      return;
    }
    const contentType = MIME_TYPES[extname(canonical).toLowerCase()];
    if (contentType === undefined) {
      plain(response, 415, "Unsupported Media Type");
      return;
    }
    const size = statSync(canonical).size;
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": size,
      "Cache-Control": extname(canonical) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(canonical).on("error", () => response.destroy()).pipe(response);
  };
}
