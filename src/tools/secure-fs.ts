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
import { toArrayBuffer } from "bun:ffi";
import { ToolExecutionError, ValidationError } from "../errors";
import { getNativeFs, type NativeFs } from "./native-fs";
import { MAX_READ_BYTES, truncateUtf8 } from "./types";

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const PATCH_CREATE_FLAGS = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const PATCH_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

type NativeError = Error & { code?: string; errno?: number };
type DirectoryOpenError = NativeError & { created?: SecureCreatedDirectory[] };

let nativeFs: NativeFs | undefined;

function getSecureNativeFs(): NativeFs {
  nativeFs ??= getNativeFs();
  return nativeFs;
}

function errno(): number {
  return getSecureNativeFs().errno();
}

function nativeError(operation: string, path: string, errorNumber = errno()): NativeError {
  const number = errorNumber;
  const native = getSecureNativeFs();
  const name = native.errnoNames[number] ?? "ERRNO";
  const detail = native.symbols.strerror(number) ?? "native filesystem error";
  const error = new Error(`${operation} ${path}: ${name} (${detail})`) as NativeError;
  error.code = name;
  error.errno = number;
  return error;
}

function throwNative(operation: string, path: string): never {
  throw nativeError(operation, path);
}

function setErrno(value: number): void {
  const pointer = getSecureNativeFs().symbols.errnoPointer();
  if (pointer === null) throw new Error("could not access native errno");
  new DataView(toArrayBuffer(pointer, 0, 4)).setInt32(0, value, true);
}

function openAt(directoryFd: number, name: string, flags: number, mode = 0o600): number {
  const fd = getSecureNativeFs().symbols.openat(directoryFd, name, flags, mode);
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
  const fd = openAt(getSecureNativeFs().constants.atFdcwd, root, DIRECTORY_FLAGS, 0);
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

export type SecureIdentity = { dev: bigint; ino: bigint };

export type SecureCreatedDirectory = { path: string; identity: SecureIdentity };

export type SecureDirectory = {
  fd: number;
  path: string;
  identity: SecureIdentity;
};

export function secureFileIdentity(fd: number): SecureIdentity {
  const stat = fstatSync(fd, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}

export function sameSecureIdentity(left: SecureIdentity | null, right: SecureIdentity | null): boolean {
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}

export function openSecureDirectoryPath(workspace: string, path: string): SecureDirectory {
  const opened = openDirectory(workspace, path, false);
  return {
    fd: opened.fd,
    path: resolve(path),
    identity: secureFileIdentity(opened.fd),
  };
}

export function closeSecureDirectory(directory: SecureDirectory): void {
  closeFd(directory.fd);
}

export function revalidateSecureDirectory(workspace: string, directory: SecureDirectory): void {
  let current: { fd: number; created: SecureCreatedDirectory[] };
  try {
    current = openDirectory(workspace, directory.path, false);
  } catch (error) {
    throw new ToolExecutionError("process cwd directory changed", { cause: error });
  }
  try {
    if (!sameSecureIdentity(directory.identity, secureFileIdentity(directory.fd))) {
      throw new ToolExecutionError("process cwd directory identity changed");
    }
    if (!sameSecureIdentity(directory.identity, secureFileIdentity(current.fd))) {
      throw new ToolExecutionError("process cwd directory identity changed");
    }
  } finally {
    closeFd(current.fd);
  }
}

export function openPatchTransactionLock(workspace: string): number {
  const root = openRoot(rootPath(workspace));
  const native = getSecureNativeFs();
  const result = native.symbols.flock(root, native.constants.lockExclusive | native.constants.lockNonblocking);
  if (result < 0) {
    const errorNumber = errno();
    closeFd(root);
    if (native.errnoNames[errorNumber] === "EAGAIN") {
      throw new ToolExecutionError("another patch transaction is already active");
    }
    throw nativeError("lock", workspace, errorNumber);
  }
  return root;
}

function openDirectory(workspace: string, path: string, create: boolean): { fd: number; created: SecureCreatedDirectory[] } {
  const { root, components } = componentsFor(workspace, path);
  let currentFd = openRoot(root);
  let currentPath = root;
  const created: SecureCreatedDirectory[] = [];
  try {
    for (const component of components) {
      let nextFd: number | null = null;
      try {
        let createdNow = false;
        try {
          nextFd = openAt(currentFd, component, DIRECTORY_FLAGS, 0);
        } catch (error) {
          if (!create || (error as NativeError).code !== "ENOENT") throw error;
          const native = getSecureNativeFs();
          const made = native.symbols.mkdirat(currentFd, component, 0o755);
          createdNow = made >= 0;
          if (!createdNow && native.errnoNames[errno()] !== "EEXIST") throwNative("mkdir", component);
          nextFd = openAt(currentFd, component, DIRECTORY_FLAGS, 0);
        }
        if (createdNow) {
          created.push({ path: `${currentPath}${sep}${component}`, identity: secureFileIdentity(nextFd) });
          fchmodSync(nextFd, 0o755);
        }
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
  const native = getSecureNativeFs();
  const { dirent } = native;
  if (header.byteLength < dirent.headerBytes) {
    throw new ToolExecutionError("directory contained an invalid entry");
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const recordLength = view.getUint16(dirent.recordLengthOffset, true);
  const nameLength =
    dirent.nameLengthOffset === null
      ? header.indexOf(0, dirent.nameOffset) - dirent.nameOffset
      : view.getUint16(dirent.nameLengthOffset, true);
  if (
    recordLength < dirent.minimumRecordBytes ||
    recordLength > dirent.maxRecordBytes ||
    recordLength % dirent.alignment !== 0 ||
    dirent.nameOffset >= recordLength ||
    nameLength <= 0 ||
    nameLength > dirent.maxNameBytes ||
    dirent.nameOffset + nameLength + 1 > recordLength
  ) {
    throw new ToolExecutionError("directory contained an invalid entry");
  }
  return { recordLength, nameLength, type: view.getUint8(dirent.typeOffset) };
}

export function validateNativeReaddirResult(path: string, entry: unknown, errorNumber: number): boolean {
  if (entry !== null) return false;
  if (errorNumber !== 0) throw nativeError("readdir", path, errorNumber);
  return true;
}

export function safeDirectoryEntries(workspace: string, path: string): SecureEntry[] {
  const { fd } = openDirectory(workspace, path, false);
  const native = getSecureNativeFs();
  const directory = native.symbols.fdopendir(fd);
  if (!directory) {
    closeFd(fd);
    throwNative("fdopendir", path);
  }
  const entries: SecureEntry[] = [];
  try {
    while (true) {
      setErrno(0);
      const entry = native.symbols.readdir(directory);
      if (entry === null) {
        if (validateNativeReaddirResult(path, entry, errno())) break;
        throw new ToolExecutionError("directory read did not return an entry or EOF");
      }
      const { dirent } = native;
      const header = new Uint8Array(toArrayBuffer(entry, 0, dirent.headerBytes));
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
      const recordLength = view.getUint16(dirent.recordLengthOffset, true);
      if (
        recordLength < dirent.minimumRecordBytes ||
        recordLength > dirent.maxRecordBytes ||
        recordLength % dirent.alignment !== 0 ||
        dirent.nameOffset >= recordLength
      ) {
        throw new ToolExecutionError("directory contained an invalid entry");
      }
      const record = new Uint8Array(toArrayBuffer(entry, 0, recordLength));
      validateNativeDirentHeader(record);
      const decoded = dirent.decodeDirent(record);
      const name = decoded.name;
      if (name !== "." && name !== "..") {
        entries.push({ name, type: directoryEntryType(decoded.type) });
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
    return readSecureFileText(fd);
  } finally {
    closeFd(fd);
  }
}

export function readSecureFileText(fd: number): { content: string; truncated: boolean } {
  requireRegular(fd, "read");
  const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
  const bytesRead = readSync(fd, buffer, 0, buffer.byteLength, 0);
  const content = buffer.subarray(0, bytesRead).toString("utf8");
  return { content: truncateUtf8(content, MAX_READ_BYTES), truncated: bytesRead > MAX_READ_BYTES };
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

export type SecureParent = {
  fd: number;
  name: string;
  path: string;
  identity: SecureIdentity;
  created: SecureCreatedDirectory[];
};

export function openSecureParent(workspace: string, path: string, create: boolean): SecureParent {
  const { root, components } = componentsFor(workspace, path);
  if (components.length === 0) throw new ToolExecutionError("path has no parent file name");
  const name = components.pop()!;
  const parentPath = components.length === 0 ? root : `${root}${sep}${components.join(sep)}`;
  const parent = openDirectory(workspace, parentPath, create);
  return {
    fd: parent.fd,
    name,
    path: parentPath,
    identity: secureFileIdentity(parent.fd),
    created: parent.created,
  };
}

export function closeSecureParent(parent: SecureParent): void {
  closeFd(parent.fd);
}

export function revalidateSecureParent(workspace: string, parent: SecureParent): void {
  let current: { fd: number; created: SecureCreatedDirectory[] };
  try {
    current = openDirectory(workspace, parent.path, false);
  } catch (error) {
    throw new ToolExecutionError("patch parent directory identity changed", { cause: error });
  }
  try {
    if (!sameSecureIdentity(parent.identity, secureFileIdentity(parent.fd))) {
      throw new ToolExecutionError("patch parent directory identity changed");
    }
    if (!sameSecureIdentity(parent.identity, secureFileIdentity(current.fd))) {
      throw new ToolExecutionError("patch parent directory identity changed");
    }
  } finally {
    closeFd(current.fd);
  }
}

export function openPatchTarget(parent: SecureParent, name = parent.name): number | null {
  try {
    const fd = openAt(parent.fd, name, PATCH_READ_FLAGS, 0);
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

export function openSecureDirectory(parent: SecureParent): number {
  const fd = openAt(parent.fd, parent.name, DIRECTORY_FLAGS, 0);
  try {
    if (!fstatSync(fd).isDirectory()) throw new ToolExecutionError("target is not a directory");
    return fd;
  } catch (error) {
    closeFd(fd);
    throw error;
  }
}

export type SecureOpenFile = { fd: number; identity: SecureIdentity };

export function createPatchTemp(parent: SecureParent, name: string, content: string): SecureOpenFile {
  let fd: number | null = null;
  let retained = false;
  try {
    fd = openAt(parent.fd, name, PATCH_CREATE_FLAGS, 0o600);
    const identity = secureFileIdentity(fd);
    fchmodSync(fd, 0o600);
    requireRegular(fd, "patch temporary");
    const bytes = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
    fsyncSync(fd);
    retained = true;
    return { fd, identity };
  } finally {
    if (fd !== null && !retained) closeFd(fd);
  }
}

export function createPatchRecovery(parent: SecureParent, name: string, sourceFd: number): SecureOpenFile {
  const source = readSecureFileText(sourceFd);
  if (source.truncated) throw new ToolExecutionError("patch recovery source exceeds the bounded read limit");
  return createPatchTemp(parent, name, source.content);
}

function callAt(operation: string, result: number, path: string): void {
  if (result < 0) throwNative(operation, path);
}

export function renameAt(parent: SecureParent, from: string, to: string): void {
  callAt("rename", getSecureNativeFs().symbols.renameat(parent.fd, from, parent.fd, to), `${from} -> ${to}`);
}

export function linkAt(parent: SecureParent, from: string, to: string): void {
  callAt("link", getSecureNativeFs().symbols.linkat(parent.fd, from, parent.fd, to, 0), `${from} -> ${to}`);
}

export function unlinkAt(parent: SecureParent, name: string, directory = false): void {
  const native = getSecureNativeFs();
  callAt("unlink", native.symbols.unlinkat(parent.fd, name, directory ? native.constants.atRemovedir : 0), name);
}
