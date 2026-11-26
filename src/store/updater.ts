import { create } from "zustand";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import * as db from "@/lib/db";
import {
  AUTO_SETTING,
  canSelfUpdate,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  installKind,
  shouldOffer,
  SKIP_SETTING,
  type InstallKind,
} from "@/lib/updater";
import { runningRuns, useApp } from "@/store/app";
import { liveTerminals, useBench } from "@/store/bench";
import { activeTunnels, usePorts } from "@/store/ports";

/**
 * Self-update state. A check finds a version; nothing is downloaded or installed
 * until the user asks — now, or when they next quit Assay. The plugin's `Update`
 * object is held outside the store: it is a live handle, not data to render.
 */

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "error";

export interface AvailableUpdate {
  version: string;
  current: string;
  notes: string;
  date: string | null;
}

interface UpdaterState {
  phase: UpdatePhase;
  update: AvailableUpdate | null;
  downloaded: number;
  total: number | null;
  error: string | null;
  /** When the last check answered, in ms. */
  checkedAt: number | null;
  auto: boolean;
  skipped: string | null;
  kind: InstallKind;
  /** Downloaded and waiting for the user to quit. */
  onQuit: boolean;
  dialogOpen: boolean;
  init: () => Promise<void>;
  /** `manual` shows a skipped version again, since the user asked. */
  checkNow: (manual?: boolean) => Promise<void>;
  setAuto: (on: boolean) => Promise<void>;
  skip: () => Promise<void>;
  /** Download (if needed), stop everything, install, relaunch. */
  installNow: () => Promise<void>;
  /** Download now, install when the user quits. */
  installOnQuit: () => Promise<void>;
  setDialogOpen: (open: boolean) => void;
}

let handle: Update | null = null;
let downloadedHandle = false;
let started = false;

/** Development runs are not installed copies; installing over one would be nonsense. */
const DEV = import.meta.env.DEV;

/** What quitting would cancel, stopped the same way the quit confirmation does. */
async function stopAllWork(): Promise<void> {
  const app = useApp.getState();
  const bench = useBench.getState();
  const ports = usePorts.getState();
  await Promise.allSettled([
    ...runningRuns(app.runs).map((r) => app.cancel(r.runId)),
    ...liveTerminals(bench.terminals).map((term) => bench.closeTerminal(term.id)),
    ...activeTunnels(ports.tunnels).map((tun) => ports.stop(tun.id)),
  ]);
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const useUpdater = create<UpdaterState>((set, get) => ({
  phase: "idle",
  update: null,
  downloaded: 0,
  total: null,
  error: null,
  checkedAt: null,
  auto: true,
  skipped: null,
  kind: "bundle",
  onQuit: false,
  dialogOpen: false,

  init: async () => {
    if (started) return;
    started = true;
    const [auto, skipped, kind] = await Promise.all([
      db.getSetting(AUTO_SETTING),
      db.getSetting(SKIP_SETTING),
      installKind().catch((): InstallKind => "bundle"),
    ]);
    set({ auto: auto !== "off", skipped: skipped || null, kind });
    // a development run checks only when asked
    if (DEV) return;
    setTimeout(() => {
      if (get().auto) void get().checkNow();
    }, FIRST_CHECK_DELAY_MS);
    setInterval(() => {
      if (get().auto) void get().checkNow();
    }, CHECK_INTERVAL_MS);
  },

  checkNow: async (manual = false) => {
    const { phase } = get();
    // never throw away a download in flight or one already waiting
    if (phase === "checking" || phase === "downloading" || phase === "ready" || phase === "installing") return;
    set({ phase: "checking", error: null });
    try {
      const found = await check();
      set({ checkedAt: Date.now() });
      if (!found) {
        handle = null;
        set({ phase: "idle", update: null });
        return;
      }
      if (handle?.version !== found.version) downloadedHandle = false;
      handle = found;
      const update: AvailableUpdate = {
        version: found.version,
        current: found.currentVersion,
        notes: found.body ?? "",
        date: found.date ?? null,
      };
      if (manual && get().skipped === found.version) {
        await db.setSetting(SKIP_SETTING, "");
        set({ skipped: null });
      }
      set({ phase: "available", update, downloaded: 0, total: null, ...(manual ? { dialogOpen: true } : {}) });
    } catch (e) {
      // an automatic check that fails says nothing; only a check the user asked for reports it
      set({ phase: manual ? "error" : "idle", error: manual ? message(e) : null });
    }
  },

  setAuto: async (on) => {
    set({ auto: on });
    await db.setSetting(AUTO_SETTING, on ? "on" : "off");
  },

  skip: async () => {
    const version = get().update?.version;
    if (!version) return;
    await db.setSetting(SKIP_SETTING, version);
    set({ skipped: version, dialogOpen: false });
  },

  installOnQuit: async () => {
    if (!(await download(set))) return;
    set({ onQuit: true, dialogOpen: false });
  },

  installNow: async () => {
    if (!handle || !canSelfUpdate(get().kind) || DEV) return;
    if (!(await download(set))) return;
    set({ phase: "installing" });
    try {
      await stopAllWork();
      // Windows hands over to the installer here and Assay exits on its own
      await handle.install();
      await relaunch();
    } catch (e) {
      set({ phase: "error", error: message(e) });
    }
  },

  setDialogOpen: (open) => set({ dialogOpen: open }),
}));

/** Fetch the installer once; the plugin verifies its signature before it is kept. */
async function download(set: (partial: Partial<UpdaterState>) => void): Promise<boolean> {
  if (!handle) return false;
  if (downloadedHandle) return true;
  set({ phase: "downloading", downloaded: 0, total: null, error: null });
  let downloaded = 0;
  try {
    await handle.download((e: DownloadEvent) => {
      if (e.event === "Started") set({ total: e.data.contentLength ?? null });
      else if (e.event === "Progress") {
        downloaded += e.data.chunkLength;
        set({ downloaded });
      }
    });
    downloadedHandle = true;
    set({ phase: "ready" });
    return true;
  } catch (e) {
    set({ phase: "error", error: message(e) });
    return false;
  }
}

/**
 * Called on every way out of the app: an update downloaded for "when I quit"
 * is installed now. On Windows the installer takes over and the app exits.
 */
export async function applyUpdateOnQuit(): Promise<void> {
  if (!handle || !downloadedHandle || !useUpdater.getState().onQuit || DEV) return;
  try {
    await handle.install();
  } catch {
    // quitting must still quit; the next launch finds the update again
  }
}

/** Whether the header chip should show. */
export function chipVisible(s: Pick<UpdaterState, "phase" | "update" | "skipped">): boolean {
  if (!s.update) return false;
  if (s.phase === "idle" || s.phase === "checking") return false;
  return s.phase !== "available" || shouldOffer(s.update.version, s.skipped);
}
