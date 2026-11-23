import type { Tool } from "@/types";
import { FETCHABLE_TOOL_IDS, toolBinary } from "@/lib/runner";
import type { FetchableId } from "@/lib/sandbox";
import { GRAPHIFY_TOOL_ID } from "@/lib/graphify";

/**
 * How a missing tool gets installed: fetch an official release binary, run a
 * package manager's install command (shown first), or link to the install page.
 * Every path starts with a click, and none pipes a script into a shell.
 */
export type InstallPlan =
  | { kind: "fetch"; id: FetchableId }
  | { kind: "command"; id: "graphify" }
  | { kind: "link"; url: string };

/** Where each tool that Assay can't fetch is actually installed from. */
const PAGES: Record<string, string> = {
  semgrep: "https://semgrep.dev/docs/getting-started/quickstart",
  strix: "https://github.com/usestrix/strix",
};

/** …and the same, for the runtimes several tools share. */
const RUNTIME_PAGES = new Map<string, string>([
  ["docker", "https://www.docker.com/products/docker-desktop/"],
  ["npx", "https://nodejs.org/en/download"],
  ["node", "https://nodejs.org/en/download"],
  ["git", "https://git-scm.com/downloads"],
]);

export function installPlanFor(tool: Tool): InstallPlan | null {
  if (FETCHABLE_TOOL_IDS.has(tool.id)) return { kind: "fetch", id: tool.id as FetchableId };
  if (tool.id === GRAPHIFY_TOOL_ID) return { kind: "command", id: "graphify" };
  const page = PAGES[tool.id];
  if (page) return { kind: "link", url: page };
  const binary = toolBinary(tool);
  const runtime = binary ? RUNTIME_PAGES.get(binary) : undefined;
  return runtime ? { kind: "link", url: runtime } : null;
}
