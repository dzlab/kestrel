import { expect, test } from "bun:test";
import { decodeDirent, getNativeFs, loadNativeFsForPlatform } from "../src/tools/native-fs";

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
  const recordLength = 32;
  const record = new Uint8Array(recordLength);
  const view = new DataView(record.buffer);
  view.setUint16(16, recordLength, true);
  view.setUint8(18, type);
  record.set(nameBytes, 19);
  return record;
}

const fixtures = {
  darwin: { bytes: makeDarwinDirent("entry", 4), nameOffset: 21 },
  linux: { bytes: makeLinuxDirent("entry", 4), nameOffset: 19 },
} satisfies Record<SupportedPlatform, { bytes: Uint8Array; nameOffset: number }>;

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

test("preserves bounded platform context when loading an adapter fails", () => {
  if (!isSupportedPlatform(process.platform)) return;

  const unavailablePlatform = process.platform === "darwin" ? "linux" : "darwin";
  let error: unknown;
  try {
    loadNativeFsForPlatform(unavailablePlatform);
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(`could not load ${unavailablePlatform} native filesystem adapter`);
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

  // Keep the platform explicit so this pure top-level decoder exercises both ABI layouts on either host.
  for (const platform of supportedPlatforms) {
    expect(decodeDirent(platform, fixtures[platform].bytes)).toMatchObject({ name: "entry", type: 4 });
  }
});

test("rejects oversized and unterminated native dirent records", () => {
  if (!isSupportedPlatform(process.platform)) return;

  for (const platform of supportedPlatforms) {
    const fixture = fixtures[platform];
    const oversized = fixture.bytes.slice();
    const missingNul = fixture.bytes.slice();
    const view = new DataView(oversized.buffer);
    const missingNulOffset = fixture.nameOffset + "entry".length;

    view.setUint16(16, 0xffff, true);
    missingNul.fill(0x78, missingNulOffset);
    expect(missingNul.slice(missingNulOffset).every((byte) => byte !== 0)).toBe(true);

    expect(() => decodeDirent(platform, oversized)).toThrow(/invalid|record/i);
    expect(() => decodeDirent(platform, missingNul)).toThrow(/invalid|NUL|terminat/i);
  }
});
