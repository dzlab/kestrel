import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  realpathSync,
  readSync,
  writeSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import { ToolExecutionError, ValidationError } from "../errors";
import { MAX_READ_BYTES, truncateUtf8 } from "./types";

const AT_FDCWD = -2;
const AT_REMOVEDIR = 0x0080;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const PATCH_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const native = dlopen("/usr/lib/libSystem.B.dylib", {
  openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  mkdirat: { args: [FFIType.i32, FFIType.cstring, FFIType.u16], returns: FFIType.i32 },
  renameat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring], returns: FFIType.i32 },
  unlinkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
  fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
  readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
  closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
  __error: { args: [], returns: FFIType.ptr },
  strerror: { args: [FFIType.i32], returns: FFIType.cstring },
});

const errnoNames: Record<number, string> = {
  1: "EPERM",
  2: "ENOENT",
  6: "ENXIO",
  13: "EACCES",
  17: "EEXIST",
  20: "ENOTDIR",
  21: "EISDIR",
  22: "EINVAL",
  28: "ENOSPC",
  62: "ELOOP",
  66: "ENOTEMPTY",
};

type NativeError = Error & { code?: string; errno?: number };
type DirectoryOpenError = NativeError & { created?: string[] };

const DIRENT_HEADER_BYTES = 21;
const DIRENT_MIN_RECORD_BYTES = 24;
const DIRENT_MAX_RECORD_BYTES = 1024; // Darwin DIRBLKSIZ-compatible bounded record size.
const DIRENT_MAX_NAME_BYTES = 255;

function errno(): number {
  const pointer = native.symbols.__error();
  if (pointer === null) throw new Error("could not read native errno");
  return new DataView(toArrayBuffer(pointer, 0, 4)).getInt32(0, true);
}

function nativeError(operation: string, path: string): NativeError {
  const number = errno();
  const name = errnoNames[number] ?? "ERRNO";
  const detail = native.symbols.strerror(number) ?? "native filesystem error";
  const error = new Error(`${operation} ${path}: ${name} (${detail})`) as NativeError;
  error.code = name;
  error.errno = number;
  return error;
}

function throwNative(operation: string, path: string): never {
  throw nativeError(operation, path);
}

function openAt(directoryFd: number, name: string, flags: number, mode = 0o600): number {
  const fd = native.symbols.openat(directoryFd, name, flags, mode);
  if (fd < 0) throwNative("open", name);
  return fd;
}

function closeFd(fd: number): void {
  closeSync(fd);
}

function rootPath(workspace: string): string {
  try {
    return realpathSync(workspace);
  } catch (error) {
    throw new ValidationError("workspace does not exist", { cause: error });
  }
}

function componentsFor(workspace: string, path: string): { root: string; components: string[] } {
  const root = rootPath(workspace);
  const candidate = resolve(path);
  const remainder = relative(root, candidate);
  if (remainder === "" || remainder === ".") return { root, components: [] };
  if (remainder === ".." || remainder.startsWith(`..${sep}`) || remainder.startsWith(sep)) {
    throw new ValidationError("path resolves outside workspace");
  }
  return { root, components: remainder.split(sep) };
}

function openRoot(root: string): number {
  const fd = openAt(AT_FDCWD, root, DIRECTORY_FLAGS, 0);
  try {
    if (!fstatSync(fd).isDirectory()) throw new ToolExecutionError("workspace is not a directory");
    if (realpathSync(`/dev/fd/${fd}`) !== root) {
      throw new ValidationError("workspace changed while opening");
    }
    return fd;
  } catch (error) {
    closeFd(fd);
    throw error;
  }
}

function openDirectory(workspace: string, path: string, create: boolean): { fd: number; created: string[] } {
  const { root, components } = componentsFor(workspace, path);
  let currentFd = openRoot(root);
  let currentPath = root;
  const created: string[] = [];
  try {
    for (const component of components) {
      let nextFd: number | null = null;
      try {
        let createdNow = false;
        try {
          nextFd = openAt(currentFd, component, DIRECTORY_FLAGS, 0);
        } catch (error) {
          if (!create || (error as NativeError).code !== "ENOENT") throw error;
          const made = native.symbols.mkdirat(currentFd, component, 0o755);
          createdNow = made >= 0;
          if (!createdNow && errnoNames[errno()] !== "EEXIST") throwNative("mkdir", component);
          if (createdNow) created.push(`${currentPath}${sep}${component}`);
          nextFd = openAt(currentFd, component, DIRECTORY_FLAGS, 0);
        }
        if (createdNow) fchmodSync(nextFd, 0o755);
        const previousFd = currentFd;
        currentFd = nextFd;
        nextFd = null;
        closeFd(previousFd);
        currentPath = `${currentPath}${sep}${component}`;
      } catch (error) {
        if (nextFd !== null) closeFd(nextFd);
        throw error;
      }
    }
    return { fd: currentFd, created };
  } catch (error) {
    closeFd(currentFd);
    (error as DirectoryOpenError).created = created;
    throw error;
  }
}

export type SecureEntryType = "file" | "directory" | "symlink" | "special";
export type SecureEntry = { name: string; type: SecureEntryType };

function directoryEntryType(value: number): SecureEntryType {
  if (value === 4) return "directory";
  if (value === 8) return "file";
  if (value === 10) return "symlink";
  return "special";
}

export type NativeDirentHeader = { recordLength: number; nameLength: number; type: number };

export function validateNativeDirentHeader(header: Uint8Array): NativeDirentHeader {
  if (header.byteLength < DIRENT_HEADER_BYTES) {
    throw new ToolExecutionError("directory contained an invalid entry");
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const recordLength = view.getUint16(16, true);
  const nameLength = view.getUint16(18, true);
  if (
    recordLength < DIRENT_MIN_RECORD_BYTES ||
    recordLength > DIRENT_MAX_RECORD_BYTES ||
    recordLength % 4 !== 0 ||
    nameLength === 0 ||
    nameLength > DIRENT_MAX_NAME_BYTES ||
    DIRENT_HEADER_BYTES + nameLength + 1 > recordLength
  ) {
    throw new ToolExecutionError("directory contained an invalid entry");
  }
  return { recordLength, nameLength, type: view.getUint8(20) };
}

export function safeDirectoryEntries(workspace: string, path: string): SecureEntry[] {
  const { fd } = openDirectory(workspace, path, false);
  const directory = native.symbols.fdopendir(fd);
  if (!directory) {
    closeFd(fd);
    throwNative("fdopendir", path);
  }
  const entries: SecureEntry[] = [];
  try {
    while (true) {
      const entry = native.symbols.readdir(directory);
      if (!entry) break;
      const header = new Uint8Array(toArrayBuffer(entry, 0, DIRENT_HEADER_BYTES));
      const { recordLength, nameLength, type } = validateNativeDirentHeader(header);
      const record = new Uint8Array(toArrayBuffer(entry, 0, recordLength));
      const nameBytes = record.subarray(DIRENT_HEADER_BYTES, DIRENT_HEADER_BYTES + nameLength);
      if (nameBytes.includes(0) || record[DIRENT_HEADER_BYTES + nameLength] !== 0) {
        throw new ToolExecutionError("directory contained an invalid entry");
      }
      const name = Buffer.from(nameBytes).toString("utf8");
      if (name !== "." && name !== "..") {
        entries.push({ name, type: directoryEntryType(type) });
      }
    }
  } finally {
    native.symbols.closedir(directory);
  }
  return entries;
}

function openFileAt(workspace: string, path: string, flags: number): number {
  const { root, components } = componentsFor(workspace, path);
  if (components.length === 0) throw new ToolExecutionError("path is not a regular file");
  const name = components.pop()!;
  const parentPath = components.length === 0 ? root : `${root}${sep}${components.join(sep)}`;
  const parent = openDirectory(workspace, parentPath, false);
  try {
    return openAt(parent.fd, name, flags, 0o666);
  } finally {
    closeFd(parent.fd);
  }
}

function requireRegular(fd: number, operation: string): void {
  if (!fstatSync(fd).isFile()) {
    throw new ToolExecutionError(`${operation} target is not a regular file`);
  }
}

export function readWorkspaceText(workspace: string, path: string): { content: string; truncated: boolean } {
  const fd = openFileAt(workspace, path, READ_FLAGS);
  try {
    requireRegular(fd, "read");
    const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
    const bytesRead = readSync(fd, buffer, 0, buffer.byteLength, 0);
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    return { content: truncateUtf8(content, MAX_READ_BYTES), truncated: bytesRead > MAX_READ_BYTES };
  } finally {
    closeFd(fd);
  }
}

export function workspacePathInfo(workspace: string, path: string): { isFile(): boolean; isDirectory(): boolean } {
  const { root, components } = componentsFor(workspace, path);
  const fd = components.length === 0 ? openRoot(root) : openFileAt(workspace, path, PATCH_READ_FLAGS);
  try {
    const info = fstatSync(fd);
    return { isFile: () => info.isFile(), isDirectory: () => info.isDirectory() };
  } finally {
    closeFd(fd);
  }
}

export function writeWorkspaceText(workspace: string, path: string, content: string): void {
  const { root, components } = componentsFor(workspace, path);
  if (components.length === 0) throw new ToolExecutionError("write target is not a regular file");
  const name = components.pop()!;
  const parentPath = components.length === 0 ? root : `${root}${sep}${components.join(sep)}`;
  const parent = openDirectory(workspace, parentPath, true);
  let fd: number | null = null;
  try {
    let created = false;
    try {
      fd = openAt(parent.fd, name, CREATE_FLAGS, 0o666);
      created = true;
    } catch (error) {
      if ((error as NativeError).code !== "EEXIST") throw error;
      fd = openAt(parent.fd, name, WRITE_FLAGS, 0o666);
    }
    if (created) fchmodSync(fd, 0o666);
    requireRegular(fd, "write");
    const bytes = Buffer.from(content, "utf8");
    ftruncateSync(fd, 0);
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
    fsyncSync(fd);
  } finally {
    if (fd !== null) closeFd(fd);
    closeFd(parent.fd);
  }
}

export type SecureParent = { fd: number; name: string; created: string[] };

export function openSecureParent(workspace: string, path: string, create: boolean): SecureParent {
  const { root, components } = componentsFor(workspace, path);
  if (components.length === 0) throw new ToolExecutionError("path has no parent file name");
  const name = components.pop()!;
  const parentPath = components.length === 0 ? root : `${root}${sep}${components.join(sep)}`;
  const parent = openDirectory(workspace, parentPath, create);
  return { fd: parent.fd, name, created: parent.created };
}

export function closeSecureParent(parent: SecureParent): void {
  closeFd(parent.fd);
}

export function openPatchTarget(parent: SecureParent): number | null {
  try {
    const fd = openAt(parent.fd, parent.name, PATCH_READ_FLAGS, 0);
    try {
      requireRegular(fd, "patch");
      return fd;
    } catch (error) {
      closeFd(fd);
      throw error;
    }
  } catch (error) {
    if ((error as NativeError).code === "ENOENT") return null;
    if ((error as NativeError).code === "ELOOP") throw new ToolExecutionError("patch target contains a symlink");
    throw error;
  }
}

export function closeSecureFile(fd: number): void {
  closeFd(fd);
}

export function createPatchTemp(parent: SecureParent, name: string, content: string): void {
  let fd: number | null = null;
  try {
    fd = openAt(parent.fd, name, CREATE_FLAGS, 0o600);
    fchmodSync(fd, 0o600);
    requireRegular(fd, "patch temporary");
    const bytes = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
    fsyncSync(fd);
  } catch (error) {
    try {
      native.symbols.unlinkat(parent.fd, name, 0);
    } catch {
      // Preserve the original staging failure.
    }
    throw error;
  } finally {
    if (fd !== null) closeFd(fd);
  }
}

function callAt(operation: string, result: number, path: string): void {
  if (result < 0) throwNative(operation, path);
}

export function renameAt(parent: SecureParent, from: string, to: string): void {
  callAt("rename", native.symbols.renameat(parent.fd, from, parent.fd, to), `${from} -> ${to}`);
}

export function unlinkAt(parent: SecureParent, name: string, directory = false): void {
  callAt("unlink", native.symbols.unlinkat(parent.fd, name, directory ? AT_REMOVEDIR : 0), name);
}
