import { History } from "lucide-react";
import * as React from "react";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import * as db from "@/lib/db";
import type { Run } from "@/types";
import { fmtDuration } from "@/lib/utils";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/severity";
import { ViewHeader } from "@/components/layout/ViewHeader";
import { useT } from "@/lib/i18n";
import { useDates } from "@/lib/dates";

/** Built outside the view so no cell renderer is a component recreated on every render. */
function auditColumns(opts: {
  scope: "active" | "all";
  nameOf: (id: string) => string;
  openRun: (id: string) => void;
  t: ReturnType<typeof useT>;
  dates: ReturnType<typeof useDates>;
}): DataColumn<Run>[] {
  const { scope, nameOf, openRun, t, dates } = opts;
  const cols: DataColumn<Run>[] = [
    {
      id: "status",
      header: t("Status"),
      width: "w-28",
      sortValue: (r) => r.status,
      cell: (r) => <StatusBadge status={r.status} />,
    },
    {
      id: "tool",
      header: t("Tool"),
      className: "font-medium",
      sortValue: (r) => r.tool_name,
      cell: (r) => r.tool_name,
    },
  ];
  if (scope === "all") {
    cols.push({
      id: "project",
      header: t("Project"),
      width: "w-40",
      className: "text-text-2",
      sortValue: (r) => nameOf(r.project_id),
      cell: (r) => nameOf(r.project_id),
    });
  }
  cols.push(
    {
      id: "kind",
      header: t("Kind"),
      width: "w-20",
      sortValue: (r) => r.kind,
      cell: (r) => <Badge tone={r.kind === "fix" ? "accent" : "neutral"}>{t(r.kind)}</Badge>,
    },
    {
      id: "summary",
      header: t("Summary"),
      className: "text-text-3",
      cell: (r) => <span className="block truncate">{r.summary ?? "—"}</span>,
    },
    {
      id: "when",
      header: t("When"),
      width: "w-28",
      className: "text-text-3 tnum",
      sortValue: (r) => r.started_at,
      cell: (r) => dates.ago(r.started_at),
    },
    {
      id: "took",
      header: t("Took"),
      width: "w-20",
      className: "text-text-3 tnum",
      sortValue: (r) => r.duration_ms ?? 0,
      cell: (r) => fmtDuration(r.duration_ms),
    },
    {
      id: "open",
      header: "",
      width: "w-10",
      cell: (r) => (
        <button
          type="button"
          onClick={() => openRun(r.id)}
          aria-label={t("Open")}
          title={t("Open")}
          className="cursor-pointer rounded px-1 text-text-3 transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
        >
          →
        </button>
      ),
    },
  );
  return cols;
}

export function AuditView() {
  const projects = useApp((s) => s.projects);
  const activeProjectId = useApp((s) => s.activeProjectId);
  const dataVersion = useApp((s) => s.dataVersion);
  const openRun = useUI((s) => s.openRun);
  const t = useT();
  const dates = useDates();
  const [scope, setScope] = React.useState<"active" | "all">("active");
  const [runs, setRuns] = React.useState<Run[]>([]);

  const project = projects.find((p) => p.id === activeProjectId);
  // runs outlive projects, so the lookup has to include the retired ones
  const [allProjects, setAllProjects] = React.useState<typeof projects>([]);
  React.useEffect(() => {
    let ignore = false;
    void db.listAllProjects().then((all) => {
      if (!ignore) setAllProjects(all);
    });
    return () => {
      ignore = true;
    };
  }, [dataVersion]);
  const nameOf = React.useCallback(
    (id: string) => {
      const p = allProjects.find((x) => x.id === id) ?? projects.find((x) => x.id === id);
      if (!p) return "—";
      return p.deleted_at ? t("{name} (no longer tracked)", { name: p.name }) : p.name;
    },
    [allProjects, projects, t],
  );

  React.useEffect(() => {
    const pid = scope === "active" ? activeProjectId ?? undefined : undefined;
    // switching project or scope fast must not leave the previous list on screen
    let ignore = false;
    void db.listRuns(pid).then((list) => {
      if (!ignore) setRuns(list);
    });
    return () => {
      ignore = true;
    };
  }, [scope, activeProjectId, dataVersion]);

  const columns: DataColumn<Run>[] = React.useMemo(
    () => auditColumns({ scope, nameOf, openRun, t, dates }),
    [scope, nameOf, openRun, t, dates],
  );

  return (
    <div className="mx-auto max-w-6xl p-5">
      <ViewHeader
        title={t("Audit")}
        subtitle={t("Every execution and AI edit, logged for full traceability.")}
        action={
          <div className="flex rounded-md border border-border bg-surface-2 p-0.5 text-xs">
            {(["active", "all"] as const).map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => setScope(s)}
                className={`rounded px-2.5 py-1 capitalize cursor-pointer ${scope === s ? "bg-accent-soft text-accent" : "text-text-2"}`}
              >
                {s === "active" ? (project?.name ?? t("active")) : t("all projects")}
              </button>
            ))}
          </div>
        }
      />
      {runs.length === 0 ? (
        <EmptyState
          icon={History}
          title={t("No runs yet")}
          desc={t("Runs and fixes appear here as you execute tools.")}
        />
      ) : (
        <DataTable
          data={runs}
          columns={columns}
          rowKey={(r) => r.id}
          pageSize={25}
          initialSort={{ id: "when", desc: true }}
        />
      )}
    </div>
  );
}
