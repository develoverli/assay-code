import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * The front half of `src-tauri/src/agent_signals.rs`: Claude's `Stop` hook and status
 * line as events per Workspace terminal, via `claude --settings <file>`. The user's own
 * Claude settings are never written.
 */

export interface AgentSignalPaths {
  /** The folder the hook drops its files into. */
  dir: string;
  /** The settings file `claude --settings` points at. */
  settings: string;
}

/** A Claude turn ended in terminal `id`; `message` is the first line of its answer. */
export interface AgentStop {
  id: string;
  message: string | null;
}

let paths: Promise<AgentSignalPaths | null> | null = null;

/** Set up once per session. Null when it could not be: terminals then open without the hook. */
export function agentSignalPaths(): Promise<AgentSignalPaths | null> {
  paths ??= invoke<AgentSignalPaths>("agent_signals").catch(() => null);
  return paths;
}

/** One plan window as Claude reports it. */
export interface LimitWindow {
  usedPercentage: number;
  /** Epoch seconds. */
  resetsAt: number;
}

/** One status line update from terminal `id`; every part may be missing. */
export interface AgentStatus {
  id: string;
  fiveHour: LimitWindow | null;
  sevenDay: LimitWindow | null;
  context: { usedPercentage: number; usedTokens: number | null; size: number | null } | null;
}

export function onAgentStatus(fn: (e: AgentStatus) => void): Promise<UnlistenFn> {
  return listen<AgentStatus>("agent://status", (e) => fn(e.payload));
}

export function onAgentStop(fn: (e: AgentStop) => void): Promise<UnlistenFn> {
  return listen<AgentStop>("agent://stop", (e) => fn(e.payload));
}
