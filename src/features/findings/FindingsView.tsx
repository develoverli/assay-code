import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Check, CheckSquare, Download, History, Info, RotateCw, Search, ShieldAlert, Sparkles } from "lucide-react";
import * as React from "react";
import { useApp, blockedReason } from "@/store/app";
import { useUI } from "@/store/ui";
import * as db from "@/lib/db";
import { canAgentFix } from "@/lib/runner";
import { applyFixLimit, DEFAULT_FIX_LIMIT, getFixLimit, setFixLimit } from "@/lib/fix-limit";
import type { Finding, Project, Run, Severity } from "@/types";
import type { AIChoice } from "@/lib/ai";
import { SEVERITIES, SEVERITY_RANK } from "@/types";
import { Button, EmptyState, Select } from "@/components/ui/primitives";
import { StatusDot } from "@/components/ui/severity";
import { ViewHeader } from "@/components/layout/ViewHeader";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/dialog";
import { saveReport, type ReportFormat } from "@/lib/export";
import { cn, fmtDuration } from "@/lib/utils";
import { useT, type Vars } from "@/lib/i18n";
import { useDates } from "@/lib/dates";
import { FindingsTable } from "./FindingsTable";
import { BulkTriageBar } from "./TriageControl";
import { FixControl } from "./FixControl";
import { ScanHistory } from "./ScanHistory";
import { VerifyControl } from "./VerifyControl";
import { countOf, flagOn } from "./records";

const FIX_SEVERITIES_SETTING = "fix.severities";

const SEV_DOT: Record<Severity, string> = {
  critical: "bg-crit",
  high: "bg-high",
  medium: "bg-med",
  low: "bg-low",
  info: "bg-info",
};

// These records are read with values that come from the data, so they are read
// through own-key lookups rather than indexed with a variable.
const SEV_DOT_BY_KEY = new Map<string, string>(Object.entries(SEV_DOT));
const SEVERITY_RANK_BY_KEY = new Map<string, number>(Object.entries(SEVERITY_RANK));

function sevDot(sv: Severity): string {
  return SEV_DOT_BY_KEY.get(sv) ?? SEV_DOT.info;
}

function severityRank(sv: Severity): number {
  return SEVERITY_RANK_BY_KEY.get(sv) ?? 0;
}

interface ToolCardData {
  run: Run;
  toolId: string;
  total: number;
  bySev: Record<string, number>;
}

/* ------------------------------- derivations -------------------------------- */

/** The tool filter is upstream of everything: counts, totals and Fix scope. */
function scopeToTool<T extends { tool_id?: string | null }>(items: T[], toolFilter: string): T[] {
  if (toolFilter === "all") return items;
  return items.filter((i) => i.tool_id === toolFilter);
}

function sortForDisplay(scoped: Finding[], filter: Severity | "all"): Finding[] {
  const rows = filter === "all" ? [...scoped] : scoped.filter((f) => f.severity === filter);
  return rows.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.created_at - a.created_at);
}

function countBySeverity(scoped: Finding[]): Record<string, number> {
  const c = new Map<string, number>();
  for (const f of scoped) c.set(f.severity, (c.get(f.severity) ?? 0) + 1);
  return Object.fromEntries(c);
}

/** One card per tool that has run on this project, from its latest snapshot. */
function buildToolCards(latestRuns: Run[], findings: Finding[]): ToolCardData[] {
  const cards: ToolCardData[] = [];
  for (const r of latestRuns) {
    if (!r.tool_id) continue;
    const bySev = new Map<string, number>();
    let total = 0;
    for (const f of findings) {
      if (f.tool_id !== r.tool_id) continue;
      bySev.set(f.severity, (bySev.get(f.severity) ?? 0) + 1);
      total += 1;
    }
    cards.push({ run: r, toolId: r.tool_id, total, bySev: Object.fromEntries(bySev) });
  }
  return cards.sort((a, b) => b.run.started_at - a.run.started_at);
}

/**
 * What Fix will touch, in order of precedence: an explicit selection, then the
 * severities set in the gear, then whatever the active tab already shows.
 */
function pickFixCandidates(
  selected: Finding[],
  sorted: Finding[],
  filter: Severity | "all",
  fixSeverities: Record<Severity, boolean>,
): Finding[] {
  // an explicit selection (only what is on screen counts) is the user's word;
  // otherwise triaged findings stay out. What the agent may not touch is never
  // counted, selected or not.
  if (selected.length) return selected.filter((f) => canAgentFix(f.tool_id));
  const open = sorted.filter((f) => f.status === "open" && canAgentFix(f.tool_id));
  if (filter !== "all") return open;
  const chosen = SEVERITIES.filter((sv) => flagOn(fixSeverities, sv));
  if (chosen.length === SEVERITIES.length) return open;
  return open.filter((f) => flagOn(fixSeverities, f.severity));
}

type T = (key: string, vars?: Vars) => string;

function fixLabelFor(
  t: T,
  hasSelection: boolean,
  filter: Severity | "all",
  targetCount: number,
  totalCount: number,
  candidateCount: number,
): string {
  // the batch cap wins the label: it must say how many are actually sent
  if (targetCount < candidateCount) return t("Fix {n} of {total}", { n: targetCount, total: candidateCount });
  // the number is what goes to the agent, not how many boxes are ticked
  if (hasSelection) return t("Fix {n} selected", { n: targetCount });
  if (filter !== "all") return t("Fix {n} {severity}", { n: targetCount, severity: t(filter) });
  if (targetCount === totalCount) return t("Fix all {n}", { n: targetCount });
  return t("Fix {n}", { n: targetCount });
}

function subtitleFor(t: T, project: Project, scopeLabel: string, count: number): string {
  const findings = count === 1 ? t("1 finding") : t("{n} findings", { n: count });
  return `${project.name} · ${scopeLabel} · ${findings}`;
}

/* ---------------------------------- hooks ----------------------------------- */

interface FindingsData {
  findings: Finding[];
  history: Run[];
  latestRuns: Run[];
  delta: db.ScanDelta | null;
}

const NO_DATA: FindingsData = { findings: [], history: [], latestRuns: [], delta: null };

/**
 * Everything Findings reads back from the DB for the active project. The four
 * reads land together and carry the project they were read for, so a slow
 * answer for the previous project is dropped instead of shown under this one,
 * and nothing stale is shown between a switch and the next load.
 */
function useFindingsData(
  projectId: string | undefined,
  dataVersion: number,
  onError: (message: string) => void,
): FindingsData {
  const [loaded, setLoaded] = React.useState<(FindingsData & { projectId: string }) | null>(null);

  React.useEffect(() => {
    if (!projectId) return;
    let alive = true;
    void Promise.all([
      db.currentFindings(projectId),
      db.listScanRuns(projectId),
      db.latestScanRuns(projectId),
      // the delta is a nicety: without it the rest still says everything
      db.scanDelta(projectId).catch(() => null),
    ])
      .then(([findings, history, latestRuns, delta]) => {
        if (alive) setLoaded({ projectId, findings, history, latestRuns, delta });
      })
      .catch((e: unknown) => {
        if (alive) onError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [projectId, dataVersion, onError]);

  if (!projectId || loaded?.projectId !== projectId) return NO_DATA;
  return loaded;
}

/** New, gone and unchanged since the previous scan of each tool. */
function DeltaBar({
  delta,
  onlyNew,
  onToggleNew,
}: {
  delta: db.ScanDelta;
  onlyNew: boolean;
  onToggleNew: () => void;
}) {
  const t = useT();
  if (!delta.added.length && !delta.resolved.length && !delta.kept) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[11px]">
      <span className="text-text-3">{t("Since the previous scan")}</span>
      <button
        type="button"
        onClick={onToggleNew}
        disabled={!delta.added.length}
        aria-pressed={onlyNew}
        title={delta.added.length ? t("Show only what is new") : t("Nothing new")}
        className={cn(
          "rounded-full border px-2 py-0.5 transition-colors",
          delta.added.length ? "cursor-pointer" : "cursor-not-allowed opacity-50",
          onlyNew ? "border-accent/40 bg-accent-soft text-accent" : "border-border text-text-2 hover:bg-surface-2",
        )}
      >
        <span className="tnum">+{delta.added.length}</span> {t("new")}
      </button>
      {/* no minus sign: the count went down, but what the reader needs to see is
          that something got fixed, and "-15" in green says the opposite */}
      <span
        className={cn(
          "flex items-center gap-1",
          delta.resolved.length ? "text-success" : "text-text-3",
        )}
      >
        {delta.resolved.length > 0 && <Check className="h-3 w-3" strokeWidth={3} aria-hidden />}
        <span className="tnum">{delta.resolved.length}</span> {t("resolved")}
      </span>
      <span className="text-text-3">
        <span className="tnum">{delta.kept}</span> {t("unchanged")}
      </span>
    </div>
  );
}

/** SARIF for the machines, Markdown for the pull request. */
function ExportMenu({ onPick, disabled }: { onPick: (f: ReportFormat) => void; disabled: boolean }) {
  const t = useT();
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <Button variant="secondary" disabled={disabled} title={t("Export these findings")}>
          <Download className="h-4 w-4" /> {t("Export")}
        </Button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[220px] rounded-lg border border-border bg-surface p-1 shadow-2xl animate-in"
        >
          <Dropdown.Item
            onSelect={() => onPick("sarif")}
            className="flex cursor-pointer flex-col rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-surface-2"
          >
            <span className="text-[13px] text-text-2">{t("SARIF")}</span>
            <span className="text-[10px] text-text-3">{t("for GitHub code scanning and CI")}</span>
          </Dropdown.Item>
          <Dropdown.Item
            onSelect={() => onPick("markdown")}
            className="flex cursor-pointer flex-col rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-surface-2"
          >
            <span className="text-[13px] text-text-2">{t("Markdown")}</span>
            <span className="text-[10px] text-text-3">{t("to paste into a pull request")}</span>
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** The most findings one Fix run sends, persisted as it changes. */
function useFixLimit(): [number, (n: number) => void] {
  const [limit, setLimit] = React.useState(DEFAULT_FIX_LIMIT);
  React.useEffect(() => {
    let ignore = false;
    void getFixLimit().then((n) => {
      if (!ignore) setLimit(n);
    });
    return () => {
      ignore = true;
    };
  }, []);
  return [
    limit,
    (n: number) => {
      setLimit(n);
      void setFixLimit(n);
    },
  ];
}

/** The severities the gear allows Fix to touch, persisted as they change. */
function useFixSeverities() {
  const [fixSeverities, setFixSeverities] = React.useState<Record<Severity, boolean>>(
    () => Object.fromEntries(SEVERITIES.map((sv) => [sv, true])) as Record<Severity, boolean>,
  );

  React.useEffect(() => {
    let ignore = false;
    void db.getSetting(FIX_SEVERITIES_SETTING).then((v) => {
      if (ignore || !v) return;
      const on = new Set(v.split(","));
      setFixSeverities(Object.fromEntries(SEVERITIES.map((sv) => [sv, on.has(sv)])) as Record<Severity, boolean>);
    });
    return () => {
      ignore = true;
    };
  }, []);

  const toggle = (sv: Severity) => {
    const next = { ...fixSeverities, [sv]: !flagOn(fixSeverities, sv) };
    // never let the gear end up selecting nothing
    if (!SEVERITIES.some((s2) => flagOn(next, s2))) return;
    setFixSeverities(next);
    void db.setSetting(FIX_SEVERITIES_SETTING, SEVERITIES.filter((s2) => flagOn(next, s2)).join(","));
  };

  return { fixSeverities, toggleFixSeverity: toggle };
}

/* -------------------------------- components -------------------------------- */

/**
 * Per-tool summary of the latest scan: outcome and counts by severity. What the
 * run itself reported ("nothing found", "could not run") opens from the icon,
 * since it is about the run, not the code.
 */
function ToolCard({
  name,
  run,
  total,
  bySev,
  active,
  onClick,
}: {
  name: string;
  run: Run;
  total: number;
  bySev: Record<string, number>;
  active: boolean;
  onClick: () => void;
}) {
  const t = useT();
  const dates = useDates();
  const present: { sv: Severity; n: number }[] = [];
  for (const sv of SEVERITIES) {
    const n = countOf(bySev, sv);
    if (n) present.push({ sv, n });
  }

  const failed = run.status === "error" || run.status === "cancelled";
  const took = run.duration_ms ? ` · ${fmtDuration(run.duration_ms)}` : "";
  const when = `${dates.ago(run.started_at)}${took}`;

  return (
    <div
      className={cn(
        "flex min-w-[170px] items-center gap-2 rounded-md border pl-2.5 pr-1.5 py-1.5 transition-colors",
        active ? "border-accent/40 bg-accent-soft" : "border-border bg-surface hover:border-border/80 hover:bg-surface-2",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        title={[
          active ? t("Showing only {name} — click to clear", { name }) : t("Show only {name}", { name }),
          when,
        ].join("\n")}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
      >
        <StatusDot status={run.status} />
        <span className={cn("min-w-0 flex-1 truncate text-[12px] font-medium", active && "text-accent")}>
          {name}
        </span>
        {total === 0 ? (
          <span className={cn("text-[11px]", failed ? "text-danger" : "text-success")}>
            {failed ? t("failed") : t("clean")}
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            {present.map(({ sv, n }) => (
              <span key={sv} className="flex items-center gap-1 text-[11px] text-text-2" title={t(sv)}>
                <span className={cn("h-1.5 w-1.5 rounded-full", sevDot(sv))} aria-hidden />
                <span className="tnum">{n}</span>
              </span>
            ))}
          </span>
        )}
      </button>
      <OutcomeButton name={name} run={run} when={when} />
    </div>
  );
}

/** What the run itself reported (what it read, which rules ran, why it failed), one click away. */
function OutcomeButton({ name, run, when }: { name: string; run: Run; when: string }) {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  if (!run.summary) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("What {name} reported", { name })}
        title={run.summary}
        className={cn(
          "flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded transition-colors",
          "text-text-3 hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent",
        )}
      >
        <Info className="h-3.5 w-3.5" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={name} desc={when}>
          <p className="text-[13px] leading-relaxed text-text-2 selectable">{run.summary}</p>
        </DialogContent>
      </Dialog>
    </>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  count,
  sev,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  sev?: Severity;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs capitalize transition-colors cursor-pointer",
        active ? "border-accent/40 bg-accent-soft text-accent" : "border-border text-text-2 hover:bg-surface-2",
      )}
    >
      {sev && <span className={cn("h-2 w-2 rounded-full", sevDot(sev))} />}
      {label}
      <span className="tnum text-text-3">{count}</span>
    </button>
  );
}

/** Severity tabs, the per-tool narrowing and the History toggle. */
function FilterBar({
  filter,
  onFilter,
  counts,
  total,
  toolIds,
  toolFilter,
  onToolFilter,
  toolName,
  showHistory,
  onToggleHistory,
  historyCount,
  triagedCount,
  showTriaged,
  onToggleTriaged,
  search,
  onSearch,
  allSelected,
  onToggleAll,
}: {
  filter: Severity | "all";
  onFilter: (f: Severity | "all") => void;
  counts: Record<string, number>;
  total: number;
  toolIds: string[];
  toolFilter: string;
  onToolFilter: (id: string) => void;
  toolName: (id?: string | null) => string;
  showHistory: boolean;
  onToggleHistory: () => void;
  historyCount: number;
  triagedCount: number;
  showTriaged: boolean;
  onToggleTriaged: () => void;
  search: string;
  onSearch: (v: string) => void;
  allSelected: boolean;
  onToggleAll: () => void;
}) {
  const t = useT();
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      <div className="flex h-7 min-w-[200px] items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 focus-within:border-accent/50">
        <Search className="h-3.5 w-3.5 shrink-0 text-text-3" />
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={t("Filter by message, file or rule")}
          aria-label={t("Filter findings")}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-text placeholder:text-text-3 selectable focus:outline-none"
        />
      </div>
      <FilterChip active={filter === "all"} onClick={() => onFilter("all")} label={t("All")} count={total} />
      {SEVERITIES.map((s) => (
        <FilterChip
          key={s}
          active={filter === s}
          onClick={() => onFilter(s)}
          label={t(s)}
          count={countOf(counts, s)}
          sev={s}
        />
      ))}
      {toolIds.length > 1 && (
        <Select
          size="sm"
          className="ml-2"
          value={toolFilter}
          onChange={onToolFilter}
          aria-label={t("Filter by tool")}
          options={[
            { value: "all", label: t("All tools") },
            ...toolIds.map((id) => ({ value: id, label: toolName(id) })),
          ]}
        />
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={onToggleAll}
          aria-pressed={allSelected}
          title={allSelected ? t("Clear selection") : t("Select everything on screen")}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors cursor-pointer",
            allSelected ? "border-accent/40 bg-accent-soft text-accent" : "border-border text-text-2 hover:bg-surface-2",
          )}
        >
          <CheckSquare className="h-3 w-3" /> {t("Select all")}
        </button>
        {triagedCount > 0 && (
          <button
            type="button"
            onClick={onToggleTriaged}
            aria-pressed={showTriaged}
            title={t("Findings you ignored, accepted or marked as false positives")}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors cursor-pointer",
              showTriaged ? "border-accent/40 bg-accent-soft text-accent" : "border-border text-text-2 hover:bg-surface-2",
            )}
          >
            {t("Triaged")} <span className="tnum text-text-3">{triagedCount}</span>
          </button>
        )}
        <button
          type="button"
          onClick={onToggleHistory}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors cursor-pointer",
            showHistory ? "border-accent/40 bg-accent-soft text-accent" : "border-border text-text-2 hover:bg-surface-2",
          )}
        >
          <History className="h-3 w-3" /> {t("History")}{" "}
          <span className="tnum text-text-3">{historyCount}</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Retest names what it is about to re-run: with six scanners, "the latest scan"
 * is a guess, so the targets are listed and confirmed.
 */
function RetestDialog({
  open,
  onOpenChange,
  targets,
  toolName,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targets: string[];
  toolName: (id?: string | null) => string;
  onConfirm: () => void;
}) {
  const t = useT();
  const single = targets.length === 1;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        single
          ? t("Run {tool} again?", { tool: toolName(targets[0]) })
          : t("Run {n} tools again?", { n: targets.length })
      }
      confirmLabel={t("Retest")}
      body={
        <div className="flex flex-col gap-2">
          <span>
            {single
              ? t("Runs {tool} on this project again. Its previous findings become a snapshot in History.", {
                  tool: toolName(targets[0]),
                })
              : t("Runs these tools one after another. Each one replaces its own previous findings.")}
          </span>
          {targets.length > 1 && (
            <ul className="space-y-1">
              {targets.map((id) => (
                <li key={id} className="font-mono text-[11px] text-text-3">
                  {toolName(id)}
                </li>
              ))}
            </ul>
          )}
        </div>
      }
      onConfirm={onConfirm}
    />
  );
}

export function FindingsView() {
  // one field each: the log stream rewrites `runs` many times a second, and
  // this view only needs to know whether the project is blocked
  const project = useApp((s) => s.projects.find((p) => p.id === s.activeProjectId));
  const dataVersion = useApp((s) => s.dataVersion);
  const fix = useApp((s) => s.fix);
  const scan = useApp((s) => s.scan);
  const tools = useApp((s) => s.tools);
  const blocked = useApp((s) => blockedReason(s.runs, s.maxConcurrent, s.activeProjectId));
  const openRun = useUI((s) => s.openRun);
  const t = useT();
  const toolName = React.useCallback(
    (id?: string | null) => tools.find((t) => t.id === id)?.name ?? "—",
    [tools],
  );
  const siteScoped = React.useCallback(
    (id?: string | null) => tools.find((t) => t.id === id)?.scope === "url",
    [tools],
  );

  const setError = useApp((s) => s.setError);
  const { findings, history, latestRuns, delta } = useFindingsData(project?.id, dataVersion, setError);
  const [showTriaged, setShowTriaged] = React.useState(false);
  const [onlyNew, setOnlyNew] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [retesting, setRetesting] = React.useState(false);
  const { fixSeverities, toggleFixSeverity } = useFixSeverities();
  const [fixLimit, setFixLimitValue] = useFixLimit();
  const [filter, setFilter] = React.useState<Severity | "all">("all");
  const [toolFilter, setToolFilter] = React.useState<string>("all");
  /** Set once per project: land on the newest analysis rather than every tool at once. */
  const defaultedFor = React.useRef<string | null>(null);
  const [showHistory, setShowHistory] = React.useState(false);
  const [sel, setSel] = React.useState<Set<string>>(new Set());
  // a selection belongs to what was on screen when it was made: another
  // project, tab, tool or filter starts from nothing rather than carrying
  // ticks the user can no longer see into Fix. The same key sends the table
  // back to its first page.
  const scopeKey = [project?.id ?? "", filter, toolFilter, showTriaged, onlyNew, search.trim()].join("|");
  const [selScope, setSelScope] = React.useState(scopeKey);
  if (selScope !== scopeKey) {
    setSelScope(scopeKey);
    setSel(new Set());
  }

  const toolsInFindings = React.useMemo(() => {
    const ids = new Set<string>();
    for (const f of findings) if (f.tool_id) ids.add(f.tool_id);
    return [...ids];
  }, [findings]);

  const exportReport = (format: ReportFormat) => {
    if (!project) return;
    void saveReport(format, project, scoped, toolName).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  const newFingerprints = React.useMemo(
    () => new Set((delta?.added ?? []).map((f) => f.fingerprint ?? "")),
    [delta],
  );
  const triagedCount = React.useMemo(() => findings.filter((f) => f.status !== "open").length, [findings]);

  const visible = React.useMemo(() => {
    let rows = showTriaged ? findings : findings.filter((f) => f.status === "open");
    // "new" is about this scan, so it narrows whatever is already in view
    if (onlyNew) rows = rows.filter((f) => newFingerprints.has(f.fingerprint ?? ""));
    const needle = search.trim().toLowerCase();
    if (needle) {
      // one box over message, path, category and tool
      rows = rows.filter((f) =>
        [f.message, f.file ?? "", f.category ?? "", toolName(f.tool_id)]
          .join(" ")
          .toLowerCase()
          .includes(needle),
      );
    }
    return rows;
  }, [findings, showTriaged, onlyNew, newFingerprints, search, toolName]);

  const scoped = React.useMemo(() => scopeToTool(visible, toolFilter), [visible, toolFilter]);
  const sorted = React.useMemo(() => sortForDisplay(scoped, filter), [scoped, filter]);
  const counts = React.useMemo(() => countBySeverity(scoped), [scoped]);
  const scopedHistory = React.useMemo(() => scopeToTool(history, toolFilter), [history, toolFilter]);
  const toolCards = React.useMemo(() => buildToolCards(latestRuns, visible), [latestRuns, visible]);
  // only ticks on rows still on screen count (a triaged row can leave the list)
  const selectedFindings = React.useMemo(() => sorted.filter((f) => sel.has(f.id)), [sorted, sel]);
  const fixCandidates = React.useMemo(
    () => pickFixCandidates(selectedFindings, sorted, filter, fixSeverities),
    [selectedFindings, sorted, filter, fixSeverities],
  );
  // what actually goes to the agent: the batch the user set, off the top of the
  // list, which is already sorted worst-first
  const fixTarget = React.useMemo(
    () => applyFixLimit(fixCandidates, fixLimit),
    [fixCandidates, fixLimit],
  );

  React.useEffect(() => {
    if (!project || !toolCards.length) return;
    if (defaultedFor.current === project.id) return;
    defaultedFor.current = project.id;
    setToolFilter(toolCards[0].toolId); // toolCards is sorted newest first
  }, [project, toolCards]);

  const allSelected = sorted.length > 0 && selectedFindings.length === sorted.length;

  const toggleAll = () => setSel(allSelected ? new Set() : new Set(sorted.map((f) => f.id)));

  // stable, so the table's memoised columns survive a re-render of the view
  const toggle = React.useCallback(
    (id: string) =>
      setSel((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    [],
  );

  const runFix = (choice: AIChoice) => {
    // only an agent edits files; a bare local model never reaches this
    if (!project || !fixTarget.length || choice.kind !== "agent") return;
    void fix(project.id, fixTarget, choice.provider, choice.model || undefined);
    setSel(new Set());
  };

  // Retest re-runs the tool whose card is selected, or every tool with a card
  const retestTargets = React.useMemo(() => {
    if (toolFilter !== "all") return [toolFilter];
    return toolCards.map((c) => c.toolId);
  }, [toolFilter, toolCards]);

  const runRetest = () => {
    if (!project) return;
    void (async () => {
      for (const toolId of retestTargets) await scan(project.id, toolId);
    })();
  };

  if (!project) {
    return (
      <div className="mx-auto max-w-6xl p-5">
        <ViewHeader title={t("Findings")} />
        <EmptyState
          icon={ShieldAlert}
          title={t("No project selected")}
          desc={t("Pick a project from the top switcher.")}
        />
      </div>
    );
  }

  const busy = !!blocked;
  const scopeLabel = toolFilter === "all" ? t("latest scan of each tool") : toolName(toolFilter);

  return (
    <div className="mx-auto max-w-6xl p-5">
      <ViewHeader
        title={t("Findings")}
        subtitle={subtitleFor(t, project, scopeLabel, scoped.length)}
        action={
          <div className="flex items-center gap-2">
            <ExportMenu onPick={exportReport} disabled={!scoped.length} />
            <VerifyControl project={project} blocked={blocked} busy={busy} dataVersion={dataVersion} />
            <Button
              variant="secondary"
              disabled={busy || !history.length}
              onClick={() => setRetesting(true)}
              // title below explains *why* it is disabled
              title={
                blocked ??
                t("Re-run the latest scan — replaces these findings and saves the old set as a snapshot")
              }
            >
              <RotateCw className="h-4 w-4" /> {t("Retest")}
            </Button>
            <FixControl
              label={fixLabelFor(
                t,
                selectedFindings.length > 0,
                filter,
                fixTarget.length,
                sorted.length,
                fixCandidates.length,
              )}
              disabled={busy || fixTarget.length === 0}
              busy={busy}
              blocked={blocked}
              filter={filter}
              counts={counts}
              fixSeverities={fixSeverities}
              onToggleSeverity={toggleFixSeverity}
              limit={fixLimit}
              onLimit={setFixLimitValue}
              onFix={runFix}
            />
          </div>
        }
      />

      {toolCards.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2.5">
          {toolCards.map((c) => (
            <ToolCard
              key={c.toolId}
              name={toolName(c.toolId)}
              run={c.run}
              total={c.total}
              bySev={c.bySev}
              active={toolFilter === c.toolId}
              onClick={() => setToolFilter(toolFilter === c.toolId ? "all" : c.toolId)}
            />
          ))}
        </div>
      )}

      {delta && (
        <DeltaBar delta={delta} onlyNew={onlyNew} onToggleNew={() => setOnlyNew((v) => !v)} />
      )}

      <FilterBar
        filter={filter}
        onFilter={setFilter}
        counts={counts}
        total={scoped.length}
        toolIds={toolsInFindings}
        toolFilter={toolFilter}
        onToolFilter={setToolFilter}
        toolName={toolName}
        showHistory={showHistory}
        onToggleHistory={() => setShowHistory((v) => !v)}
        historyCount={scopedHistory.length}
        triagedCount={triagedCount}
        showTriaged={showTriaged}
        onToggleTriaged={() => setShowTriaged((v) => !v)}
        search={search}
        onSearch={setSearch}
        allSelected={allSelected}
        onToggleAll={toggleAll}
      />

      <RetestDialog
        open={retesting}
        onOpenChange={setRetesting}
        targets={retestTargets}
        toolName={toolName}
        onConfirm={runRetest}
      />

      {selectedFindings.length > 0 && (
        <BulkTriageBar
          projectId={project.id}
          findings={selectedFindings}
          onClear={() => setSel(new Set())}
        />
      )}

      {showHistory && (
        <ScanHistory
          heading={
            toolFilter === "all"
              ? t("Scan snapshots — evolution over time")
              : t("{tool} — previous scans", { tool: scopeLabel })
          }
          runs={scopedHistory}
          onOpen={openRun}
        />
      )}

      {sorted.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title={t("No findings")}
          desc={t("Run a tool from the Tools tab, then Retest here to refresh.")}
        />
      ) : (
        <FindingsTable
          rows={sorted}
          selected={sel}
          onToggle={toggle}
          toolName={toolName}
          siteScoped={siteScoped}
          projectId={project.id}
          newFingerprints={newFingerprints}
          pageResetKey={scopeKey}
        />
      )}
    </div>
  );
}
