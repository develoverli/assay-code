import { create } from "zustand";
import { detectReleasePlease, resolveStyle, type CommitStyleSetting } from "@/lib/commit-style";
import { fetchReleaseInfo, getAccount, TokenRejectedError, type ReleaseInfo } from "@/lib/github";
import { readReleaseSummary, type ReleaseMode, type ReleaseSummary } from "@/lib/releases";

/**
 * The Releases panel's two readings, per project: what the repository says
 * (tags, commits, next version — local git, cheap, also feeds the rail badge)
 * and what GitHub says (release pull request, newest release — read only when
 * the panel asks, never on a heartbeat: a release does not change every 10 s).
 */

export type RemoteReading =
  | { phase: "loading" }
  | { phase: "ready"; info: ReleaseInfo }
  /** No linked account: the panel shows what is local and says how to get the rest. */
  | { phase: "no-account" }
  | { phase: "failed"; error: string; detail?: string };

interface ReleasesState {
  local: Record<string, ReleaseSummary | undefined>;
  loadingLocal: Record<string, boolean | undefined>;
  remote: Record<string, RemoteReading | undefined>;
  /** Read tags and commits. A second call for the same project while one runs is dropped. */
  loadLocal: (projectId: string, root: string, setting: CommitStyleSetting) => Promise<ReleaseSummary | null>;
  /** Read the release pull request and newest release from GitHub. */
  loadRemote: (projectId: string, githubRepo: string) => Promise<void>;
}

/** release-please when the project's commit style says so, or when its files are there whatever the style. */
export async function releaseModeOf(root: string, setting: CommitStyleSetting): Promise<ReleaseMode> {
  const detected = await detectReleasePlease(root);
  return detected || resolveStyle(setting, detected) === "release-please" ? "release-please" : "tags";
}

const inFlight = new Set<string>();
const rerun = new Map<string, { root: string; setting: CommitStyleSetting }>();

export const useReleases = create<ReleasesState>((set) => ({
  local: {},
  loadingLocal: {},
  remote: {},

  loadLocal: async (projectId, root, setting) => {
    // a read asked for while one runs is not dropped: it runs once that one ends,
    // since the commit that triggered it may have landed after the first read began
    if (inFlight.has(projectId)) {
      rerun.set(projectId, { root, setting });
      return null;
    }
    inFlight.add(projectId);
    set((s) => ({ loadingLocal: { ...s.loadingLocal, [projectId]: true } }));
    try {
      const summary = await readReleaseSummary(root, await releaseModeOf(root, setting));
      set((s) => ({ local: { ...s.local, [projectId]: summary } }));
      return summary;
    } finally {
      inFlight.delete(projectId);
      set((s) => ({ loadingLocal: { ...s.loadingLocal, [projectId]: false } }));
      const again = rerun.get(projectId);
      if (again) {
        rerun.delete(projectId);
        void useReleases.getState().loadLocal(projectId, again.root, again.setting).catch(() => undefined);
      }
    }
  },

  loadRemote: async (projectId, githubRepo) => {
    const put = (r: RemoteReading) => set((s) => ({ remote: { ...s.remote, [projectId]: r } }));
    if (!(await getAccount())) return put({ phase: "no-account" });
    put({ phase: "loading" });
    try {
      put({ phase: "ready", info: await fetchReleaseInfo(githubRepo) });
    } catch (e) {
      if (e instanceof TokenRejectedError) return put({ phase: "failed", error: e.message, detail: e.detail });
      put({ phase: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  },
}));
