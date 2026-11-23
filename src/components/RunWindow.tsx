import { Ban, EyeOff, Loader2, Minus } from "lucide-react";
import { useMemo } from "react";
import { useApp, useRunLog, useRunMeta, type LiveRun } from "@/store/app";
import { useUI } from "@/store/ui";
import { Button } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/severity";
import { Terminal } from "@/components/ui/terminal";
import { asStatus, useElapsed } from "@/lib/run-view";
import { cn, fmtDuration } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/**
 * The log of one run, floating above the content. Only one is open at a time —
 * opening another collapses this one to its dock tab, so the app is never buried
 * under stacked windows.
 */
export function RunWindow() {
  const t = useT();
  const openRunId = useUI((s) => s.openRunId);
  const hiddenRunIds = useUI((s) => s.hiddenRunIds);
  const collapseWindow = useUI((s) => s.collapseWindow);
  const hideRun = useUI((s) => s.hideRun);
  const cancel = useApp((s) => s.cancel);
  // the open run only: another run's log chunk leaves this window alone
  const meta = useRunMeta(openRunId);
  const log = useRunLog(openRunId);
  const run = useMemo<LiveRun | undefined>(() => (meta ? { ...meta, log } : undefined), [meta, log]);
  // the dock is only there when something is in it — otherwise don't float above a gap
  const dockVisible = useApp((s) => s.runs.some((r) => !hiddenRunIds.includes(r.runId)));
  const elapsed = useElapsed(meta ?? undefined);
  if (!run) return null;

  const running = run.status === "running";
  return (
    // a floating panel, not a modal: no focus trap, the app stays usable
    <section
      aria-label={t("Run log: {name}", { name: `${run.projectName} · ${run.label}` })}
      className={cn(
        "fixed right-4 z-30 flex w-[560px] max-w-[calc(100vw-2rem)] flex-col rounded-xl border border-border bg-surface shadow-2xl animate-in",
        dockVisible ? "bottom-12" : "bottom-4",
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <StatusBadge status={asStatus(run.status)} />
          <span className="truncate text-[13px] font-medium" title={`${run.projectName} · ${run.label}`}>
            <span className="text-text-2">{run.projectName}</span>
            <span className="mx-1 text-text-3">·</span>
            {run.label}
          </span>
          <span className="tnum shrink-0 text-[11px] text-text-3">{fmtDuration(elapsed)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {running && (
            <Button variant="danger" size="sm" onClick={() => void cancel(run.runId)}>
              <Ban className="h-3.5 w-3.5" /> {t("Cancel")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("Hide from the dock")}
            title={t("Hide from the dock. Reopen it from Processes")}
            onClick={() => hideRun(run.runId)}
          >
            <EyeOff className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("Collapse to a tab")}
            title={t("Collapse to a tab")}
            onClick={collapseWindow}
          >
            <Minus className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {run.cmd && (
        <div className="border-b border-border px-3.5 py-1.5 font-mono text-[11px] text-text-3 truncate selectable" title={run.cmd}>
          $ {run.cmd}
        </div>
      )}
      {running && !run.log && (
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-2 text-xs text-text-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
          {t("Working. This can take a while. Output streams below when it arrives.")}
        </div>
      )}
      <Terminal text={run.log} className="m-2 h-[300px] border-0 bg-transparent" />
    </section>
  );
}
