import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import { ToolExecutionError } from "../../errors";
import {
  createDirentParser,
  DARWIN_DIRENT_LAYOUT,
  DARWIN_ERRNO_NAMES,
  type NativeFs,
  type NativePointer,
  type NativeSymbols,
} from "./types";

export const DARWIN_LIBRARY_PATH = "/usr/lib/libSystem.B.dylib";

const ffiDefinitions = {
  openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  linkat: {
    args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.i32],
    returns: FFIType.i32,
  },
  mkdirat: { args: [FFIType.i32, FFIType.cstring, FFIType.u16], returns: FFIType.i32 },
  renameat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring], returns: FFIType.i32 },
  unlinkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
  fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
  readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
  closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
  __error: { args: [], returns: FFIType.ptr },
  strerror: { args: [FFIType.i32], returns: FFIType.cstring },
  mkfifo: { args: [FFIType.cstring, FFIType.u16], returns: FFIType.i32 },
} as const;

function readErrno(errnoPointer: NativeSymbols["errnoPointer"]): number {
  const pointer = errnoPointer();
  if (pointer === null) throw new ToolExecutionError("could not read native errno");
  return new DataView(toArrayBuffer(pointer as NativePointer, 0, 4)).getInt32(0, true);
}
export function createDarwinNativeFs(): NativeFs {
  try {
    const library = dlopen(DARWIN_LIBRARY_PATH, ffiDefinitions);
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
      errnoPointer: loaded.__error,
      strerror: loaded.strerror,
      mkfifo: loaded.mkfifo,
    };

    return {
      platform: "darwin",
      libraryPath: DARWIN_LIBRARY_PATH,
      symbols,
      constants: { atFdcwd: -2, atRemovedir: 0x0080, lockExclusive: 0x02, lockNonblocking: 0x04 },
      dirent: createDirentParser(DARWIN_DIRENT_LAYOUT),
      errnoNames: DARWIN_ERRNO_NAMES,
      errno: () => readErrno(symbols.errnoPointer),
    };
  } catch {
    throw new ToolExecutionError("could not load Darwin native filesystem library");
  }
}
