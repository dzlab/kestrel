import { expect, test } from "bun:test";
import { runCli } from "../src/cli/main";

test("--help prints usage and exits cleanly", () => {
  const output: string[] = [];

  const exitCode = runCli(["--help"], (message) => output.push(message));

  expect(exitCode).toBe(0);
  expect(output).toEqual(["Usage: bun run src/cli/main.ts [--help]"]);
});
