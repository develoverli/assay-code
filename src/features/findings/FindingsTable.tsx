import { ChevronDown, ChevronRight } from "lucide-react";
import * as React from "react";
import type { Finding } from "@/types";
import { SEVERITY_RANK } from "@/types";
import { Badge } from "@/components/ui/primitives";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { SeverityPill } from "@/components/ui/severity";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { StatusTag, TriageControl } from "./TriageControl";

/**
 * The findings currently in scope: sorted, paged, expandable. The expansion is
 * what the tool said about fixing it (`raw.help`), kept out of the row.
 */

/** The one line of advice an adapter recorded, if it recorded any. */
function helpOf(finding: Finding): string | null {
  if (!finding.raw) return null;
  try {
    const raw = JSON.parse(finding.raw) as { help?: unknown };
    const help = typeof raw.help === "string" ? raw.help.trim() : "";
    return help || null;
  } catch {
    return null;
  }
}

/**
 * The columns, built out here so no cell renderer is a component defined
 * inside the table: a nested one is recreated on every render.
 */
function findingColumns(opts: {
  t: ReturnType<typeof useT>;
  selected: Set<string>;
  onToggle: (id: string) => void;
  toolName: (id?: string | null) => string;
  siteScoped: (id?: string | null) => boolean;
  projectId: string;
  newFingerprints?: Set<string>;
  expanded: Set<string>;
  toggleExpanded: (id: string) => void;
}): DataColumn<Finding>[] {
  const { t, selected, onToggle, toolName, siteScoped, projectId, newFingerprints, expanded, toggleExpanded } =
    opts;
  return [
    {
      id: "select",
      header: "",
      width: "w-10",
      cell: (f) => (
        <input
          type="checkbox"
          checked={selected.has(f.id)}
          onChange={() => onToggle(f.id)}
          aria-label={t("Select finding: {message}", { message: f.message })}
          title={t("Select this finding for Fix with AI")}
          className="h-3.5 w-3.5 cursor-pointer accent-[var(--color-accent)]"
        />
      ),
    },
    {
      id: "severity",
      header: t("Severity"),
      width: "w-28",
      sortValue: (f) => SEVERITY_RANK[f.severity],
      cell: (f) => <SeverityPill severity={f.severity} />,
    },
    {
      id: "message",
      header: t("Message"),
      sortValue: (f) => f.message.toLowerCase(),
      cell: (f) => {
        const help = helpOf(f);
        const open = expanded.has(f.id);
        return (
          <div className="min-w-0">
            <div className="flex items-start gap-2">
              {newFingerprints?.has(f.fingerprint ?? "") && (
                <span
                  className="mt-0.5 shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent"
                  title={t("Not in the previous scan of this tool")}
                >
                  {t("new")}
                </span>
              )}
              <span
                className={cn(
                  "min-w-0 flex-1 selectable",
                  f.status !== "open" && "text-text-3 line-through decoration-text-3/40",
                )}
              >
                {f.message}
              </span>
              <StatusTag finding={f} />
              {help && (
                <button
                  type="button"
                  onClick={() => toggleExpanded(f.id)}
                  aria-expanded={open}
                  title={open ? t("Hide the details") : t("What to do about it")}
                  className="mt-0.5 shrink-0 cursor-pointer rounded text-text-3 transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
              )}
            </div>
            {open && help && (
              <p className="mt-1.5 rounded-md border border-border-soft bg-surface-2 px-2 py-1.5 text-[11px] leading-relaxed text-text-2 selectable">
                {help}
              </p>
            )}
            {f.status !== "open" && f.status_reason && (
              <p className="mt-1 text-[10px] text-text-3">{f.status_reason}</p>
            )}
          </div>
        );
      },
    },
    {
      id: "location",
      header: t("Location"),
      width: "w-56",
      className: "font-mono text-[11px] text-text-3 selectable",
      sortValue: (f) => `${f.file ?? "~"}:${String(f.line ?? 0).padStart(6, "0")}`,
      cell: (f) => {
        if (!f.file) {
          // no file is a real answer, not a blank: the finding is about the whole target
          return (
            <Badge title={t("Applies to the whole target, not one file")}>
              {siteScoped(f.tool_id) ? t("site") : t("project")}
            </Badge>
          );
        }
        const at = f.line ? `:${f.line}` : "";
        return `${f.file}${at}`;
      },
    },
    {
      id: "category",
      header: t("Category"),
      width: "w-32",
      className: "text-text-3",
      sortValue: (f) => f.category ?? "",
      cell: (f) => <span className="block truncate">{f.category ?? "—"}</span>,
    },
    {
      id: "tool",
      header: t("Tool"),
      width: "w-28",
      sortValue: (f) => toolName(f.tool_id),
      cell: (f) => <Badge>{toolName(f.tool_id)}</Badge>,
    },
    {
      id: "triage",
      header: "",
      width: "w-10",
      cell: (f) => <TriageControl finding={f} projectId={projectId} />,
    },
  ];
}

export function FindingsTable({
  rows,
  selected,
  onToggle,
  toolName,
  siteScoped,
  projectId,
  newFingerprints,
  pageResetKey,
}: {
  rows: Finding[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  toolName: (id?: string | null) => string;
  /** Whether the finding's tool targets a URL — its findings belong to the site, not a file. */
  siteScoped: (id?: string | null) => boolean;
  projectId: string;
  /** Fingerprints that weren't in the previous scan of the same tool. */
  newFingerprints?: Set<string>;
  /** Changes when the user narrows the list another way: the table goes back to page 1. */
  pageResetKey?: string;
}) {
  const t = useT();
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const columns: DataColumn<Finding>[] = React.useMemo(
    () =>
      findingColumns({
        t,
        selected,
        onToggle,
        toolName,
        siteScoped,
        projectId,
        newFingerprints,
        expanded,
        toggleExpanded,
      }),
    [expanded, newFingerprints, onToggle, projectId, selected, siteScoped, t, toolName],
  );

  return (
    <DataTable
      data={rows}
      columns={columns}
      rowKey={(f) => f.id}
      pageSize={50}
      resetKey={pageResetKey}
      rowClassName={(f) => (selected.has(f.id) ? "bg-accent-soft/30" : undefined)}
    />
  );
}
