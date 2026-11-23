import { useApp } from "@/store/app";
import { useBench } from "@/store/bench";
import * as React from "react";
import {
  activeFirst,
  activeProjectKey,
  activityLabel,
  activityOf,
  isActive,
  type Activity,
} from "@/lib/project-activity";
import type { Project } from "@/types";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Live runs and terminals in one project, subscribed as counts rather than arrays:
 * the log stream mutates `runs` many times a second, a count only on start/end.
 */
function useProjectActivity(projectId: string): Activity {
  const runs = useApp((s) => activityOf(s.runs, [], projectId).runs);
  const terminals = useBench((s) => activityOf([], s.terminals, projectId).terminals);
  return { runs, terminals };
}

/**
 * Active projects first, then the rest, each in last-use order. Keyed on a string
 * of ids so the sort reruns only when activity changes.
 */
export function useOrderedProjects(): Project[] {
  const projects = useApp((s) => s.projects);
  const runKey = useApp((s) => activeProjectKey(s.runs, []));
  const termKey = useBench((s) => activeProjectKey([], s.terminals));
  return React.useMemo(
    () => activeFirst(projects, [runKey, termKey].filter(Boolean).join(",")),
    [projects, runKey, termKey],
  );
}

/**
 * Pulsing dot plus "1 run · 2 terminals"; nothing when idle. The words are not
 * optional: the dot alone is the same accent as the selected row.
 */
export function ProjectActivity({ projectId, compact = false }: { projectId: string; compact?: boolean }) {
  const a = useProjectActivity(projectId);
  const t = useT();
  if (!isActive(a)) return null;
  const label = activityLabel(a, t);
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-accent tnum", compact ? "text-[10px]" : "text-[11px]")}>
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
        style={{ animation: "assay-pulse 1.4s ease-in-out infinite" }}
        aria-hidden
      />
      <span className="whitespace-nowrap">{label}</span>
    </span>
  );
}
