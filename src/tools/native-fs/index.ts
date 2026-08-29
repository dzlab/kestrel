import { ToolExecutionError } from "../../errors";
import { createDarwinNativeFs } from "./darwin";
import { createLinuxNativeFs } from "./linux";
import {
  createDirentParser,
  DARWIN_DIRENT_LAYOUT,
  LINUX_DIRENT_LAYOUT,
  type NativeDirentEntry,
  type NativeFs,
  type NativePlatform,
} from "./types";

export * from "./types";
export { createDarwinNativeFs } from "./darwin";
export { createLinuxNativeFs } from "./linux";

const direntParsers = {
  darwin: createDirentParser(DARWIN_DIRENT_LAYOUT),
  linux: createDirentParser(LINUX_DIRENT_LAYOUT),
} satisfies Record<NativePlatform, ReturnType<typeof createDirentParser>>;

export function decodeDirent(platform: NativePlatform | string, record: Uint8Array): NativeDirentEntry {
  if (platform !== "darwin" && platform !== "linux") {
    throw new ToolExecutionError("unsupported platform for native filesystem");
  }
  return direntParsers[platform].decodeDirent(record);
}

export function loadNativeFsForPlatform(platform: string): NativeFs {
  if (platform !== "darwin" && platform !== "linux") {
    throw new ToolExecutionError("unsupported platform for native filesystem");
  }

  try {
    return platform === "darwin" ? createDarwinNativeFs() : createLinuxNativeFs();
  } catch {
    throw new ToolExecutionError("could not load native filesystem adapter");
  }
}

let cachedNativeFs: NativeFs | undefined;

export function getNativeFs(): NativeFs {
  cachedNativeFs ??= loadNativeFsForPlatform(process.platform);
  return cachedNativeFs;
}
