import { fstatSync, readSync } from "node:fs";
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

function hasExpectedSignature(buffer: Buffer, contentType: string): boolean {
  if (contentType === "image/png") return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === "image/jpeg") return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (contentType === "image/gif") return buffer.length >= 6 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a");
  return buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

function readImageSnapshot(descriptor: number): Buffer {
  const buffer = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_IMAGE_BYTES) throw new ValidationError("workspace image exceeds the size limit");
  return buffer.subarray(0, offset);
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
    const snapshot = readImageSnapshot(descriptor);
    if (!hasExpectedSignature(snapshot, contentType)) throw new ValidationError("workspace image content is invalid");
    closeSecureFile(descriptor);
    descriptor = undefined;
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": snapshot.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(snapshot);
  } catch (error) {
    if (descriptor !== undefined) closeSecureFile(descriptor);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    throw new ValidationError("workspace image is unavailable", { cause: error });
  }
}
