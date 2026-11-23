import { homeDir, join, localDataDir } from "@tauri-apps/api/path";
import { exists, readDir, readTextFile, stat, writeTextFile } from "@tauri-apps/plugin-fs";
import { platform } from "@tauri-apps/plugin-os";
import type { Tool } from "@/types";
import { probe, runOnce, runTokens, type ProcResult } from "@/lib/exec";
import { enabledGroups } from "@/lib/tool-options";
import { isIgnored, isRepo, trackedUnder } from "@/lib/git";
import type { Log } from "@/lib/sandbox";

/**
 * Graphify: the project's knowledge graph, built unattended through the headless CLI
 * (`extract --code-only` is local AST: no LLM, no key, no network, no prompts).
 */

export const GRAPHIFY_TOOL_ID = "graphify";

/** The PyPI package. The command it installs is `graphify`; the package is not. */
const GRAPHIFY_PACKAGE = "graphifyy";

/** Where graphify keeps everything it writes, relative to the project root. */
const GRAPH_DIR = "graphify-out";
const GRAPH_FILE = "graph.json";

/**
 * `build` and `rebuild` are the same full extraction, labelled differently; `update`
 * re-parses only what changed since the last manifest.
 */
export type GraphMode = "build" | "rebuild" | "update";

export interface GraphState {
  /** Whether `graphify-out/graph.json` exists for this project. */
  built: boolean;
  /** When it was last written, in ms, or null when it was never built. */
  at: number | null;
}

const UNBUILT: GraphState = { built: false, at: null };

/**
 * Does this project already have a graph, and how old is it? Read from disk every
 * time, since checkouts or the post-commit hook change it behind Assay's back.
 */
export async function graphState(path?: string | null): Promise<GraphState> {
  if (!path) return UNBUILT;
  try {
    const file = await join(path, GRAPH_DIR, GRAPH_FILE);
    if (!(await exists(file))) return UNBUILT;
    const info = await stat(file);
    return { built: true, at: info.mtime ? info.mtime.getTime() : null };
  } catch {
    return UNBUILT; // unreadable is not built, as far as a button is concerned
  }
}

/** The mode a plain Run means: update an existing graph, build a missing one. */
export function modeFor(state: GraphState): GraphMode {
  return state.built ? "update" : "build";
}

/* --------------------------------- command ---------------------------------- */
/**
 * The argv for one run. `--code-only` is what keeps it unattended: docs, papers and
 * images are the only inputs that need an LLM backend.
 */
export function graphifyTokens(tool: Tool, mode: GraphMode, path: string): string[] {
  const on = new Set(enabledGroups(tool));
  if (mode === "update") {
    // `update` takes no deep/directed/docs options
    return ["graphify", "update", path, ...(on.has("no-cluster") ? ["--no-cluster"] : [])];
  }
  const args = ["graphify", "extract", path];
  if (!on.has("docs")) args.push("--code-only");
  if (on.has("deep")) args.push("--mode", "deep");
  if (on.has("directed")) args.push("--directed");
  if (on.has("no-cluster")) args.push("--no-cluster");
  return args;
}

/* -------------------------------- artifacts ---------------------------------- */
/**
 * The files graphify writes besides `graph.json`, each from its own subcommand run
 * after the extraction. None needs a key; `cluster-only` names communities with an
 * LLM only when one is configured.
 */
export type GraphArtifactId = "report" | "html" | "tree" | "callflow";

/**
 * The commands to run after the graph is written, in order. `cluster-only` also writes
 * `graph.html`; never pass `--no-viz`, which deletes an existing `graph.html`. Only
 * the first takes the path: exports resolve `graphify-out/` against the cwd.
 */
export function artifactCommands(tool: Tool, path: string): string[][] {
  const on = new Set(enabledGroups(tool));
  const cmds: string[][] = [];
  if (on.has("report")) cmds.push(["graphify", "cluster-only", path]);
  else if (on.has("html")) cmds.push(["graphify", "export", "html"]);
  if (on.has("tree")) cmds.push(["graphify", "tree"]);
  if (on.has("callflow")) cmds.push(["graphify", "export", "callflow-html"]);
  return cmds;
}

/** One file an artifact option left in `graphify-out/`. */
export interface GraphFile {
  id: GraphArtifactId;
  /** The file's own name, which is what the menu shows in mono. */
  name: string;
  /** Absolute, for the system opener. */
  path: string;
}

/**
 * Which artifact a file in `graphify-out/` is, or null. The call flow is named after
 * the project folder, so it is matched by its `-callflow.html` suffix.
 */
export function artifactOf(name: string): GraphArtifactId | null {
  if (name === "graph.html") return "html";
  if (name === "GRAPH_TREE.html") return "tree";
  if (name === "GRAPH_REPORT.md") return "report";
  if (name.toLowerCase().endsWith("-callflow.html")) return "callflow";
  return null;
}

/** The order the menu lists them in: the pages first, the reading last. */
const ARTIFACT_ORDER: GraphArtifactId[] = ["html", "tree", "callflow", "report"];

/** The artifacts actually on disk right now (they outlive the option that wrote them). */
export async function graphArtifacts(path?: string | null): Promise<GraphFile[]> {
  if (!path) return [];
  try {
    const dir = await join(path, GRAPH_DIR);
    if (!(await exists(dir))) return [];
    const found: GraphFile[] = [];
    for (const entry of await readDir(dir)) {
      if (!entry.isFile) continue;
      const id = artifactOf(entry.name);
      if (id) found.push({ id, name: entry.name, path: await join(dir, entry.name) });
    }
    return found.sort((a, b) => ARTIFACT_ORDER.indexOf(a.id) - ARTIFACT_ORDER.indexOf(b.id));
  } catch {
    return []; // unreadable is nothing to open, as far as a menu is concerned
  }
}

/** Everything one run will execute: the extraction, then whatever it writes after. */
function graphifyPlan(tool: Tool, mode: GraphMode, path: string): string[][] {
  return [graphifyTokens(tool, mode, path), ...artifactCommands(tool, path)];
}

/** The plan as lines, for the confirmation dialog and the row's command preview. */
export function graphifyCommandLines(tool: Tool, mode: GraphMode, path?: string | null): string[] {
  return graphifyPlan(tool, mode, path || ".").map((tokens) => tokens.join(" "));
}

/* -------------------------------- gitignore ---------------------------------- */
/**
 * Keeping the derived `graphify-out/` out of the repository. This writes a versioned
 * file in the audited project, so it only happens behind an explicit confirmation.
 */

const GITIGNORE_FILE = ".gitignore";

/** Always English: it is read by whoever clones the repository, not the user who clicked. */
const GITIGNORE_COMMENT = "# graphify knowledge graph (regenerable: graphify update)";

/** Anchored so it matches only this directory's `graphify-out`. */
const GITIGNORE_ENTRY = `/${GRAPH_DIR}/`;

/** Exactly what gets written, and what the confirmation shows beforehand. */
export const GITIGNORE_LINES = `${GITIGNORE_COMMENT}\n${GITIGNORE_ENTRY}`;

export interface GitignoreState {
  /** Whether the project folder is inside a git work tree at all. */
  repo: boolean;
  /** Whether git already ignores `graphify-out`, by any rule from anywhere. */
  ignored: boolean;
  /** How many files under `graphify-out/` git already tracks. */
  tracked: number;
  /** The file the entry goes into, absolute. Empty until it is resolved. */
  file: string;
  /** Whether that file exists yet — append or create, and the dialog says which. */
  exists: boolean;
}

const NOT_A_REPO: GitignoreState = {
  repo: false,
  ignored: false,
  tracked: 0,
  file: "",
  exists: false,
};

/** What to run yourself when the graph is already in the index. */
export const GITIGNORE_UNTRACK_COMMAND = `git rm -r --cached ${GRAPH_DIR}`;

/** Where the offer stands for this project, asked of git and the folder every time. */
export async function gitignoreState(path?: string | null): Promise<GitignoreState> {
  if (!path) return NOT_A_REPO;
  try {
    if (!(await isRepo(path))) return NOT_A_REPO;
    const file = await join(path, GITIGNORE_FILE);
    const [ignored, tracked, has] = await Promise.all([
      isIgnored(path, GRAPH_DIR),
      trackedUnder(path, GRAPH_DIR),
      exists(file),
    ]);
    return { repo: true, ignored, tracked, file, exists: has };
  } catch {
    return NOT_A_REPO; // unanswerable is not an offer
  }
}

/**
 * Append the entry (after a blank line), or create the file with it; existing bytes
 * are kept exactly. Written to `<project>/.gitignore`, not the repo toplevel, so the
 * leading slash anchors correctly inside a monorepo package too.
 */
export async function addToGitignore(path: string): Promise<void> {
  const file = await join(path, GITIGNORE_FILE);
  let body = (await exists(file)) ? await readTextFile(file) : "";
  if (body) {
    if (!body.endsWith("\n")) body += "\n";
    if (!body.endsWith("\n\n")) body += "\n";
  }
  await writeTextFile(file, `${body}${GITIGNORE_LINES}\n`);
}

/* --------------------------------- install ---------------------------------- */
/**
 * An optional graphify Python extra. Only `sql` is offered: a language whose extractor
 * is missing is skipped silently (exit 0), so `.sql` files would never be read.
 */
export type GraphifyExtra = "sql";

/** What each extra is for, said in the words of the files it unlocks. */
export const GRAPHIFY_EXTRAS: { id: GraphifyExtra; label: string; files: string }[] = [
  { id: "sql", label: "SQL", files: ".sql" },
];

export interface InstallCommand {
  tokens: string[];
  /** The package manager it goes through, named so the dialog can say it. */
  manager: "uv" | "pipx" | "pip";
}

/**
 * How graphify gets installed, given what this machine has. Ordered by blast radius:
 * uv and pipx isolate the package; pip comes last and always `--user`. Installing
 * extras re-runs over the existing package, so pipx needs `--force`.
 */
export function installCommandFor(
  has: { uv: boolean; pipx: boolean; pip: boolean },
  extras: readonly GraphifyExtra[] = [],
): InstallCommand | null {
  const pkg = extras.length ? `${GRAPHIFY_PACKAGE}[${extras.join(",")}]` : GRAPHIFY_PACKAGE;
  if (has.uv) return { manager: "uv", tokens: ["uv", "tool", "install", "--upgrade", pkg] };
  if (has.pipx) {
    return { manager: "pipx", tokens: extras.length ? ["pipx", "install", "--force", pkg] : ["pipx", "install", pkg] };
  }
  if (has.pip) return { manager: "pip", tokens: ["pip", "install", "--user", "--upgrade", pkg] };
  return null;
}

/** Where to send someone who has no Python package manager at all. */
export const PYTHON_INSTALL_URL = "https://docs.astral.sh/uv/getting-started/installation/";

/** Ask the machine which of the three it has, then pick one. */
export async function detectInstallCommand(extras: readonly GraphifyExtra[] = []): Promise<InstallCommand | null> {
  const [uv, pipx, pip] = await Promise.all([
    probe("uv --version"),
    probe("pipx --version"),
    probe("pip --version"),
  ]);
  return installCommandFor({ uv, pipx, pip }, extras);
}

/** A failed command as an error: the command, its exit code and the last lines it printed. */
function commandFailed(tokens: string[], res: ProcResult): Error {
  const tail = res.combined.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300);
  return new Error(`${tokens.join(" ")} failed (exit ${res.code}). ${tail}`);
}

/** Install graphify with the manager the machine already has. The UI shows the command first. */
export async function installGraphify(log: Log, extras: readonly GraphifyExtra[] = []): Promise<void> {
  const plan = await detectInstallCommand(extras);
  if (!plan) {
    throw new Error(
      `No Python package manager found (uv, pipx or pip). Install uv first: ${PYTHON_INSTALL_URL}`,
    );
  }
  log(`[assay] ${plan.tokens.join(" ")}\n`);
  const { result } = runTokens(plan.tokens, { onData: (chunk) => log(chunk) });
  const res = await result;
  if (res.code !== 0) throw commandFailed(plan.tokens, res);
}

/** Whether the command is reachable from where Assay spawns processes. */
export async function graphifyInstalled(): Promise<boolean> {
  return probe("graphify --version");
}

/* --------------------------------- summary ---------------------------------- */
const NODES_EDGES = /(\d[\d,]*)\s+nodes?,\s*(\d[\d,]*)\s+edges?/i;

/**
 * One sentence for the run's card. graphify prints counts several times per run; the
 * last is the graph actually written, so the search runs backwards.
 */
export function parseGraphSummary(output: string): string | undefined {
  const lines = output.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = NODES_EDGES.exec(lines[i]);
    if (m) return `${m[1]} nodes · ${m[2]} edges`;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line.slice(0, 200);
  }
  return undefined;
}

/** What the adapter reports when graphify ran but wrote nothing new. */
export function graphSummaryOf(res: ProcResult): string {
  const parsed = parseGraphSummary(res.combined);
  if (parsed) return parsed;
  return res.code === 0 ? "Graph up to date." : `Exited with errors (exit ${res.code}).`;
}

/* ------------------------------- agent skills -------------------------------- */
/**
 * Graphify's skill and hook in each agent. The CLI installs one platform per run and
 * the copy on disk is stamped with its version, so it goes stale silently on upgrade.
 */
export type AgentPlatform = "claude" | "opencode" | "hermes" | "agents";

/** The agents worth offering: Assay's three engines, plus the generic target. */
export const AGENT_PLATFORMS: { id: AgentPlatform; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "opencode", label: "OpenCode" },
  { id: "hermes", label: "Hermes" },
  { id: "agents", label: "Agent Skills" },
];

/** The name of the file graphify stamps beside the skill it wrote. */
const SKILL_FILE = "SKILL.md";
const SKILL_VERSION_FILE = ".graphify_version";

/**
 * Where a platform keeps its user-global skills, mirroring the CLI's
 * `_platform_skill_destination`. `CLAUDE_CONFIG_DIR` is not honoured (the webview
 * cannot read it); the worst case is offering a harmless re-install.
 */
async function agentSkillDir(id: AgentPlatform): Promise<string> {
  const home = await homeDir();
  switch (id) {
    case "opencode":
      return join(home, ".config", "opencode", "skills", "graphify");
    case "hermes":
      // Hermes reads %LOCALAPPDATA%\hermes\skills on Windows, not ~/.hermes
      return (await platform()) === "windows"
        ? join(await localDataDir(), "hermes", "skills", "graphify")
        : join(home, ".hermes", "skills", "graphify");
    case "agents":
      return join(home, ".agents", "skills", "graphify");
    case "claude":
      return join(home, ".claude", "skills", "graphify");
  }
}

export interface AgentSkill {
  id: AgentPlatform;
  label: string;
  /** The folder the skill lives in, shown so the row can be verified. */
  dir: string;
  installed: boolean;
  /** What version wrote it, or null when it predates the stamp. */
  version: string | null;
}

/** Installed and current, installed and behind, installed by an unknown build, or absent. */
export type SkillStanding = "missing" | "stale" | "current" | "unknown";

/** How a skill on disk compares to the package. Only `stale` counts as a fault. */
export function skillStanding(
  skill: { installed: boolean; version: string | null },
  pkg: string | null,
): SkillStanding {
  if (!skill.installed) return "missing";
  if (!skill.version || !pkg) return "unknown";
  return skill.version === pkg ? "current" : "stale";
}

/** How many installed skills are behind the package — the number worth a badge. */
export function staleSkillCount(skills: AgentSkill[], pkg: string | null): number {
  return skills.filter((s) => skillStanding(s, pkg) === "stale").length;
}

/** Ask the folder: is the skill there, and which version wrote it? */
async function readAgentSkill(id: AgentPlatform, label: string): Promise<AgentSkill> {
  const dir = await agentSkillDir(id).catch(() => "");
  const absent: AgentSkill = { id, label, dir, installed: false, version: null };
  if (!dir) return absent;
  try {
    if (!(await exists(await join(dir, SKILL_FILE)))) return absent;
  } catch {
    return absent; // unreadable is not installed, as far as a button is concerned
  }
  let version: string | null = null;
  try {
    version = (await readTextFile(await join(dir, SKILL_VERSION_FILE))).trim() || null;
  } catch {
    version = null; // written by a graphify old enough not to stamp itself
  }
  return { id, label, dir, installed: true, version };
}

/** Every platform at once, in the order they are shown. */
export async function readAgentSkills(): Promise<AgentSkill[]> {
  return Promise.all(AGENT_PLATFORMS.map((p) => readAgentSkill(p.id, p.label)));
}

/** The line that is graphify answering `--version`, not a warning that quotes one. */
const VERSION_LINE = /^graphify\s+(\S+)$/;

/**
 * The installed package's version. `--version` first prints a warning per stale skill
 * that also quotes versions, so only the `graphify <version>` line is read.
 */
export function parseGraphifyVersion(out: string): string | null {
  for (const line of out.split(/\r?\n/)) {
    const m = VERSION_LINE.exec(line.trim());
    if (m) return m[1];
  }
  return null;
}

/** Ask the binary what version it is, or null when it cannot say. */
export async function graphifyVersion(): Promise<string | null> {
  try {
    const res = await runOnce("graphify --version");
    return res.code === 0 ? parseGraphifyVersion(res.combined) : null;
  } catch {
    return null;
  }
}

/** The exact command a row runs, shown before it runs. */
export function agentInstallTokens(id: AgentPlatform): string[] {
  return ["graphify", "install", "--platform", id];
}

/**
 * Install (or refresh) the skill and hook for one agent. Runs from the home directory:
 * a global install still writes some files relative to the cwd (opencode's
 * `.opencode/plugins/graphify.js`), which must never land in the scanned project.
 */
export async function installAgentSkill(id: AgentPlatform, log: Log): Promise<void> {
  const tokens = agentInstallTokens(id);
  const cwd = await homeDir();
  log(`[assay] ${tokens.join(" ")}\n`);
  const { result } = runTokens(tokens, { cwd, onData: (chunk) => log(chunk) });
  const res = await result;
  if (res.code !== 0) throw commandFailed(tokens, res);
}
