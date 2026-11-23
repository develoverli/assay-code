import { platform } from "@tauri-apps/plugin-os";
import { resolveBin, type BinId, type ResolvedBin } from "@/lib/agent-bins";
import { probe, runTokens, type ProcHandle, type ProcResult } from "@/lib/exec";

/**
 * What Assay needs on the machine, and how each piece gets there. Installs only use
 * a package manager the user already has; piped install scripts (Hermes) and admin
 * installers (Docker Desktop) get a link and a command to copy instead.
 */
export type ToolchainId = "node" | "git" | "claude" | "opencode" | "hermes" | "ollama" | "lmstudio" | "docker" | "strix";

export type OS = "windows" | "macos" | "linux";

export interface ToolchainEntry {
  id: ToolchainId;
  label: string;
  hint: string;
  /** Resolved through `agent-bins`, so a binary outside PATH still counts. */
  bin?: BinId;
  /** Probed on PATH when there is no `bin`. */
  probeCmd?: string;
  /** A runtime whose server can be off while the binary is there. */
  runtime?: "ollama" | "lmstudio";
}

export const TOOLCHAIN: ToolchainEntry[] = [
  { id: "node", label: "Node / npx", probeCmd: "node -v", hint: "runs react-doctor & unlighthouse" },
  { id: "git", label: "Git", probeCmd: "git --version", hint: "diff capture for AI edits" },
  { id: "claude", label: "Claude CLI", bin: "claude", hint: "agentic fix · uses your Claude account" },
  { id: "opencode", label: "opencode", bin: "opencode", hint: "agentic fix (any configured model)" },
  { id: "hermes", label: "Hermes", bin: "hermes", hint: "agentic fix — Nous Research agent, then `hermes setup`" },
  { id: "ollama", label: "Ollama", bin: "ollama", runtime: "ollama", hint: "local models over HTTP" },
  { id: "lmstudio", label: "LM Studio", bin: "lms", runtime: "lmstudio", hint: "local models over HTTP" },
  {
    id: "docker",
    label: "Docker",
    probeCmd: "docker --version",
    hint: "required by strix and SonarQube (needs docker.exe on PATH, not only WSL)",
  },
  { id: "strix", label: "Strix", probeCmd: "strix --version", hint: "AI pentest agent — docker + LLM key" },
];

export interface Managers {
  npm: boolean;
  winget: boolean;
  brew: boolean;
  uv: boolean;
  pipx: boolean;
}

export type InstallRecipe =
  | { kind: "command"; tokens: string[] }
  /** `command` is offered to copy; absent when there is no single line to give. */
  | { kind: "manual"; url: string; command?: string };

const URLS: Record<ToolchainId, string> = {
  node: "https://nodejs.org/en/download",
  git: "https://git-scm.com/downloads",
  claude: "https://docs.claude.com/en/docs/claude-code/setup",
  opencode: "https://opencode.ai/docs/",
  hermes: "https://hermes-agent.nousresearch.com",
  ollama: "https://ollama.com/download",
  lmstudio: "https://lmstudio.ai/download",
  docker: "https://docs.docker.com/get-started/get-docker/",
  strix: "https://github.com/usestrix/strix",
};

const WINGET_IDS: Partial<Record<ToolchainId, string>> = {
  node: "OpenJS.NodeJS.LTS",
  git: "Git.Git",
  ollama: "Ollama.Ollama",
  lmstudio: "ElementLabs.LMStudio",
};

const BREW: Partial<Record<ToolchainId, string[]>> = {
  node: ["node"],
  git: ["git"],
  ollama: ["ollama"],
  lmstudio: ["--cask", "lm-studio"],
};

const NPM_PACKAGES: Partial<Record<ToolchainId, string>> = {
  claude: "@anthropic-ai/claude-code",
  opencode: "opencode-ai",
};

function urlOf(id: ToolchainId): string {
  for (const [k, v] of Object.entries(URLS)) if (k === id) return v;
  return URLS.node;
}

function lookup<T>(table: Partial<Record<ToolchainId, T>>, id: ToolchainId): T | undefined {
  for (const [k, v] of Object.entries(table)) if (k === id) return v as T;
  return undefined;
}

/** How to get one tool onto this machine. */
export function installRecipe(id: ToolchainId, os: OS, has: Managers): InstallRecipe {
  const url = urlOf(id);

  if (id === "hermes") {
    return os === "windows"
      ? { kind: "manual", url }
      : { kind: "manual", url, command: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash" };
  }
  if (id === "docker") {
    if (os === "windows") return { kind: "manual", url, command: "winget install -e --id Docker.DockerDesktop" };
    if (os === "macos") return { kind: "manual", url, command: "brew install --cask docker" };
    return { kind: "manual", url };
  }

  const npmPackage = lookup(NPM_PACKAGES, id);
  if (npmPackage) {
    const tokens = ["npm", "install", "-g", npmPackage];
    return has.npm ? { kind: "command", tokens } : { kind: "manual", url, command: tokens.join(" ") };
  }

  if (id === "strix") {
    if (has.uv) return { kind: "command", tokens: ["uv", "tool", "install", "strix-agent"] };
    if (has.pipx) return { kind: "command", tokens: ["pipx", "install", "strix-agent"] };
    return { kind: "manual", url, command: "uv tool install strix-agent" };
  }

  const wingetId = lookup(WINGET_IDS, id);
  if (os === "windows" && wingetId) {
    const tokens = [
      "winget",
      "install",
      "-e",
      "--id",
      wingetId,
      "--accept-source-agreements",
      "--accept-package-agreements",
    ];
    return has.winget ? { kind: "command", tokens } : { kind: "manual", url, command: tokens.join(" ") };
  }
  const brew = lookup(BREW, id);
  if (os === "macos" && brew) {
    const tokens = ["brew", "install", ...brew];
    return has.brew ? { kind: "command", tokens } : { kind: "manual", url, command: tokens.join(" ") };
  }
  return { kind: "manual", url };
}

let managers: Promise<Managers> | null = null;

export function detectManagers(refresh = false): Promise<Managers> {
  if (!managers || refresh) {
    managers = (async () => {
      const [npm, winget, brew, uv, pipx] = await Promise.all([
        probe("npm --version"),
        probe("winget --version"),
        probe("brew --version"),
        probe("uv --version"),
        probe("pipx --version"),
      ]);
      return { npm, winget, brew, uv, pipx };
    })();
  }
  return managers;
}

export async function currentOS(): Promise<OS> {
  const p = await platform();
  if (p === "windows") return "windows";
  if (p === "macos") return "macos";
  return "linux";
}

export interface ToolchainStatus {
  installed: boolean;
  /** Where the binary was found, when that is not simply PATH. */
  path?: string;
  resolved?: ResolvedBin;
}

export async function probeEntry(entry: ToolchainEntry, refresh = false): Promise<ToolchainStatus> {
  if (entry.bin) {
    const resolved = await resolveBin(entry.bin, refresh);
    return {
      installed: resolved.command !== null,
      path: resolved.source === "path" ? undefined : (resolved.command ?? undefined),
      resolved,
    };
  }
  return { installed: entry.probeCmd ? await probe(entry.probeCmd) : false };
}

/** Run an install recipe, streaming its output line by line. */
export function runInstall(
  tokens: string[],
  onData: (chunk: string) => void,
): { result: Promise<ProcResult>; handle: ProcHandle } {
  return runTokens(tokens, { onData: (chunk) => onData(chunk) });
}
