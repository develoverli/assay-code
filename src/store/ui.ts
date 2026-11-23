import { create } from "zustand";
import * as db from "@/lib/db";

const SIDEBAR_SETTING = "ui.sidebarHidden";
const GROUP_SETTING = "ui.projectsGroupByTag";

export type View = "projects" | "tools" | "findings" | "bench" | "audit" | "skills" | "commands" | "processes" | "stats" | "settings";

/**
 * A run's window has three states:
 *   open    — the floating window is showing it (only one at a time)
 *   tab     — collapsed to a tab in the dock, still visible
 *   hidden  — out of the dock entirely; reachable only from Processes
 * None of them stops the process: that's Cancel.
 */
interface UIState {
  view: View;
  selectedRunId: string | null;
  /** The run whose window is open, if any. */
  openRunId: string | null;
  /** Runs taken out of the dock. */
  hiddenRunIds: string[];
  /** Navigation folded away for room to work. Remembered across launches. */
  sidebarHidden: boolean;
  /**
   * Tags the Projects view is filtered by, and whether it is cut into sections.
   *
   * The filter is a question being asked right now, so it lives for the session
   * and is not stored; grouping is a way of looking at the list, so it is.
   */
  projectTagFilter: string[];
  /** The GitHub account the list is narrowed to (owner of `github_repo`), or null for all. */
  projectGithubFilter: string | null;
  projectsGroupByTag: boolean;

  setView: (v: View) => void;
  toggleProjectTag: (tagId: string) => void;
  setProjectGithubFilter: (owner: string | null) => void;
  /** Drop every filter on the list: tags and GitHub account alike. */
  clearProjectTagFilter: () => void;
  setProjectsGroupByTag: (on: boolean) => void;
  /** Read the stored sidebar preference. */
  initUI: () => Promise<void>;
  toggleSidebar: () => void;
  openRun: (id: string) => void;
  closeRun: () => void;

  /** Show a run's window (collapsing whichever was open) and un-hide it. */
  showWindow: (runId: string) => void;
  /** Collapse the open window back to its dock tab. */
  collapseWindow: () => void;
  /** Toggle between open and collapsed. */
  toggleWindow: (runId: string) => void;
  /** Take a run out of the dock (and close its window if open). */
  hideRun: (runId: string) => void;
  /** Put a hidden run back in the dock. */
  unhideRun: (runId: string) => void;
  /** Forget a run's window state once it's gone. */
  forgetRun: (runId: string) => void;
}

export const useUI = create<UIState>((set) => ({
  view: "projects",
  selectedRunId: null,
  openRunId: null,
  hiddenRunIds: [],
  sidebarHidden: false,
  projectTagFilter: [],
  projectGithubFilter: null,
  projectsGroupByTag: false,

  setView: (view) => set({ view }),
  toggleProjectTag: (tagId) =>
    set((s) => ({
      projectTagFilter: s.projectTagFilter.includes(tagId)
        ? s.projectTagFilter.filter((id) => id !== tagId)
        : [...s.projectTagFilter, tagId],
    })),
  setProjectGithubFilter: (owner) => set({ projectGithubFilter: owner }),
  clearProjectTagFilter: () => set({ projectTagFilter: [], projectGithubFilter: null }),
  setProjectsGroupByTag: (on) => {
    void db.setSetting(GROUP_SETTING, on ? "1" : "0").catch(() => {});
    set({ projectsGroupByTag: on });
  },
  initUI: async () => {
    const [sidebar, group] = await Promise.all([
      db.getSetting(SIDEBAR_SETTING).catch(() => null),
      db.getSetting(GROUP_SETTING).catch(() => null),
    ]);
    set({ sidebarHidden: sidebar === "1", projectsGroupByTag: group === "1" });
  },
  toggleSidebar: () =>
    set((s) => {
      const sidebarHidden = !s.sidebarHidden;
      void db.setSetting(SIDEBAR_SETTING, sidebarHidden ? "1" : "0").catch(() => {});
      return { sidebarHidden };
    }),
  openRun: (id) => set({ selectedRunId: id }),
  closeRun: () => set({ selectedRunId: null }),

  showWindow: (runId) =>
    set((s) => ({ openRunId: runId, hiddenRunIds: s.hiddenRunIds.filter((id) => id !== runId) })),
  collapseWindow: () => set({ openRunId: null }),
  toggleWindow: (runId) =>
    set((s) => ({
      openRunId: s.openRunId === runId ? null : runId,
      hiddenRunIds: s.hiddenRunIds.filter((id) => id !== runId),
    })),
  hideRun: (runId) =>
    set((s) => ({
      openRunId: s.openRunId === runId ? null : s.openRunId,
      hiddenRunIds: s.hiddenRunIds.includes(runId) ? s.hiddenRunIds : [...s.hiddenRunIds, runId],
    })),
  unhideRun: (runId) => set((s) => ({ hiddenRunIds: s.hiddenRunIds.filter((id) => id !== runId) })),
  forgetRun: (runId) =>
    set((s) => ({
      openRunId: s.openRunId === runId ? null : s.openRunId,
      hiddenRunIds: s.hiddenRunIds.filter((id) => id !== runId),
    })),
}));
