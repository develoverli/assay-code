import { Command, type Child } from "@tauri-apps/plugin-shell";
import { platform } from "@tauri-apps/plugin-os";

export type StreamKind = "stdout" | "stderr";

export interface ProcHandle {
  kill: () => Promise<void>;
}

export interface RunProcOpts {
  cwd?: string;
  onData?: (chunk: string, stream: StreamKind) => void;
  env?: Record<string, string>;
}

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  combined: string;
  killed: boolean;
}

let _plat: string | null = null;
async function getPlat(): Promise<string> {
  if (!_plat) _plat = await platform();
  return _plat;
}

function spawnOpts(cwd?: string, env?: Record<string, string>): Record<string, unknown> {
  // encoding:"raw" → data events are bytes, so we decode leniently and never
  // crash on non-UTF-8 output (Windows console box-drawing, ANSI, etc.).
  const opts = { encoding: "raw" } as Record<string, unknown>;
  if (cwd) opts.cwd = cwd;
  if (env && Object.keys(env).length) opts.env = env;
  return opts;
}

/** Wrap a raw command string in the platform shell so any binary + args works. */
async function buildShell(cmdStr: string, cwd?: string, env?: Record<string, string>): Promise<Command<Uint8Array>> {
  const p = await getPlat();
  const opts = spawnOpts(cwd, env);
  const c =
    p === "windows"
      ? Command.create("cmd", ["/c", cmdStr], opts)
      : Command.create("sh", ["-c", cmdStr], opts);
  return c as unknown as Command<Uint8Array>;
}

/**
 * Run a binary with an argv array, with NO shell in between. Use it whenever an
 * argument can hold spaces or quotes: through `cmd /c`, Rust escapes inner double
 * quotes as \", which cmd rejects.
 */
function buildProgram(program: string, args: string[], cwd?: string, env?: Record<string, string>): Command<Uint8Array> {
  return Command.create(program, args, spawnOpts(cwd, env)) as unknown as Command<Uint8Array>;
}

/**
 * Spawn a shell command with live streaming. Returns a promise for the final
 * result plus a handle to kill the running process.
 */
export function runProcess(
  cmdStr: string,
  opts: RunProcOpts = {},
): { result: Promise<ProcResult>; handle: ProcHandle } {
  return spawn(() => buildShell(cmdStr, opts.cwd, opts.env), opts);
}

/**
 * Same streaming contract as `runProcess`, but spawns `program` directly with an
 * argv array instead of going through a shell. Prefer it when any argument may
 * contain spaces (e.g. a project path).
 */
export function runProgram(
  program: string,
  args: string[],
  opts: RunProcOpts = {},
): { result: Promise<ProcResult>; handle: ProcHandle } {
  return spawn(async () => buildProgram(program, args, opts.cwd, opts.env), opts);
}

/**
 * Run an already-tokenized command with the shell as a launcher, never a parser:
 * each token is its own argument. The shell is needed because npm's Windows
 * `.cmd` shims (`npx`, `pnpm`, `claude`) can't be launched by CreateProcess.
 */
export function runTokens(
  tokens: string[],
  opts: RunProcOpts = {},
): { result: Promise<ProcResult>; handle: ProcHandle } {
  return spawn(async () => {
    const p = await getPlat();
    return p === "windows"
      ? buildProgram("cmd", ["/c", ...tokens], opts.cwd, opts.env)
      : buildProgram("sh", ["-c", 'exec "$0" "$@"', ...tokens], opts.cwd, opts.env);
  }, opts);
}

/**
 * POSIX script that signals `pid` and every descendant. The plugin spawns without
 * setsid, so the child leads no process group and `kill -TERM -pid` hits nothing:
 * the tree is collected from `ps` first (before a dying parent orphans its children),
 * TERMed, and whatever survives two seconds is KILLed.
 */
export function unixKillTreeScript(pid: number): string {
  return [
    `pids=""`,
    `t() { pids="$pids $1"; for c in $(ps -A -o pid= -o ppid= | awk -v p="$1" '$2==p{print $1}'); do t "$c"; done; }`,
    `t ${pid}`,
    `kill -TERM $pids 2>/dev/null`,
    `sleep 2`,
    `kill -KILL $pids 2>/dev/null`,
    `true`,
  ].join("; ");
}

/** Kill a child and its whole tree: strix/docker leave children (PTYs) alive otherwise. */
async function killTree(child: Child): Promise<void> {
  try {
    const p = await getPlat();
    if (p === "windows" && typeof child.pid === "number") {
      await runProcess(`taskkill /F /T /PID ${child.pid}`).result;
    } else if (typeof child.pid === "number") {
      await runProcess(unixKillTreeScript(child.pid)).result;
    } else {
      await child.kill();
    }
  } catch {
    try {
      await child.kill();
    } catch {
      /* already gone */
    }
  }
}

function spawn(
  build: () => Promise<Command<Uint8Array>>,
  opts: RunProcOpts,
): { result: Promise<ProcResult>; handle: ProcHandle } {
  let child: Child | null = null;
  let killed = false;

  const handle: ProcHandle = {
    kill: async () => {
      killed = true;
      // not spawned yet: `killed` is the pending kill, applied once the child exists
      if (!child) return;
      await killTree(child);
    },
  };

  const result = (async (): Promise<ProcResult> => {
    let stdout = "";
    let stderr = "";
    let combined = "";
    const cmd = await build();
    const decOut = new TextDecoder("utf-8", { fatal: false });
    const decErr = new TextDecoder("utf-8", { fatal: false });

    const toBytes = (d: unknown): Uint8Array => {
      if (d instanceof Uint8Array) return d;
      return Array.isArray(d) ? new Uint8Array(d) : new Uint8Array();
    };

    cmd.stdout.on("data", (chunk: Uint8Array) => {
      const s = decOut.decode(toBytes(chunk), { stream: true });
      if (!s) return;
      stdout += s;
      combined += s;
      opts.onData?.(s, "stdout");
    });
    cmd.stderr.on("data", (chunk: Uint8Array) => {
      const s = decErr.decode(toBytes(chunk), { stream: true });
      if (!s) return;
      stderr += s;
      combined += s;
      opts.onData?.(s, "stderr");
    });

    return await new Promise<ProcResult>((resolve, reject) => {
      cmd.on("close", (data: { code: number | null }) => {
        resolve({ code: killed ? -1 : data.code, stdout, stderr, combined, killed });
      });
      cmd.on("error", (err: string) => reject(new Error(String(err))));
      cmd.spawn().then((c) => {
        child = c;
        if (killed) void killTree(c);
      }).catch(reject);
    });
  })();

  return { result, handle };
}

/** Run a command to completion and return combined output (no streaming). */
export async function runOnce(cmdStr: string, cwd?: string): Promise<ProcResult> {
  return runProcess(cmdStr, { cwd }).result;
}

/** `runOnce` without a shell — for arguments that may contain spaces. */
export async function runProgramOnce(
  program: string,
  args: string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<ProcResult> {
  return runProgram(program, args, { cwd, env }).result;
}

/** One POSIX shell word: single-quoted, with each `'` closed, escaped and reopened. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** An AppleScript string literal: only `\` and `"` need escaping inside the quotes. */
export function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The `sh -c` line `openTerminal` runs on macOS / Linux, with `command` quoted for each layer. */
export function unixTerminalScript(plat: string, command: string): string {
  if (plat === "macos") {
    return `osascript -e ${shQuote(`tell app "Terminal" to do script ${appleScriptString(command)}`)}`;
  }
  const inner = shQuote(`${command}; exec bash`);
  return `x-terminal-emulator -e sh -c ${inner} || xterm -e sh -c ${inner}`;
}

/**
 * Launch a command in a NEW external terminal window (for interactive TUI tools
 * like strix that can't run inside the app's log panel). Fire-and-forget.
 */
export async function openTerminal(command: string, cwd?: string, env?: Record<string, string>): Promise<void> {
  const p = await getPlat();
  const opts: { cwd?: string; env?: Record<string, string> } = {};
  if (cwd) opts.cwd = cwd;
  if (env && Object.keys(env).length) opts.env = env;
  if (p === "windows") {
    // `start cmd /k <command>` opens a new console that stays open; env + cwd inherit.
    await Command.create("cmd", ["/c", `start cmd /k ${command}`], opts).spawn();
  } else {
    await Command.create("sh", ["-c", unixTerminalScript(p, command)], opts).spawn();
  }
}

/** Check whether a binary responds (e.g. `docker --version`). */
export async function probe(cmdStr: string): Promise<boolean> {
  try {
    const r = await runOnce(cmdStr);
    return r.code === 0;
  } catch {
    return false;
  }
}
