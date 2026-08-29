import { expect, test } from "bun:test";
import { getNativeFs, loadNativeFsForPlatform } from "../src/tools/native-fs";

const supportedPlatforms = ["darwin", "linux"] as const;
type SupportedPlatform = (typeof supportedPlatforms)[number];

function isSupportedPlatform(platform: NodeJS.Platform): platform is SupportedPlatform {
  return supportedPlatforms.includes(platform as SupportedPlatform);
}

function makeDarwinDirent(name: string, type: number): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const recordLength = 32;
  const record = new Uint8Array(recordLength);
  const view = new DataView(record.buffer);
  view.setUint16(16, recordLength, true);
  view.setUint16(18, nameBytes.length, true);
  view.setUint8(20, type);
  record.set(nameBytes, 21);
  return record;
}

function makeLinuxDirent(name: string, type: number): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const recordLength = 24;
  const record = new Uint8Array(recordLength);
  const view = new DataView(record.buffer);
  view.setUint16(16, recordLength, true);
  view.setUint8(18, type);
  record.set(nameBytes, 19);
  return record;
}

const fixtures = {
  darwin: makeDarwinDirent("entry", 4),
  linux: makeLinuxDirent("entry", 4),
} satisfies Record<SupportedPlatform, Uint8Array>;

test("loads the native filesystem adapter on supported platforms", () => {
  if (!isSupportedPlatform(process.platform)) return;

  const nativeFs = getNativeFs();

  expect(nativeFs.platform).toBe(process.platform);
  expect(typeof nativeFs.symbols.openat).toBe("function");
  expect(typeof nativeFs.symbols.renameat).toBe("function");
  expect(typeof nativeFs.symbols.unlinkat).toBe("function");
  expect(nativeFs.dirent.maxRecordBytes).toBeGreaterThan(0);
});

test("rejects unsupported native filesystem platforms", () => {
  expect(() => loadNativeFsForPlatform("win32")).toThrow(/unsupported platform/i);
});

test("exposes portable native filesystem constants and errno names", () => {
  if (!isSupportedPlatform(process.platform)) return;

  const nativeFs = getNativeFs();

  expect(Number.isInteger(nativeFs.constants.atFdcwd)).toBe(true);
  expect(Number.isInteger(nativeFs.constants.atRemovedir)).toBe(true);
  expect(nativeFs.errnoNames[2]).toBe("ENOENT");
});

test("decodes Darwin and Linux dirent fixtures with the same name and type", () => {
  if (!isSupportedPlatform(process.platform)) return;

  const nativeFs = getNativeFs();
  const fixture = fixtures[nativeFs.platform];

  expect(nativeFs.dirent.decode(fixture)).toEqual({ name: "entry", type: 4 });
});

test("rejects oversized and unterminated native dirent records", () => {
  if (!isSupportedPlatform(process.platform)) return;

  const nativeFs = getNativeFs();
  const fixture = fixtures[nativeFs.platform];
  const oversized = fixture.slice();
  const missingNul = fixture.slice();
  const view = new DataView(oversized.buffer);

  view.setUint16(16, nativeFs.dirent.maxRecordBytes + 1, true);
  missingNul.fill(0x78, nativeFs.platform === "darwin" ? 26 : 24);

  expect(() => nativeFs.dirent.decode(oversized)).toThrow(/invalid|record/i);
  expect(() => nativeFs.dirent.decode(missingNul)).toThrow(/invalid|NUL|terminat/i);
});
