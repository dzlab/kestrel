import { ToolExecutionError } from "../../errors";
import type { Pointer } from "bun:ffi";

export type NativePlatform = "darwin" | "linux";
export type NativePointer = Pointer | bigint;

export type NativeSymbols = {
  openat(directoryFd: number, path: string, flags: number, mode: number): number;
  flock(fd: number, operation: number): number;
  linkat(
    sourceDirectoryFd: number,
    sourcePath: string,
    targetDirectoryFd: number,
    targetPath: string,
    flags: number,
  ): number;
  mkdirat(directoryFd: number, path: string, mode: number): number;
  renameat(
    sourceDirectoryFd: number,
    sourcePath: string,
    targetDirectoryFd: number,
    targetPath: string,
  ): number;
  unlinkat(directoryFd: number, path: string, flags: number): number;
  fdopendir(fd: number): NativePointer | null;
  readdir(directory: NativePointer): NativePointer | null;
  closedir(directory: NativePointer): number;
  errnoPointer(): NativePointer | null;
  strerror(errorNumber: number): string | null;
  mkfifo(path: string, mode: number): number;
};

export type NativeConstants = {
  atFdcwd: number;
  atRemovedir: number;
  lockExclusive: number;
  lockNonblocking: number;
};

export type NativeDirentEntry = {
  recordLength: number;
  name: string;
  type: number;
};

export type NativeDirentLayout = {
  headerBytes: number;
  minimumRecordBytes: number;
  maxRecordBytes: number;
  maxNameBytes: number;
  recordLengthOffset: number;
  nameLengthOffset: number | null;
  typeOffset: number;
  nameOffset: number;
  alignment: number;
};

export type NativeDirent = NativeDirentLayout & {
  decodeDirent(record: Uint8Array): NativeDirentEntry;
};

export type NativeErrnoNames = Readonly<Record<number, string>>;

export type NativeFs = {
  platform: NativePlatform;
  libraryPath: string;
  symbols: NativeSymbols;
  constants: NativeConstants;
  dirent: NativeDirent;
  errnoNames: NativeErrnoNames;
  errno(): number;
};

export const DARWIN_DIRENT_LAYOUT: NativeDirentLayout = {
  headerBytes: 21,
  minimumRecordBytes: 24,
  maxRecordBytes: 1024,
  maxNameBytes: 255,
  recordLengthOffset: 16,
  nameLengthOffset: 18,
  typeOffset: 20,
  nameOffset: 21,
  alignment: 4,
};

export const LINUX_DIRENT_LAYOUT: NativeDirentLayout = {
  headerBytes: 19,
  minimumRecordBytes: 24,
  maxRecordBytes: 1024,
  maxNameBytes: 255,
  recordLengthOffset: 16,
  nameLengthOffset: null,
  typeOffset: 18,
  nameOffset: 19,
  alignment: 8,
};

function invalidDirent(): never {
  throw new ToolExecutionError("invalid native directory entry");
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalidDirent();
  }
}

export function createDirentParser(layout: NativeDirentLayout): NativeDirent {
  return {
    ...layout,
    decodeDirent(record: Uint8Array): NativeDirentEntry {
      if (!(record instanceof Uint8Array) || record.byteLength < layout.headerBytes) return invalidDirent();

      const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
      const recordLength = view.getUint16(layout.recordLengthOffset, true);
      if (
        recordLength < layout.minimumRecordBytes ||
        recordLength > layout.maxRecordBytes ||
        recordLength > record.byteLength ||
        recordLength % layout.alignment !== 0 ||
        layout.nameOffset >= recordLength
      ) {
        return invalidDirent();
      }

      let nameLength: number;
      if (layout.nameLengthOffset === null) {
        const nul = record.indexOf(0, layout.nameOffset);
        if (nul < layout.nameOffset || nul >= recordLength) return invalidDirent();
        nameLength = nul - layout.nameOffset;
      } else {
        nameLength = view.getUint16(layout.nameLengthOffset, true);
        if (nameLength === 0 || nameLength > layout.maxNameBytes) return invalidDirent();
        const nulOffset = layout.nameOffset + nameLength;
        if (nulOffset >= recordLength || record[nulOffset] !== 0) return invalidDirent();
      }

      if (nameLength === 0 || nameLength > layout.maxNameBytes || layout.nameOffset + nameLength >= recordLength) {
        return invalidDirent();
      }

      const nameBytes = record.subarray(layout.nameOffset, layout.nameOffset + nameLength);
      if (nameBytes.includes(0)) return invalidDirent();
      return { recordLength, name: decodeUtf8(nameBytes), type: view.getUint8(layout.typeOffset) };
    },
  };
}

export const DARWIN_ERRNO_NAMES: NativeErrnoNames = {
  1: "EPERM",
  2: "ENOENT",
  3: "ESRCH",
  4: "EINTR",
  5: "EIO",
  6: "ENXIO",
  7: "E2BIG",
  8: "ENOEXEC",
  9: "EBADF",
  10: "ECHILD",
  11: "EDEADLK",
  12: "ENOMEM",
  13: "EACCES",
  14: "EFAULT",
  16: "EBUSY",
  17: "EEXIST",
  18: "EXDEV",
  19: "ENODEV",
  20: "ENOTDIR",
  21: "EISDIR",
  22: "EINVAL",
  23: "ENFILE",
  24: "EMFILE",
  27: "EFBIG",
  28: "ENOSPC",
  30: "EROFS",
  31: "EMLINK",
  32: "EPIPE",
  35: "EAGAIN",
  36: "EINPROGRESS",
  37: "EALREADY",
  39: "EDESTADDRREQ",
  40: "EMSGSIZE",
  41: "EPROTOTYPE",
  42: "ENOPROTOOPT",
  43: "EPROTONOSUPPORT",
  45: "ENOTSUP",
  47: "EAFNOSUPPORT",
  48: "EADDRINUSE",
  49: "EADDRNOTAVAIL",
  50: "ENETDOWN",
  51: "ENETUNREACH",
  52: "ENETRESET",
  53: "ECONNABORTED",
  54: "ECONNRESET",
  55: "ENOBUFS",
  56: "EISCONN",
  57: "ENOTCONN",
  60: "ETIMEDOUT",
  61: "ECONNREFUSED",
  62: "ELOOP",
  63: "ENAMETOOLONG",
  66: "ENOTEMPTY",
  70: "ESTALE",
  78: "ENOSYS",
  84: "EOVERFLOW",
  85: "ECANCELED",
  86: "EILSEQ",
};

export const LINUX_ERRNO_NAMES: NativeErrnoNames = {
  1: "EPERM",
  2: "ENOENT",
  3: "ESRCH",
  4: "EINTR",
  5: "EIO",
  6: "ENXIO",
  7: "E2BIG",
  8: "ENOEXEC",
  9: "EBADF",
  10: "ECHILD",
  11: "EAGAIN",
  12: "ENOMEM",
  13: "EACCES",
  14: "EFAULT",
  16: "EBUSY",
  17: "EEXIST",
  18: "EXDEV",
  19: "ENODEV",
  20: "ENOTDIR",
  21: "EISDIR",
  22: "EINVAL",
  23: "ENFILE",
  24: "EMFILE",
  27: "EFBIG",
  28: "ENOSPC",
  30: "EROFS",
  31: "EMLINK",
  32: "EPIPE",
  35: "EDEADLK",
  36: "ENAMETOOLONG",
  39: "ENOTEMPTY",
  40: "ELOOP",
  95: "EOPNOTSUPP",
  38: "ENOSYS",
  75: "EOVERFLOW",
  125: "ECANCELED",
  84: "EILSEQ",
};
