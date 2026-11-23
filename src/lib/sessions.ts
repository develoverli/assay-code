import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";

/**
 * Claude Code transcripts already on disk for a project
 * (`~/.claude/projects/<slugged path>/*.jsonl`). Rust summarises them, since a
 * transcript runs to megabytes.
 */

export interface AgentSession {
  /** The session id, which is the file name without its extension. */
  id: string;
  /** Last write, in epoch milliseconds. */
  modified: number;
  bytes: number;
  /** The first thing asked in the session — what it is about. */
  title: string;
  /** Who spoke last. Empty when the transcript had nothing readable. */
  lastRole: "user" | "assistant" | "";
  lastText: string;
  /** User and assistant turns, tool traffic excluded. */
  messages: number;
}

interface RawSession {
  id: string;
  modified: number;
  bytes: number;
  title: string;
  last_role: string;
  last_text: string;
  messages: number;
}

/** `D:\work\app` → `D--work-app`, the shape Claude Code uses for its folders. */
function projectSlug(path: string): string {
  // the trailing dashes come off in a loop: `/-+$/` backtracks quadratically
  let slug = path.replace(/[\\/:]/g, "-");
  while (slug.endsWith("-")) slug = slug.slice(0, -1);
  return slug;
}

async function sessionsDir(projectPath: string): Promise<string> {
  return join(await homeDir(), ".claude", "projects", projectSlug(projectPath));
}

/** Newest first. Empty when Claude Code has never run here. */
export async function listSessions(projectPath: string, limit = 25): Promise<AgentSession[]> {
  try {
    const dir = await sessionsDir(projectPath);
    const rows = await invoke<RawSession[]>("list_agent_sessions", { dir, limit });
    return rows.map((r) => ({
      id: r.id,
      modified: r.modified,
      bytes: r.bytes,
      title: r.title,
      lastRole: r.last_role === "user" || r.last_role === "assistant" ? r.last_role : "",
      lastText: r.last_text,
      messages: r.messages,
    }));
  } catch {
    return [];
  }
}
