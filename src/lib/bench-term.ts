import { join, localDataDir } from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";
import { platform } from "@tauri-apps/plugin-os";
import { resolveBin, type BinId } from "@/lib/agent-bins";
import * as db from "@/lib/db";
import { probe, runOnce } from "@/lib/exec";

/** What a Bench terminal tab starts as. */
export type TermKind = "shell" | "claude" | "opencode" | "hermes";

export interface TermLauncher {
  kind: TermKind;
  label: string;
  /** The binary behind the agent, resolved by `agent-bins`; the shell has none. */
  bin?: BinId;
  /**
   * What follows the binary when the agent starts on a prompt. Receives the shell's
   * reference to the prompt variable, never the prompt text itself.
   */
  promptArgs?: (ref: string) => string;
}

export const LAUNCHERS: TermLauncher[] = [
  { kind: "shell", label: "Shell" },
  { kind: "claude", label: "Claude", bin: "claude", promptArgs: (r) => r },
  // opencode takes a one-shot message through `run`; the bare binary is its TUI
  { kind: "opencode", label: "OpenCode", bin: "opencode", promptArgs: (r) => `run ${r}` },
  { kind: "hermes", label: "Hermes", bin: "hermes", promptArgs: (r) => r },
];

/* --------------------------------- shells ---------------------------------- */
/** How the shell has to be told to run something and then stay open. */
export type ShellFamily = "bash" | "powershell" | "cmd";

export interface ShellSpec {
  program: string;
  label: string;
  family: ShellFamily;
}

/** Stored preference: one of these ids, or an absolute path to a shell. */
export type ShellPreference = "auto" | "gitbash" | "pwsh" | "powershell" | "cmd" | (string & {});

export const SHELL_SETTING = "bench.shell";

/** Where Git for Windows puts its bash, in the order it is usually found. */
const GIT_BASH_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

/** Git installed per user lands under %LOCALAPPDATA%\Programs\Git. */
async function localAppDataGitBash(): Promise<string | null> {
  try {
    return await join(await localDataDir(), "Programs", "Git", "bin", "bash.exe");
  } catch {
    return null;
  }
}

/** Git Bash, found by its usual homes and then by asking git where it lives. */
async function findGitBash(): Promise<string | null> {
  const candidates = [...GIT_BASH_PATHS];
  const perUser = await localAppDataGitBash();
  if (perUser) candidates.push(perUser);
  for (const c of candidates) {
    if (await exists(c).catch(() => false)) return c;
  }
  // last resort: `where git` gives …\Git\cmd\git.exe, and bash sits in …\Git\bin
  try {
    const res = await runOnce("where git");
    const line = res.stdout.split(/\r?\n/).find((l) => l.trim().toLowerCase().endsWith("git.exe"));
    if (line) {
      const root = line.trim().replace(/\\cmd\\git\.exe$/i, "").replace(/\\bin\\git\.exe$/i, "");
      const bash = `${root}\\bin\\bash.exe`;
      if (await exists(bash).catch(() => false)) return bash;
    }
  } catch {
    /* git isn't installed */
  }
  return null;
}

function familyOf(program: string): ShellFamily {
  const base = program.toLowerCase().split(/[\\/]/).pop() ?? program;
  if (base.startsWith("pwsh") || base.startsWith("powershell")) return "powershell";
  if (base.startsWith("cmd")) return "cmd";
  return "bash";
}

function labelOf(program: string): string {
  const base = program.toLowerCase().split(/[\\/]/).pop() ?? program;
  if (base.startsWith("bash")) return "Git Bash";
  if (base.startsWith("pwsh")) return "PowerShell";
  if (base.startsWith("powershell")) return "Windows PowerShell";
  if (base.startsWith("cmd")) return "cmd";
  return base;
}

async function autoShell(): Promise<ShellSpec> {
  if ((await platform()) === "windows") {
    // Git Bash first: POSIX syntax is what the user writes everywhere else
    const gitBash = await findGitBash();
    if (gitBash) return { program: gitBash, label: "Git Bash", family: "bash" };
    if (await probe("pwsh -NoLogo -Command exit")) {
      return { program: "pwsh.exe", label: "PowerShell", family: "powershell" };
    }
    if (await probe("powershell -NoLogo -Command exit")) {
      return { program: "powershell.exe", label: "Windows PowerShell", family: "powershell" };
    }
    return { program: "cmd.exe", label: "cmd", family: "cmd" };
  }
  if (await probe("command -v bash")) return { program: "bash", label: "bash", family: "bash" };
  return { program: "sh", label: "sh", family: "bash" };
}

let cached: Promise<ShellSpec> | null = null;

/** Forget the resolved shell, so the next terminal picks up a changed setting. */
export function resetShellCache(): void {
  cached = null;
}

/**
 * The shell Bench opens: what the user chose in Settings, or the best one found.
 * Windows Terminal is absent on purpose: it is an emulator, not a shell.
 */
export function resolveShell(): Promise<ShellSpec> {
  if (!cached) {
    cached = (async () => {
      const pref = ((await db.getSetting(SHELL_SETTING)) ?? "auto") as ShellPreference;
      if (!pref || pref === "auto") return autoShell();
      if (pref === "gitbash") {
        const gitBash = await findGitBash();
        return gitBash
          ? { program: gitBash, label: "Git Bash", family: "bash" as const }
          : autoShell();
      }
      if (pref === "pwsh") return { program: "pwsh.exe", label: "PowerShell", family: "powershell" };
      if (pref === "powershell") {
        return { program: "powershell.exe", label: "Windows PowerShell", family: "powershell" };
      }
      if (pref === "cmd") return { program: "cmd.exe", label: "cmd", family: "cmd" };
      // anything else is a path the user typed
      return { program: pref, label: labelOf(pref), family: familyOf(pref) };
    })();
  }
  return cached;
}

/**
 * Arguments that start the shell and optionally run a command in it. The command is
 * an argument, never typed into the PTY: input sent before the line editor is up is
 * swallowed. The shell also stays alive after the command exits.
 */
export function shellArgs(shell: ShellSpec, command?: string): string[] {
  if (!command) {
    if (shell.family === "bash") return ["-l"];
    return shell.family === "powershell" ? ["-NoLogo"] : [];
  }
  switch (shell.family) {
    case "bash":
      return ["-l", "-c", `${command}; exec "$0" -l`, shell.program];
    case "powershell":
      return ["-NoLogo", "-NoExit", "-Command", command];
    case "cmd":
      return ["/k", command];
  }
}

/* ------------------------------- the prompt -------------------------------- */
/**
 * The variable a skill's prompt travels in. Never quoted into the command line:
 * MSYS2 programs re-parse it and eat the escaping (an apostrophe broke bash).
 * Left set on purpose so `echo $ASSAY_PROMPT` shows what was sent.
 */
const PROMPT_ENV = "ASSAY_PROMPT";

/** How each shell reads a variable back as one whole argument. */
function envRef(shell: ShellSpec, name: string): string {
  switch (shell.family) {
    case "bash":
      return `"$${name}"`;
    case "powershell":
      return `$env:${name}`;
    case "cmd":
      return `"%${name}%"`;
  }
}

const promptRef = (shell: ShellSpec): string => envRef(shell, PROMPT_ENV);

/**
 * The settings file with Assay's hooks, for `claude --settings`. In the environment
 * for the same MSYS2 reason: the temp path can hold a space.
 */
const CLAUDE_SETTINGS_ENV = "ASSAY_CLAUDE_SETTINGS";
/** Which terminal a hook fired in, and where it writes to say so. */
const PTY_ID_ENV = "ASSAY_PTY_ID";
const SIGNAL_DIR_ENV = "ASSAY_SIGNAL_DIR";

/** A project script line, also in the environment to avoid MSYS2 re-quoting. */
export const COMMAND_ENV = "ASSAY_COMMAND";

/**
 * What the shell runs to execute that variable and then stay open. In bash the
 * `trap` keeps Ctrl+C from also ending the `bash -c` waiting on the script; the
 * child still gets the signal since traps reset across exec.
 */
export function scriptShellCommand(shell: ShellSpec): string {
  switch (shell.family) {
    case "bash":
      return `trap : INT; eval "$${COMMAND_ENV}"; trap - INT`;
    case "powershell":
      return `Invoke-Expression $env:${COMMAND_ENV}`;
    case "cmd":
      return `%${COMMAND_ENV}%`;
  }
}

/** What a terminal's environment needs for the hook to find its way back. */
export function signalEnv(ptyId: string, dir: string, settings: string): Record<string, string> {
  return { [PTY_ID_ENV]: ptyId, [SIGNAL_DIR_ENV]: dir, [CLAUDE_SETTINGS_ENV]: settings };
}

/**
 * The environment a session starts with, when it starts on a prompt. Flattened for
 * cmd only: `%VAR%` is expanded textually, so a newline or quote would break it.
 */
export function promptEnv(shell: ShellSpec, prompt?: string): Record<string, string> | undefined {
  const text = prompt?.trim();
  if (!text) return undefined;
  const value = shell.family === "cmd" ? text.replace(/[\r\n]+/g, " ").replace(/"/g, "'") : text;
  return { [PROMPT_ENV]: value };
}

/**
 * The binary as this shell has to be given it. A bare name stays bare; a full
 * path — an agent found outside PATH — takes bash's forward slashes, and quotes
 * only when a space forces them (PowerShell then needs `&` to call a string).
 */
export function binForShell(shell: ShellSpec, bin: string): string {
  const path = shell.family === "bash" ? bin.replace(/\\/g, "/") : bin;
  if (!/\s/.test(path)) return path;
  switch (shell.family) {
    case "bash":
      return `'${path.replace(/'/g, `'\\''`)}'`;
    case "powershell":
      return `& '${path.replace(/'/g, "''")}'`;
    case "cmd":
      return `"${path}"`;
  }
}

/**
 * What the shell runs to start an agent, optionally already working on a prompt.
 * Undefined for a plain shell, which starts as itself. `bin` is where the agent
 * was found; without it the launcher's own name is used.
 */
export function agentCommand(
  shell: ShellSpec,
  kind: TermKind,
  prompt?: string,
  bin?: string,
  opts?: { hooks?: boolean },
): string | undefined {
  const launcher = LAUNCHERS.find((l) => l.kind === kind);
  if (!launcher?.bin) return undefined;
  // only Claude has a hook that says a turn ended; the file comes from `signalEnv`
  const settings = opts?.hooks && kind === "claude" ? ` --settings ${envRef(shell, CLAUDE_SETTINGS_ENV)}` : "";
  const command = binForShell(shell, bin ?? launcher.bin) + settings;
  if (!prompt?.trim() || !launcher.promptArgs) return command;
  return `${command} ${launcher.promptArgs(promptRef(shell))}`;
}

/* ------------------------------ dropped paths ------------------------------ */
/** Characters a shell would read as something other than part of a word. */
const NEEDS_QUOTES = /[^A-Za-z0-9@%+=:,./_-]/;

/** One path, quoted for a live shell line (typed, not spawned, so plain quoting works). */
function quotePath(shell: ShellSpec, path: string): string {
  if (!NEEDS_QUOTES.test(path)) return path;
  switch (shell.family) {
    case "bash":
      // a single-quoted string ends, takes an escaped quote, and starts again
      return `'${path.replace(/'/g, `'\\''`)}'`;
    case "powershell":
      return `'${path.replace(/'/g, "''")}'`;
    case "cmd":
      return `"${path.replace(/"/g, "'")}"`;
  }
}

/** A path slash separated, and relative to the session's cwd when it lies underneath. */
export function terminalPath(cwd: string, path: string): string {
  const slash = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const file = slash(path);
  const root = slash(cwd);
  if (!root) return file;
  const prefix = `${root}/`;
  return file.toLowerCase().startsWith(prefix.toLowerCase()) ? file.slice(prefix.length) : file;
}

/**
 * What dropping files on a terminal types: the paths, space separated, with a
 * trailing space so the line can go on. Never a newline — nothing is executed.
 */
export function droppedPathText(shell: ShellSpec, cwd: string, paths: string[]): string {
  const words = paths.map((p) => quotePath(shell, terminalPath(cwd, p)));
  return words.length ? `${words.join(" ")} ` : "";
}

/** Which launchers can actually run here, so the menu can grey out the rest. */
export async function availableLaunchers(): Promise<Record<TermKind, boolean>> {
  const entries = await Promise.all(
    LAUNCHERS.map(async (l) => [l.kind, l.bin ? (await resolveBin(l.bin)).command !== null : true] as const),
  );
  return Object.fromEntries(entries) as Record<TermKind, boolean>;
}

/** Options for the Settings picker. */
export const SHELL_OPTIONS: { value: string; label: string; hint?: string }[] = [
  { value: "auto", label: "Automatic", hint: "Git Bash, then PowerShell, then cmd" },
  { value: "gitbash", label: "Git Bash" },
  { value: "pwsh", label: "PowerShell (pwsh)" },
  { value: "powershell", label: "Windows PowerShell" },
  { value: "cmd", label: "cmd" },
];
