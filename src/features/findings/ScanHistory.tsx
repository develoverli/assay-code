import type { Run } from "@/types";
import { Badge } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/severity";
import { useT } from "@/lib/i18n";
import { useDates } from "@/lib/dates";

/** Previous scans for whatever tool scope is active — the evolution over time. */
export function ScanHistory({
  heading,
  runs,
  onOpen,
}: {
  heading: string;
  runs: Run[];
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const dates = useDates();
  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-border bg-surface animate-in">
      <div className="border-b border-border-soft px-3 py-2 text-[11px] uppercase tracking-wide text-text-3">
        {heading}
      </div>
      {runs.length === 0 ? (
        <div className="px-3 py-3 text-xs text-text-3">{t("No scans yet.")}</div>
      ) : (
        <div className="max-h-56 overflow-auto">
          {runs.map((r, i) => (
            <button
              type="button"
              key={r.id}
              onClick={() => onOpen(r.id)}
              className="flex w-full items-center gap-3 border-b border-border-soft px-3 py-2 text-left text-xs hover:bg-surface-2 cursor-pointer"
            >
              <StatusBadge status={r.status} />
              <span className="font-medium">{r.tool_name}</span>
              <span className="flex-1 truncate text-text-3">{r.summary ?? "—"}</span>
              {i === 0 && <Badge tone="accent">{t("current")}</Badge>}
              <span className="tnum text-text-3">{dates.ago(r.started_at)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
