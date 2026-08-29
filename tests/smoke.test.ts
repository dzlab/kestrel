import { expect, test } from "bun:test";
import { version } from "../src/index";

test("exports a Kestrel version", () => {
  expect(version).toBe("0.1.0");
});
