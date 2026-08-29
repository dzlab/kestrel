const usage = "Usage: bun run src/cli/main.ts [--help]";

export function runCli(
  args: readonly string[],
  write: (message: string) => void = (message) => console.log(message),
): number {
  if (args.includes("--help")) {
    write(usage);
  }

  return 0;
}

if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2));
}
