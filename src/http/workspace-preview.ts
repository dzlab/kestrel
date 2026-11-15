import { createReadStream, fstatSync, readSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, isAbsolute } from "node:path";
import { ValidationError } from "../errors";
import { resolveWorkspacePath } from "../tools/filesystem";
import { closeSecureFile, openSecureFileRead } from "../tools/secure-fs";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function hasExpectedSignature(descriptor: number, contentType: string): boolean {
  const buffer = Buffer.alloc(12);
  const length = readSync(descriptor, buffer, 0, buffer.length, 0);
  if (contentType === "image/png") return length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === "image/jpeg") return length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (contentType === "image/gif") return length >= 6 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a");
  return length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

export function serveWorkspaceImage(response: ServerResponse, workspace: string, requestedPath: string): void {
  let descriptor: number | undefined;
  try {
    if (isAbsolute(requestedPath)) throw new ValidationError("workspace image path must be relative");
    const path = resolveWorkspacePath(workspace, requestedPath);
    const contentType = IMAGE_TYPES[extname(path).toLowerCase()];
    if (contentType === undefined) throw new ValidationError("workspace image type is not supported");
    descriptor = openSecureFileRead(workspace, path);
    const entry = fstatSync(descriptor);
    if (!entry.isFile()) throw new ValidationError("workspace image is not a regular file");
    if (entry.size > MAX_IMAGE_BYTES) throw new ValidationError("workspace image exceeds the size limit");
    if (!hasExpectedSignature(descriptor, contentType)) throw new ValidationError("workspace image content is invalid");
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": entry.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    const stream = createReadStream(path, { fd: descriptor, autoClose: true });
    descriptor = undefined;
    response.once("close", () => stream.destroy());
    stream.on("error", () => response.destroy()).pipe(response);
  } catch (error) {
    if (descriptor !== undefined) closeSecureFile(descriptor);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    throw new ValidationError("workspace image is unavailable", { cause: error });
  }
}
