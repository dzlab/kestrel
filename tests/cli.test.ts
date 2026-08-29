import { expect, test } from "bun:test";
import { runCli } from "../src/cli/main";

test("--help prints actionable commands and exits cleanly", () => {
  const output: string[] = [];

  const exitCode = runCli(["--help"], (message) => output.push(message));

  expect(exitCode).toBe(0);
  expect(output).toHaveLength(1);
  expect(output[0]).toContain("kestrel run <prompt>");
  expect(output[0]).toContain("kestrel approve <call-id>");
  expect(output[0]).toContain("kestrel deny <call-id>");
  expect(output[0]).toContain("kestrel schedule");
  expect(output[0]).toContain("kestrel tick");
  expect(output[0]).toContain("kestrel daemon");
  expect(output[0]).toContain("kestrel memory list");
  expect(output[0]).toContain("kestrel self inspect");
  expect(output[0]).toContain("KESTREL_MODEL_BASE_URL");
});
