import { expect, test } from "bun:test";
import { KestrelError } from "../src/errors";

test("KestrelError always uses its stable base code", () => {
  expect(new KestrelError("x").code).toBe("KESTREL_ERROR");

  // @ts-expect-error KestrelError must not accept a custom error code.
  const attemptedCustomCode = new KestrelError("x", "CUSTOM_CODE");
  expect(attemptedCustomCode.code).toBe("KESTREL_ERROR");
});
