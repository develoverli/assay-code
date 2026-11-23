import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * The front half of the PTY sessions that live in Rust (`src-tauri/src/pty.rs`).
 *
 * Sessions are addressed by an id this side chooses, and they outlive the React
 * tree: unmounting a terminal detaches the view, it never kills the process.
 */

export interface PtyDataEvent {
  id: string;
  data: string;
}

export interface PtySpawnOpts {
  id: string;
  program: string;
  args?: string[];
  cwd?: string;
  /**
   * Extra environment for the child. A skill's prompt rides here instead of in
   * the command line: MSYS2 re-parses a Windows command line on its own and
   * eats shell quoting, so the only argument that survives is one nobody quotes.
   */
  env?: Record<string, string>;
  cols: number;
  rows: number;
  /** Carried by Rust so a reloaded webview can rebuild this tab. */
  title?: string;
  kind?: string;
  /** The project this session belongs to; Rust holds it so a reload restores it. */
  projectId?: string | null;
}

/** A session Rust is still holding, with what the UI needs to show it. */
export interface PtySession {
  id: string;
  title: string;
  /** The name it was spawned with, which clearing a rename returns to. */
  defaultTitle: string;
  kind: string;
  cwd: string;
  /** Null for sessions spawned before Assay tracked the project, or by an older build. */
  projectId: string | null;
  alive: boolean;
}

export async function ptySpawn(opts: PtySpawnOpts): Promise<void> {
  await invoke("pty_spawn", {
    id: opts.id,
    program: opts.program,
    args: opts.args ?? [],
    cwd: opts.cwd ?? null,
    env: opts.env ?? null,
    cols: Math.max(1, Math.round(opts.cols)),
    rows: Math.max(1, Math.round(opts.rows)),
    title: opts.title ?? null,
    kind: opts.kind ?? null,
    projectId: opts.projectId ?? null,
  });
}

export async function ptyWrite(id: string, data: string): Promise<void> {
  await invoke("pty_write", { id, data });
}

export async function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  await invoke("pty_resize", { id, cols: Math.max(1, Math.round(cols)), rows: Math.max(1, Math.round(rows)) });
}

export async function ptyScrollback(id: string): Promise<string> {
  return invoke<string>("pty_scrollback", { id });
}

export async function ptyKill(id: string): Promise<void> {
  await invoke("pty_kill", { id });
}

/** Rename a session; an empty title restores its original name. Resolves to the name it now has. */
export async function ptyRename(id: string, title: string): Promise<string> {
  return invoke<string>("pty_rename", { id, title });
}

export async function ptyList(): Promise<PtySession[]> {
  return invoke<PtySession[]>("pty_list");
}

/** Output from one session. The listener is global; filter by id. */
export function onPtyData(fn: (e: PtyDataEvent) => void): Promise<UnlistenFn> {
  return listen<PtyDataEvent>("pty://data", (e) => fn(e.payload));
}

/** Fires when a session's process ends on its own (the user typed `exit`, a crash…). */
export function onPtyExit(fn: (id: string) => void): Promise<UnlistenFn> {
  return listen<{ id: string }>("pty://exit", (e) => fn(e.payload.id));
}
