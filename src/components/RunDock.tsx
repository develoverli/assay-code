import { EyeOff, X } from "lucide-react";
import * as React from "react";
import { useApp, useRunMetas, type RunMeta } from "@/store/app";
import { useUI } from "@/store/ui";
import { StatusDot } from "@/components/ui/severity";
import { asStatus, useElapsed } from "@/lib/run-view";
import { cn, fmtDuration } from "@/lib/utils";
import { useT } from "@/lib/i18n";

const Tab = React.memo(function Tab({ run }: { run: RunMeta }) {
  const t = useT();
  // a boolean, not openRunId: opening one window should not redraw every tab
  const open = useUI((s) => s.openRunId === run.runId);
  const toggleWindow = useUI((s) => s.toggleWindow);
  const hideRun = useUI((s) => s.hideRun);
  const forgetRun = useUI((s) => s.forgetRun);
  const clearRun = useApp((s) => s.clearRun);
  const elapsed = useElapsed(run);
  const running = run.status === "running";

  return (
    <div
      className={cn(
        "flex h-7 shrink-0 items-center gap-1 rounded-md border pl-2 pr-1 transition-colors",
        open ? "border-accent/40 bg-accent-soft" : "border-border bg-surface-2 hover:bg-surface-3",
      )}
    >
      <button
        type="button"
        onClick={() => toggleWindow(run.runId)}
        aria-expanded={open}
        title={`${run.projectName} · ${run.label} (${open ? t("collapse") : t("open")})`}
        className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded focus-visible:outline-2 focus-visible:outline-accent"
      >
        <StatusDot status={asStatus(run.status)} />
        <span className={cn("max-w-[150px] truncate text-[11px]", open ? "text-accent" : "text-text-2")}>
          <span className="text-text-3">{run.projectName}</span> · {run.label}
        </span>
        <span className="tnum text-[10px] text-text-3">{fmtDuration(elapsed)}</span>
      </button>
      <button
        type="button"
        onClick={() => hideRun(run.runId)}
        aria-label={t("Hide {name}", { name: run.label })}
        title={t("Hide from the dock. Reopen it from Processes")}
        className="cursor-pointer rounded p-1 text-text-3 transition-colors hover:bg-surface hover:text-text-2 active:text-text focus-visible:outline-2 focus-visible:outline-accent"
      >
        <EyeOff className="h-3 w-3" />
      </button>
      {!running && (
        <button
          type="button"
          onClick={() => {
            forgetRun(run.runId);
            clearRun(run.runId);
          }}
          aria-label={t("Dismiss {name}", { name: run.label })}
          title={t("Dismiss (the run stays in Audit)")}
          className="cursor-pointer rounded p-1 text-text-3 transition-colors hover:bg-surface hover:text-text-2 active:text-text focus-visible:outline-2 focus-visible:outline-accent"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
});

/**
 * Strip of every run that hasn't been hidden. It sits in the layout rather than
 * floating, so it never covers content — and a finished run stays here, marked,
 * until it's dismissed.
 */
export function RunDock() {
  const t = useT();
  // metadata only: a log chunk changes nothing on a tab, so it redraws nothing
  const runs = useRunMetas();
  const hiddenRunIds = useUI((s) => s.hiddenRunIds);
  const hidden = React.useMemo(() => new Set(hiddenRunIds), [hiddenRunIds]);
  const visible = runs.filter((r) => !hidden.has(r.runId));
  if (!visible.length) return null;

  const hiddenCount = runs.length - visible.length;
  return (
    <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-border bg-surface px-3 py-1.5">
      {visible.map((r) => (
        <Tab key={r.runId} run={r} />
      ))}
      {hiddenCount > 0 && (
        <span className="shrink-0 pl-1 text-[10px] text-text-3">
          {t("+{n} hidden", { n: hiddenCount })}
        </span>
      )}
    </div>
  );
}
