import type { Project } from "@/types";

/** When each project was last worked on, and what is live in it right now. */

/**
 * Most recently used first; never-used after, newest added first. Mirrors
 * `db.listProjects` so the list re-sorts in memory without a round trip.
 */
export function sortByLastUse(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => {
    const ua = a.last_used_at ?? null;
    const ub = b.last_used_at ?? null;
    if (ua !== null && ub !== null) return ub - ua;
    if (ua !== null) return -1;
    if (ub !== null) return 1;
    return b.created_at - a.created_at;
  });
}

/** What is live in a project: runs still executing and terminals still open. */
export interface Activity {
  runs: number;
  terminals: number;
}

export function isActive(a: Activity): boolean {
  return a.runs > 0 || a.terminals > 0;
}

/** Count what is running in one project. */
export function activityOf(
  runs: { projectId: string; status: string }[],
  terminals: { projectId: string | null; alive: boolean }[],
  projectId: string,
): Activity {
  let r = 0;
  for (const run of runs) if (run.status === "running" && run.projectId === projectId) r++;
  let t = 0;
  for (const term of terminals) if (term.alive && term.projectId === projectId) t++;
  return { runs: r, terminals: t };
}

/** The words next to the activity dot, e.g. "1 run · 2 terminals"; empty when idle. */
export function activityLabel(
  a: Activity,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const parts: string[] = [];
  if (a.runs > 0) parts.push(a.runs === 1 ? t("1 run") : t("{n} runs", { n: a.runs }));
  if (a.terminals > 0)
    parts.push(a.terminals === 1 ? t("1 terminal") : t("{n} terminals", { n: a.terminals }));
  return parts.join(" · ");
}

/**
 * The projects with something going, as one sorted string so a store selector
 * re-renders only when a run or terminal starts or ends, not on every log chunk.
 */
export function activeProjectKey(
  runs: { projectId: string; status: string }[],
  terminals: { projectId: string | null; alive: boolean }[],
): string {
  const ids = new Set<string>();
  for (const r of runs) if (r.status === "running") ids.add(r.projectId);
  for (const t of terminals) if (t.alive && t.projectId) ids.add(t.projectId);
  return [...ids].sort().join(",");
}

/** Projects with something going first, each half keeping its incoming order. */
export function activeFirst(projects: Project[], activeKey: string): Project[] {
  if (!activeKey) return projects;
  const active = new Set(activeKey.split(","));
  const busy: Project[] = [];
  const idle: Project[] = [];
  for (const p of projects) (active.has(p.id) ? busy : idle).push(p);
  return [...busy, ...idle];
}
