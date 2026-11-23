import { dataDir, homeDir, localDataDir } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";
import { platform } from "@tauri-apps/plugin-os";
import * as db from "@/lib/db";
import { probe } from "@/lib/exec";

/**
 * Where the AI CLIs actually live. Probes go through `cmd /c`, which sees only the
 * Windows PATH, and some installers never write there (opencode adds its bin to
 * `~/.profile`, read only by Git Bash). Order: user-set path, PATH, known homes.
 */
export type BinId = "claude" | "opencode" | "hermes" | "ollama" | "lms";

export interface BinDirs {
  home: string;
  /** %LOCALAPPDATA% on Windows. */
  localData: string;
  /** %APPDATA% (Roaming) on Windows. */
  roaming: string;
}

export interface ResolvedBin {
  id: BinId;
  /** What goes first on a command line: the bare name when PATH has it, else the full path. */
  command: string | null;
  /** Where it was found, for the Toolchain row. */
  source: "custom" | "path" | "known" | null;
}

const slash = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** The files each installer leaves behind, most likely first. */
export function knownBinPaths(id: BinId, windows: boolean, d: BinDirs): string[] {
  const home = slash(d.home);
  const local = slash(d.localData);
  const roaming = slash(d.roaming);
  if (windows) {
    switch (id) {
      case "claude":
        return [`${home}/.local/bin/claude.exe`, `${roaming}/npm/claude.cmd`, `${home}/.claude/local/claude.exe`];
      case "opencode":
        return [
          `${home}/.opencode/bin/opencode.exe`,
          `${roaming}/npm/opencode.cmd`,
          `${home}/.bun/bin/opencode.exe`,
          `${home}/scoop/shims/opencode.exe`,
        ];
      case "hermes":
        return [`${local}/hermes/bin/hermes.exe`, `${home}/.local/bin/hermes.exe`];
      case "ollama":
        return [`${local}/Programs/Ollama/ollama.exe`];
      case "lms":
        return [`${home}/.lmstudio/bin/lms.exe`, `${home}/.cache/lm-studio/bin/lms.exe`];
    }
  }
  const common = [`${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", `${home}/.npm-global/bin`];
  switch (id) {
    case "claude":
      return [...common, `${home}/.claude/local`].map((dir) => `${dir}/claude`);
    case "opencode":
      return [`${home}/.opencode/bin`, `${home}/.bun/bin`, ...common].map((dir) => `${dir}/opencode`);
    case "hermes":
      return [...common, `${home}/.hermes/bin`].map((dir) => `${dir}/hermes`);
    case "ollama":
      return [...common, "/usr/bin"].map((dir) => `${dir}/ollama`);
    case "lms":
      return [`${home}/.lmstudio/bin`, `${home}/.cache/lm-studio/bin`, ...common].map((dir) => `${dir}/lms`);
  }
}

export function customPathKey(id: BinId): string {
  return `bin.${id}`;
}

let dirsCache: Promise<{ windows: boolean; dirs: BinDirs }> | null = null;

function machine(): Promise<{ windows: boolean; dirs: BinDirs }> {
  if (!dirsCache) {
    dirsCache = (async () => {
      const [plat, home, localData, roaming] = await Promise.all([
        platform(),
        homeDir(),
        localDataDir().catch(() => ""),
        dataDir().catch(() => ""),
      ]);
      return { windows: plat === "windows", dirs: { home, localData, roaming } };
    })();
  }
  return dirsCache;
}

const fileExists = (p: string): Promise<boolean> => exists(p).catch(() => false);

/** cmd's `start` and friends read a forward slash as a switch, so Windows gets its own separator. */
function native(p: string, windows: boolean): string {
  return windows ? p.replace(/\//g, "\\") : p;
}

async function resolveNow(id: BinId): Promise<ResolvedBin> {
  const { windows, dirs } = await machine();
  const custom = ((await db.getSetting(customPathKey(id))) ?? "").trim();
  if (custom && (await fileExists(custom))) return { id, command: native(slash(custom), windows), source: "custom" };
  if (await probe(`${id} --version`)) return { id, command: id, source: "path" };
  for (const candidate of knownBinPaths(id, windows, dirs)) {
    const path = native(candidate, windows);
    if (await fileExists(path)) return { id, command: path, source: "known" };
  }
  return { id, command: null, source: null };
}

const cache = new Map<BinId, Promise<ResolvedBin>>();

/**
 * One answer per binary per session, shared by every caller asking at once.
 * `refresh` forgets it — a Re-check, an install, or a path typed in Settings.
 */
export function resolveBin(id: BinId, refresh = false): Promise<ResolvedBin> {
  let hit = cache.get(id);
  if (!hit || refresh) {
    hit = resolveNow(id);
    cache.set(id, hit);
  }
  return hit;
}

/** The command for `id`, falling back to the bare name so the error names it. */
export async function binCommand(id: BinId): Promise<string> {
  return (await resolveBin(id)).command ?? id;
}
