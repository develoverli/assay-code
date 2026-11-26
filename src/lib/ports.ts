import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Ports and public links (Workspace › Ports). `src-tauri/src/ports.rs` says which
 * TCP ports are listening and whose project each belongs to; `tunnel.rs` holds the
 * cloudflared processes. What is here is the pure part — which rows a project
 * shows, and when a link whose server went away should close — plus the calls.
 */

export interface ListeningPort {
  port: number;
  /** The loopback address a tunnel dials: `127.0.0.1` or `[::1]`. */
  host: string;
  pid: number | null;
  process: string | null;
  projectId: string | null;
  /** `process`: under one of the project's terminals; `output`: a terminal printed its URL. */
  via: "process" | "output" | null;
}

/** What Rust reports about a tunnel it holds. */
export interface TunnelInfo {
  id: string;
  port: number;
  projectId: string | null;
  url: string | null;
  startedAt: number;
  alive: boolean;
}

export type TunnelPhase = "starting" | "ready" | "failed";

export interface Tunnel {
  id: string;
  port: number;
  projectId: string | null;
  url: string | null;
  startedAt: number;
  phase: TunnelPhase;
  /** cloudflared's last words, for a tunnel that never produced a URL. */
  error: string | null;
}

export interface PortRow {
  port: number;
  /** The socket on that port right now, whoever owns it; null when nothing listens. */
  listening: ListeningPort | null;
  /** Added by hand, so it stays listed while nothing listens on it. */
  manual: boolean;
  tunnel: Tunnel | null;
}

export const READY_EVENT = "tunnel://ready";
export const EXIT_EVENT = "tunnel://exit";

/** Polls in a row a link's port may be silent before the link is closed. */
export const MISSES_TO_CLOSE = 2;

/**
 * The rows one project's panel shows: what its terminals are serving, what was
 * added by hand, and any link it holds — one row per port, lowest first.
 */
export function portRows(
  projectId: string,
  listening: ListeningPort[],
  manual: number[],
  tunnels: Tunnel[],
): PortRow[] {
  const byPort = new Map(listening.map((l) => [l.port, l]));
  const mine = tunnels.filter((t) => t.projectId === projectId);
  const ports = new Set<number>([
    ...listening.filter((l) => l.projectId === projectId).map((l) => l.port),
    ...manual,
    ...mine.map((t) => t.port),
  ]);
  const manualSet = new Set(manual);
  return [...ports]
    .sort((a, b) => a - b)
    .map((port) => ({
      port,
      listening: byPort.get(port) ?? null,
      manual: manualSet.has(port),
      tunnel: mine.find((t) => t.port === port) ?? null,
    }));
}

/**
 * After a poll: which links lost their server. A port has to be silent on
 * `MISSES_TO_CLOSE` polls in a row, so a dev server restarting on save does not
 * cost the link everyone was sent. A failed tunnel is left for the user to read.
 */
export function silentTunnels(
  tunnels: Tunnel[],
  listening: ListeningPort[],
  misses: ReadonlyMap<string, number>,
): { misses: Map<string, number>; close: string[] } {
  const open = new Set(listening.map((l) => l.port));
  const next = new Map<string, number>();
  const close: string[] = [];
  for (const t of tunnels) {
    if (t.phase === "failed" || open.has(t.port)) continue;
    const n = (misses.get(t.id) ?? 0) + 1;
    if (n >= MISSES_TO_CLOSE) close.push(t.id);
    else next.set(t.id, n);
  }
  return { misses: next, close };
}

/** A port typed by hand, or null when it is not one. */
export function parsePort(text: string): number | null {
  const s = text.trim().replace(/^:/, "");
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

/** The host part of a link, which is what fits in a row. */
export function linkHost(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

/** A Rust tunnel as a row's tunnel, after a reload. */
export function fromInfo(info: TunnelInfo): Tunnel {
  return { ...info, phase: info.url ? "ready" : "starting", error: null };
}

export function listPorts(): Promise<ListeningPort[]> {
  return invoke<ListeningPort[]>("ports_list");
}

export function startTunnel(args: {
  id: string;
  program: string;
  host: string;
  port: number;
  projectId: string;
}): Promise<void> {
  return invoke("tunnel_start", args);
}

export function stopTunnel(id: string): Promise<void> {
  return invoke("tunnel_stop", { id });
}

export function listTunnels(): Promise<TunnelInfo[]> {
  return invoke<TunnelInfo[]>("tunnel_list");
}

export function onTunnelReady(cb: (e: { id: string; url: string }) => void): Promise<UnlistenFn> {
  return listen<{ id: string; url: string }>(READY_EVENT, (e) => cb(e.payload));
}

export function onTunnelExit(cb: (e: { id: string; detail: string }) => void): Promise<UnlistenFn> {
  return listen<{ id: string; detail: string }>(EXIT_EVENT, (e) => cb(e.payload));
}
