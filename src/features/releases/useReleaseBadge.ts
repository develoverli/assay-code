import * as React from "react";
import { styleSettingOf } from "@/lib/commit-style";
import { releasableCount } from "@/lib/releases";
import { useApp } from "@/store/app";
import { useBench } from "@/store/bench";
import { useReleases } from "@/store/releases";

/**
 * What the Releases rail button counts: features and fixes since the last
 * release of the project on screen. Re-read when the project changes and when the
 * working tree does (a commit moves it) — local git only, never GitHub.
 */
export function useReleaseBadge(projectId: string | null): number {
  const root = useApp((s) => s.projects.find((p) => p.id === projectId)?.path ?? null);
  const setting = useApp((s) => styleSettingOf(s.projects.find((p) => p.id === projectId)));
  const gitStatus = useBench((s) => s.gitStatus);
  const loadLocal = useReleases((s) => s.loadLocal);
  const count = useReleases((s) => {
    const summary = projectId ? s.local[projectId] : undefined;
    return summary ? releasableCount(summary.groups) : 0;
  });

  React.useEffect(() => {
    if (!projectId || !root) return;
    void loadLocal(projectId, root, setting).catch(() => undefined);
  }, [projectId, root, setting, gitStatus, loadLocal]);

  return count;
}
