import { create } from "zustand";
import * as db from "@/lib/db";
import { emptyLayout, groupsOf, parseLayout, serializeLayout, type PaneLayout } from "@/lib/pane-layout";

/**
 * Workspace's split layout, one per project, kept in the settings table
 * (`bench.layout.<project id>`) so a project switch or a restart puts the panes
 * back. Writes are debounced: dragging a divider produces dozens of layouts.
 */

const KEY = (projectId: string) => `bench.layout.${projectId}`;
const SAVE_DELAY_MS = 500;

interface PanesState {
  layouts: Record<string, PaneLayout | undefined>;
  /** Projects whose stored layout has been read (or found missing). */
  loaded: Record<string, boolean | undefined>;
  load: (projectId: string) => Promise<void>;
  /** Replace a project's layout through a pure function from `lib/pane-layout`. */
  update: (projectId: string, fn: (layout: PaneLayout) => PaneLayout) => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The terminals on screen in a project: the front tab of any pane, not only the
 * active one. What "the user is looking at it" means once Workspace is split.
 */
export function visibleTerminals(projectId: string | null): Set<string> {
  const layout = usePanes.getState().layouts[projectId ?? ""];
  if (!layout) return new Set();
  return new Set(
    groupsOf(layout)
      .map((g) => g.front)
      .filter((k): k is `t:${string}` => !!k?.startsWith("t:"))
      .map((k) => k.slice(2)),
  );
}

function scheduleSave(projectId: string, layout: PaneLayout): void {
  const pending = timers.get(projectId);
  if (pending) clearTimeout(pending);
  timers.set(
    projectId,
    setTimeout(() => {
      timers.delete(projectId);
      void db.setSetting(KEY(projectId), serializeLayout(layout)).catch(() => undefined);
    }, SAVE_DELAY_MS),
  );
}

export const usePanes = create<PanesState>((set, get) => ({
  layouts: {},
  loaded: {},

  load: async (projectId) => {
    if (get().loaded[projectId]) return;
    const stored = parseLayout(await db.getSetting(KEY(projectId)).catch(() => null));
    set((s) => ({
      // Workspace waits for this before syncing, so the stored layout is the starting point
      layouts: { ...s.layouts, [projectId]: stored ?? s.layouts[projectId] ?? emptyLayout() },
      loaded: { ...s.loaded, [projectId]: true },
    }));
  },

  update: (projectId, fn) => {
    const current = get().layouts[projectId] ?? emptyLayout();
    const next = fn(current);
    if (next === current) return;
    set((s) => ({ layouts: { ...s.layouts, [projectId]: next } }));
    if (get().loaded[projectId]) scheduleSave(projectId, next);
  },
}));
