import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import { ToolExecutionError } from "../../errors";
import {
  createDirentParser,
  LINUX_DIRENT_LAYOUT,
  LINUX_ERRNO_NAMES,
  type NativeFs,
  type NativePointer,
  type NativeSymbols,
} from "./types";

export const LINUX_LIBRARY_CANDIDATES = [
  "libc.so.6",
  "libc.musl-x86_64.so.1",
  "libc.musl-aarch64.so.1",
] as const;

const ffiDefinitions = {
  openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  linkat: {
    args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.i32],
    returns: FFIType.i32,
  },
  mkdirat: { args: [FFIType.i32, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
  renameat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring], returns: FFIType.i32 },
  unlinkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
  fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
  readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
  closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
  __errno_location: { args: [], returns: FFIType.ptr },
  strerror: { args: [FFIType.i32], returns: FFIType.cstring },
  mkfifo: { args: [FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
} as const;

function readErrno(errnoPointer: NativeSymbols["errnoPointer"]): number {
  const pointer = errnoPointer();
  if (pointer === null) throw new ToolExecutionError("could not read native errno");
  return new DataView(toArrayBuffer(pointer as NativePointer, 0, 4)).getInt32(0, true);
}
function createLinuxNativeFsFromPath(libraryPath: string): NativeFs {
  const library = dlopen(libraryPath, ffiDefinitions);
  const loaded = library.symbols;
  const symbols: NativeSymbols = {
    openat: loaded.openat,
    flock: loaded.flock,
    linkat: loaded.linkat,
    mkdirat: loaded.mkdirat,
    renameat: loaded.renameat,
    unlinkat: loaded.unlinkat,
    fdopendir: loaded.fdopendir,
    readdir: loaded.readdir,
    closedir: loaded.closedir,
    errnoPointer: loaded.__errno_location,
    strerror: loaded.strerror,
    mkfifo: loaded.mkfifo,
  };

  return {
    platform: "linux",
    libraryPath,
    symbols,
    constants: { atFdcwd: -100, atRemovedir: 0x0200, lockExclusive: 0x02, lockNonblocking: 0x04 },
    dirent: createDirentParser(LINUX_DIRENT_LAYOUT),
    errnoNames: LINUX_ERRNO_NAMES,
    errno: () => readErrno(symbols.errnoPointer),
  };
}

export function createLinuxNativeFs(): NativeFs {
  for (const libraryPath of LINUX_LIBRARY_CANDIDATES) {
    try {
      return createLinuxNativeFsFromPath(libraryPath);
    } catch {
      // Try the next fixed system-library candidate without exposing loader details.
    }
  }
  throw new ToolExecutionError("could not load Linux native filesystem library");
}
