import { create } from "zustand";
import { resolveBin } from "@/lib/agent-bins";
import { writeClipboard } from "@/lib/clipboard";
import * as db from "@/lib/db";
import { tr } from "@/lib/i18n";
import {
  fromInfo,
  listPorts,
  listTunnels,
  onTunnelExit,
  onTunnelReady,
  silentTunnels,
  startTunnel,
  stopTunnel,
  type ListeningPort,
  type PortRow,
  type Tunnel,
} from "@/lib/ports";
import { uid } from "@/lib/utils";

/**
 * Ports and public links. The listening ports are read from the OS on a
 * heartbeat; links are cloudflared processes held in Rust, so they outlive a
 * reload and a project switch the way terminals do, and die with the app. A link
 * whose server stops listening is closed on its own.
 */

/** Same beat as the git status heartbeat. */
const HEARTBEAT_MS = 10_000;
/** How long "Link copied" stays on the row. */
const COPIED_MS = 4_000;

interface PortsState {
  listening: ListeningPort[];
  /** The first read has come back; before it, an empty list means nothing yet. */
  scanned: boolean;
  /** Ports added by hand, by project id. */
  manual: Record<string, number[]>;
  tunnels: Tunnel[];
  /** The tunnel whose link was just put on the clipboard. */
  copied: string | null;
  init: () => Promise<void>;
  refresh: () => Promise<void>;
  loadManual: (projectId: string) => Promise<void>;
  addManual: (projectId: string, port: number) => Promise<void>;
  removeManual: (projectId: string, port: number) => Promise<void>;
  /** Open a link to a row's port. Throws when cloudflared cannot be started. */
  share: (projectId: string, row: PortRow) => Promise<void>;
  stop: (id: string) => Promise<void>;
  /** Forget a failed tunnel once its error was read. */
  dismiss: (id: string) => void;
  /** Mark the link as copied (the row says so for a moment). */
  flagCopied: (id: string) => void;
}

let started = false;
let refreshing = false;
let watchers = 0;
let misses: ReadonlyMap<string, number> = new Map();
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

export const usePorts = create<PortsState>((set, get) => ({
  listening: [],
  scanned: false,
  manual: {},
  tunnels: [],
  copied: null,

  init: async () => {
    if (started) return;
    started = true;
    // listeners first, so a URL printed while the list is read is not lost
    await onTunnelReady(({ id, url }) => {
      if (!get().tunnels.some((t) => t.id === id)) return;
      set((s) => ({
        tunnels: s.tunnels.map((t) => (t.id === id ? { ...t, url, phase: "ready", error: null } : t)),
      }));
      // the reason the button was pressed: the link is ready to paste
      void writeClipboard(url).then(
        () => get().flagCopied(id),
        () => undefined,
      );
    });
    await onTunnelExit(({ id, detail }) => {
      const tunnel = get().tunnels.find((t) => t.id === id);
      if (!tunnel) return;
      // reap it in Rust either way; the exit event only says the log closed
      void stopTunnel(id).catch(() => undefined);
      if (tunnel.phase === "starting") {
        const error = detail.trim() || tr("cloudflared stopped before giving a link.");
        set((s) => ({ tunnels: s.tunnels.map((t) => (t.id === id ? { ...t, phase: "failed", error } : t)) }));
      } else {
        set((s) => ({ tunnels: s.tunnels.filter((t) => t.id !== id) }));
      }
    });
    const held = await listTunnels().catch(() => []);
    if (held.length) set({ tunnels: held.filter((t) => t.alive).map(fromInfo) });

    setInterval(() => {
      const live = get().tunnels.some((t) => t.phase !== "failed");
      if (live || (watchers > 0 && document.hasFocus())) void get().refresh();
    }, HEARTBEAT_MS);
  },

  refresh: async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const listening = await listPorts();
      set({ listening, scanned: true });
      const verdict = silentTunnels(get().tunnels, listening, misses);
      misses = verdict.misses;
      for (const id of verdict.close) void get().stop(id);
    } catch {
      // a failed read leaves the last one on screen; the next beat tries again
      set({ scanned: true });
    } finally {
      refreshing = false;
    }
  },

  loadManual: async (projectId) => {
    const ports = await db.listProjectPorts(projectId);
    set((s) => ({ manual: { ...s.manual, [projectId]: ports } }));
  },

  addManual: async (projectId, port) => {
    await db.addProjectPort(projectId, port);
    await get().loadManual(projectId);
  },

  removeManual: async (projectId, port) => {
    await db.deleteProjectPort(projectId, port);
    await get().loadManual(projectId);
  },

  share: async (projectId, row) => {
    const bin = await resolveBin("cloudflared");
    if (!bin.command) throw new Error(tr("cloudflared is not installed."));
    const id = uid("tun_");
    set((s) => ({
      tunnels: [
        ...s.tunnels,
        { id, port: row.port, projectId, url: null, startedAt: Date.now(), phase: "starting", error: null },
      ],
    }));
    try {
      await startTunnel({
        id,
        program: bin.command,
        // what the socket is bound to; a port typed by hand that nothing reported yet goes through localhost
        host: row.listening?.host ?? "localhost",
        port: row.port,
        projectId,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      set((s) => ({ tunnels: s.tunnels.map((t) => (t.id === id ? { ...t, phase: "failed", error } : t)) }));
    }
  },

  stop: async (id) => {
    set((s) => ({ tunnels: s.tunnels.filter((t) => t.id !== id), copied: s.copied === id ? null : s.copied }));
    await stopTunnel(id);
  },

  dismiss: (id) => set((s) => ({ tunnels: s.tunnels.filter((t) => t.id !== id) })),

  flagCopied: (id) => {
    clearTimeout(copiedTimer);
    set({ copied: id });
    copiedTimer = setTimeout(() => set((s) => (s.copied === id ? { copied: null } : s)), COPIED_MS);
  },
}));

/**
 * Keep the listening ports fresh while something on screen shows them. Returns
 * the release. Reads once straight away, then on the shared heartbeat while the
 * window has focus.
 */
export function watchPorts(): () => void {
  watchers += 1;
  void usePorts.getState().refresh();
  return () => {
    watchers -= 1;
  };
}

/** Links that are up or coming up — what quitting would close. */
export function activeTunnels(tunnels: Tunnel[]): Tunnel[] {
  return tunnels.filter((t) => t.phase !== "failed");
}
