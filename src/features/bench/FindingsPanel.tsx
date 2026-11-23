import { ChevronDown, ChevronRight, ShieldAlert } from "lucide-react";
import * as React from "react";
import { useApp } from "@/store/app";
import { useBench } from "@/store/bench";
import * as db from "@/lib/db";
import type { Finding, Severity } from "@/types";
import { SEVERITY_RANK } from "@/types";
import { SeverityDot } from "@/components/ui/severity";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { fileGlyph } from "./icons";

/**
 * This project's open findings, grouped by file; a click lands on the finding's
 * line. Findings with no file (a quality gate, a site score) are listed apart.
 */

interface Group {
  file: string | null;
  items: Finding[];
  worst: Severity;
}

function group(findings: Finding[]): Group[] {
  const byFile = new Map<string | null, Finding[]>();
  for (const f of findings) {
    const key = f.file ?? null;
    byFile.set(key, [...(byFile.get(key) ?? []), f]);
  }
  const groups: Group[] = [];
  for (const [file, items] of byFile) {
    const sorted = [...items].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.line ?? 0) - (b.line ?? 0),
    );
    groups.push({ file, items: sorted, worst: sorted[0].severity });
  }
  // worst first, and the project-wide bucket last wherever it lands
  return groups.sort((a, b) => {
    if ((a.file === null) !== (b.file === null)) return a.file === null ? 1 : -1;
    return SEVERITY_RANK[a.worst] - SEVERITY_RANK[b.worst] || (a.file ?? "").localeCompare(b.file ?? "");
  });
}

function FileGroup({ root, entry }: { root: string; entry: Group }) {
  const t = useT();
  const openAt = useBench((s) => s.openAt);
  const [open, setOpen] = React.useState(true);
  const name = entry.file ? (entry.file.split("/").pop() ?? entry.file) : null;
  const { Icon, tone } = fileGlyph(name ?? "x.txt");

  return (
    <div className="border-b border-border-soft last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={entry.file ?? t("Applies to the whole target, not one file")}
        className="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1.5 text-left text-[12px] text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        {entry.file ? (
          <Icon className={cn("h-3.5 w-3.5 shrink-0", tone)} />
        ) : (
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-text-3" />
        )}
        <span className="truncate">{entry.file ?? t("project")}</span>
        <span className="tnum ml-auto shrink-0 text-[10px] text-text-3">{entry.items.length}</span>
      </button>

      {open && (
        <div className="pb-1">
          {entry.items.map((f) => (
            <button
              type="button"
              key={f.id}
              disabled={!entry.file}
              onClick={() => {
                if (!entry.file || !name) return;
                void openAt(`${root}/${entry.file}`, name, f.line ?? 1);
              }}
              title={f.message}
              className={cn(
                "flex w-full items-start gap-1.5 py-[3px] pl-7 pr-2 text-left text-[11px] transition-colors",
                entry.file
                  ? "cursor-pointer text-text-2 hover:bg-surface-2 hover:text-text"
                  : "cursor-default text-text-3",
              )}
            >
              <span className="mt-[3px] shrink-0">
                <SeverityDot severity={f.severity} />
              </span>
              <span className="min-w-0 flex-1 truncate">{f.message}</span>
              {f.line ? <span className="tnum shrink-0 text-[10px] text-text-3">:{f.line}</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function FindingsPanel({ root, projectId }: { root: string; projectId: string }) {
  const t = useT();
  const dataVersion = useApp((s) => s.dataVersion);
  const [findings, setFindings] = React.useState<Finding[] | null>(null);

  React.useEffect(() => {
    let ignore = false;
    void db
      .currentFindings(projectId)
      .then((rows) => {
        if (!ignore) setFindings(rows.filter((f) => !f.fixed));
      })
      .catch(() => {
        if (!ignore) setFindings([]);
      });
    return () => {
      ignore = true;
    };
  }, [projectId, dataVersion]);

  if (findings === null) {
    return <p className="px-3 py-3 text-[11px] text-text-3">{t("reading…")}</p>;
  }
  if (!findings.length) {
    return (
      <p className="px-3 py-3 text-[11px] text-text-3">
        {t("No open findings for this project. Run a tool from Tools.")}
      </p>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {group(findings).map((g) => (
        <FileGroup key={g.file ?? "__project"} root={root} entry={g} />
      ))}
    </div>
  );
}
