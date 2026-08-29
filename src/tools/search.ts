import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import { ValidationError } from "../errors";
import { readWorkspaceText, resolveWorkspacePath, safeDirectoryEntries, workspacePathInfo } from "./filesystem";
import type { Tool } from "./types";
import {
  MAX_READ_BYTES,
  MAX_SEARCH_MATCHES,
  MAX_TOOL_OUTPUT_BYTES,
  boundToolResult,
} from "./types";
import type { ToolContext, ToolResult } from "./types";

type Match = { path: string; line: number; content: string };

function stringArgument(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new ValidationError(`${name} must be a string`);
  return value;
}

function boundedMatches(matches: Match[]): Match[] {
  const bounded: Match[] = [];
  for (const match of matches) {
    if (bounded.length >= MAX_SEARCH_MATCHES) break;
    const candidate = [...bounded, match];
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_TOOL_OUTPUT_BYTES) break;
    bounded.push(match);
  }
  return bounded;
}

async function collectFiles(workspace: string, root: string, files: string[]): Promise<void> {
  const entries = safeDirectoryEntries(workspace, root).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    if (entry.type === "symlink" || entry.type === "special") continue;
    const child = resolveWorkspacePath(workspace, `${root}${sep}${entry.name}`);
    if (entry.type === "directory") await collectFiles(workspace, child, files);
    else if (entry.type === "file") files.push(child);
  }
}

const searchTool: Tool = {
  definition: {
    name: "search.text",
    description: "Search bounded UTF-8 text files in the workspace.",
    capability: "filesystem",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, path: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const query = stringArgument(args, "query");
    if (query.length === 0) throw new ValidationError("query must be non-empty");
    const requestedPath = args.path === undefined ? "." : stringArgument(args, "path");
    const root = resolveWorkspacePath(context.workspace, requestedPath);
    const rootInfo = workspacePathInfo(context.workspace, root);
    const files: string[] = [];
    if (rootInfo.isDirectory()) await collectFiles(context.workspace, root, files);
    else if (rootInfo.isFile()) files.push(root);

    const matches: Match[] = [];
    for (const file of files) {
      if (matches.length >= MAX_SEARCH_MATCHES) break;
      const text = readWorkspaceText(context.workspace, file).content;
      const lines = text.split("\n");
      for (let index = 0; index < lines.length && matches.length < MAX_SEARCH_MATCHES; index += 1) {
        if (lines[index].includes(query)) {
          matches.push({ path: relative(realpathSync(context.workspace), file).split(sep).join("/"), line: index + 1, content: lines[index] });
        }
      }
    }
    const bounded = boundedMatches(matches);
    return boundToolResult({ ok: true, content: JSON.stringify(bounded), data: bounded });
  },
};

export function createSearchTool(): Tool {
  return searchTool;
}

export { searchTool };
