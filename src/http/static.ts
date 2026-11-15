import { createReadStream, fstatSync, realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { closeSecureFile, openSecureFileRead } from "../tools/secure-fs";

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
    let root: string;
    try {
      root = realpathSync(requestedRoot);
    } catch {
      plain(response, 404, "UI build not found");
      return;
    }
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
    let descriptor: number | undefined;
    try {
      descriptor = openSecureFileRead(root, candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (request.method !== "GET" || assetRequest || code !== "ENOENT") {
        plain(response, 404, "Not Found");
        return;
      }
      candidate = resolve(root, "index.html");
      try {
        descriptor = openSecureFileRead(root, candidate);
      } catch {
        plain(response, 404, "Not Found");
        return;
      }
    }
    if (descriptor === undefined) {
      plain(response, 404, "Not Found");
      return;
    }
    const contentType = MIME_TYPES[extname(candidate).toLowerCase()];
    if (contentType === undefined) {
      closeSecureFile(descriptor);
      plain(response, 415, "Unsupported Media Type");
      return;
    }
    try {
      const size = fstatSync(descriptor).size;
      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": size,
        "Cache-Control": extname(candidate) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") {
        response.end();
      } else {
        const stream = createReadStream(candidate, { fd: descriptor, autoClose: true });
        descriptor = undefined;
        response.once("close", () => stream.destroy());
        stream.on("error", () => response.destroy()).pipe(response);
      }
    } finally {
      if (descriptor !== undefined) closeSecureFile(descriptor);
    }
  };
}
