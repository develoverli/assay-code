import { ArrowDownRight, ArrowRight, ArrowUpRight, LineChart, Wand2 } from "lucide-react";
import * as React from "react";
import { useApp } from "@/store/app";
import * as db from "@/lib/db";
import type { RunStat } from "@/lib/db";
import type { Project } from "@/types";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { ViewHeader } from "@/components/layout/ViewHeader";
import { cn, fmtDuration } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { useDates } from "@/lib/dates";

/** Findings over time as a bare polyline: too small to justify a chart dependency. */
function Sparkline({ points, className }: { points: number[]; className?: string }) {
  const t = useT();
  if (points.length < 2) return <div className={cn("h-8", className)} />;
  const max = Math.max(...points, 1);
  const w = 120;
  const h = 32;
  const step = w / (points.length - 1);
  const d = points.map((p, i) => `${i * step},${h - (p / max) * (h - 2) - 1}`).join(" ");
  const improving = points[points.length - 1] <= points[0];
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={cn("h-8 w-[120px]", className)}
      role="img"
      aria-label={t("Trend: {points}", { points: points.join(", ") })}
    >
      <polyline
        points={d}
        fill="none"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        className={improving ? "stroke-success" : "stroke-warn"}
      />
    </svg>
  );
}

function Delta({ from, to }: { from: number; to: number }) {
  const t = useT();
  const diff = to - from;
  if (!from && !to) return <span className="text-[11px] text-text-3">{t("no data")}</span>;
  if (diff === 0)
    return (
      <span className="flex items-center gap-1 text-[11px] text-text-3">
        <ArrowRight className="h-3 w-3" /> {t("flat")}
      </span>
    );
  const better = diff < 0;
  const pct = from ? Math.round((Math.abs(diff) / from) * 100) : 100;
  return (
    <span className={cn("flex items-center gap-1 text-[11px] font-medium", better ? "text-success" : "text-danger")}>
      {better ? <ArrowDownRight className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
      <span className="tnum">
        {better ? "−" : "+"}
        {Math.abs(diff)}
      </span>
      <span className="text-text-3">({pct}%)</span>
    </span>
  );
}

function Metric({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="tnum text-[20px] font-semibold leading-none">{value}</span>
      <span className="text-[11px] text-text-2">{label}</span>
      {hint && <span className="text-[10px] text-text-3">{hint}</span>}
    </div>
  );
}

export function StatsView() {
  const t = useT();
  const dates = useDates();
  const dataVersion = useApp((s) => s.dataVersion);
  const [stats, setStats] = React.useState<RunStat[] | null>(null);
  // retired projects belong here: their history is exactly what this view measures
  const [projects, setProjects] = React.useState<Project[]>([]);

  React.useEffect(() => {
    void db.runStats().then(setStats);
    void db.listAllProjects().then(setProjects);
  }, [dataVersion]);

  const scans = React.useMemo(() => (stats ?? []).filter((r) => r.kind === "scan" && r.status !== "cancelled"), [stats]);
  const fixes = React.useMemo(() => (stats ?? []).filter((r) => r.kind === "fix"), [stats]);

  /** Per project: the finding count of each scan, oldest first. */
  const perProject = React.useMemo(() => {
    return projects.map((p) => {
      const own = scans.filter((r) => r.project_id === p.id);
      // one point per scan; tools mix, but the trend is what matters
      const points = own.map((r) => r.findings);
      const first = points[0] ?? 0;
      const last = points[points.length - 1] ?? 0;
      const best = points.length ? Math.min(...points) : 0;
      const worst = points.length ? Math.max(...points) : 0;
      const lastRun = own[own.length - 1];
      const fixRuns = fixes.filter((r) => r.project_id === p.id);
      return {
        project: p,
        points,
        first,
        last,
        best,
        worst,
        scans: own.length,
        lastAt: lastRun?.started_at,
        fixRuns: fixRuns.length,
        filesEdited: fixRuns.reduce((a, r) => a + r.edits, 0),
      };
    });
  }, [projects, scans, fixes]);

  /** Findings removed between the scan before a fix and the next scan after it. */
  const fixImpact = React.useMemo(() => {
    let removed = 0;
    let measured = 0;
    for (const fx of fixes) {
      const before = [...scans].reverse().find((s) => s.project_id === fx.project_id && s.started_at < fx.started_at);
      const after = scans.find((s) => s.project_id === fx.project_id && s.started_at > fx.started_at);
      if (!before || !after) continue;
      measured++;
      removed += before.findings - after.findings;
    }
    return { removed, measured, runs: fixes.length, files: fixes.reduce((a, r) => a + r.edits, 0) };
  }, [fixes, scans]);

  /** Per tool: how often it runs, how long it takes, how often it fails. */
  const perTool = React.useMemo(() => {
    const by = new Map<string, RunStat[]>();
    for (const r of stats ?? []) {
      if (r.kind !== "scan") continue;
      const k = r.tool_name || "—";
      by.set(k, [...(by.get(k) ?? []), r]);
    }
    return [...by.entries()]
      .map(([name, rs]) => {
        const done = rs.filter((r) => r.duration_ms != null);
        return {
          name,
          runs: rs.length,
          failed: rs.filter((r) => r.status === "error").length,
          avg: done.length ? done.reduce((a, r) => a + (r.duration_ms ?? 0), 0) / done.length : null,
          findings: rs.reduce((a, r) => a + r.findings, 0),
        };
      })
      .sort((a, b) => b.runs - a.runs);
  }, [stats]);

  if (stats && !scans.length && !fixes.length) {
    return (
      <div className="mx-auto max-w-5xl p-5">
        <ViewHeader title={t("Stats")} />
        <EmptyState
          icon={LineChart}
          title={t("Nothing measured yet")}
          desc={t(
            "Run a tool on a project. Once there are two scans, this view shows whether things are getting better.",
          )}
        />
      </div>
    );
  }

  const totalNow = perProject.reduce((a, p) => a + p.last, 0);
  const totalFirst = perProject.reduce((a, p) => a + p.first, 0);

  return (
    <div className="mx-auto max-w-5xl p-5">
      <ViewHeader
        title={t("Stats")}
        subtitle={t("How your projects have moved since Assay started scanning them.")}
      />

      <Card className="mb-4 flex flex-wrap items-center justify-between gap-6 p-4">
        <Metric
          label={t("Findings now")}
          value={totalNow}
          hint={t("across {n} scanned projects", { n: perProject.filter((p) => p.scans).length })}
        />
        <Metric label={t("At the first scan")} value={totalFirst} />
        <div className="flex flex-col gap-1">
          <Delta from={totalFirst} to={totalNow} />
          <span className="text-[11px] text-text-2">{t("Overall change")}</span>
        </div>
        <Metric label={t("Scans run")} value={scans.length} />
        <Metric
          label={t("AI fix runs")}
          value={fixImpact.runs}
          hint={t("{n} files edited", { n: fixImpact.files })}
        />
      </Card>

      <Card className="mb-4 flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <Wand2 className="h-4 w-4 text-accent" />
          <h2 className="text-[13px] font-semibold">{t("Impact of the AI fixes")}</h2>
        </div>
        {fixImpact.measured === 0 ? (
          <p className="text-[11px] text-text-3">
            {t(
              "Nothing measurable yet. Impact is the difference between the scan before a fix and the scan after it, so run Retest once a fix finishes.",
            )}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-8">
            <Metric
              label={t("Findings removed")}
              value={fixImpact.removed}
              hint={t("measured over {measured} of {runs} fix runs", {
                measured: fixImpact.measured,
                runs: fixImpact.runs,
              })}
            />
            <Metric label={t("Files edited")} value={fixImpact.files} />
            <p className="max-w-[280px] text-[10px] text-text-3">
              {t(
                "Only fixes with a scan on each side count. A negative number means findings went up after the fix.",
              )}
            </p>
          </div>
        )}
      </Card>

      <Card className="mb-4 overflow-hidden p-0">
        <div className="border-b border-border-soft px-4 py-2.5 text-[11px] uppercase tracking-wide text-text-3">
          {t("Per project")}
        </div>
        <div className="divide-y divide-border-soft">
          {perProject.map((p) => {
            const count = p.scans === 1 ? t("1 scan") : t("{n} scans", { n: p.scans });
            const when = t("last {when}", { when: dates.ago(p.lastAt) });
            return (
              <div key={p.project.id} className="flex items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-[13px] font-medium">
                    {p.project.name}
                    {p.project.deleted_at && <Badge tone="warn">{t("no longer tracked")}</Badge>}
                  </p>
                  <p className="text-[11px] text-text-3">
                    {p.scans === 0 ? t("never scanned") : `${count} · ${when}`}
                  </p>
                </div>
                {p.fixRuns > 0 && <Badge>{t("{n} fix runs", { n: p.fixRuns })}</Badge>}
                <div className="flex w-[120px] shrink-0 flex-col items-end">
                  <span className="tnum text-[11px] text-text-3">
                    {t("best {best} · worst {worst}", { best: p.best, worst: p.worst })}
                  </span>
                  <Sparkline points={p.points} />
                </div>
                <div className="w-[92px] shrink-0 text-right">
                  <span className="tnum text-[15px] font-semibold">{p.last}</span>
                  <span className="ml-1 text-[10px] text-text-3">{t("now")}</span>
                </div>
                <div className="w-[110px] shrink-0">
                  <Delta from={p.first} to={p.last} />
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-border-soft px-4 py-2.5 text-[11px] uppercase tracking-wide text-text-3">
          {t("Per tool")}
        </div>
        <div className="divide-y divide-border-soft">
          {perTool.map((tool) => (
            <div key={tool.name} className="flex items-center gap-4 px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate text-[13px]">{tool.name}</span>
              <span className="tnum w-[70px] text-right text-[11px] text-text-2">
                {t("{n} runs", { n: tool.runs })}
              </span>
              <span className="tnum w-[90px] text-right text-[11px] text-text-2">
                {t("{duration} avg", { duration: tool.avg == null ? "—" : fmtDuration(tool.avg) })}
              </span>
              <span className="tnum w-[110px] text-right text-[11px] text-text-2">
                {t("{n} findings", { n: tool.findings })}
              </span>
              <span
                className={cn(
                  "tnum w-[80px] text-right text-[11px]",
                  tool.failed ? "text-danger" : "text-text-3",
                )}
              >
                {t("{n} failed", { n: tool.failed })}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
