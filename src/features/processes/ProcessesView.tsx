import { Activity, Ban, Eye, EyeOff, Maximize2, X } from "lucide-react";
import { useApp, useRunMetas, useRunningCount } from "@/store/app";
import { useUI } from "@/store/ui";
import { Badge, Button, Card, EmptyState } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/severity";
import { asStatus, useElapsed } from "@/lib/run-view";
import { ViewHeader } from "@/components/layout/ViewHeader";
import { fmtDuration } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import type { RunMeta } from "@/store/app";

function Row({ run }: { run: RunMeta }) {
  const t = useT();
  const cancel = useApp((s) => s.cancel);
  const clearRun = useApp((s) => s.clearRun);
  const { openRunId, hiddenRunIds, showWindow, hideRun, unhideRun, forgetRun, openRun } = useUI();
  const elapsed = useElapsed(run);
  const hidden = hiddenRunIds.includes(run.runId);
  const running = run.status === "running";
  const open = openRunId === run.runId;

  return (
    <Card className="flex items-center gap-3 p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <StatusBadge status={asStatus(run.status)} />
          <span className="truncate text-[13px] font-medium">{run.label}</span>
          <Badge>{run.projectName}</Badge>
          {hidden && <Badge tone="warn">{t("hidden")}</Badge>}
          {open && <Badge tone="accent">{t("open")}</Badge>}
        </div>
        <p className="mt-0.5 truncate font-mono text-[10px] text-text-3 selectable" title={run.cmd}>
          {run.cmd || "—"}
        </p>
      </div>
      <span className="tnum shrink-0 text-[11px] text-text-3">{fmtDuration(elapsed)}</span>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button variant="secondary" size="sm" onClick={() => showWindow(run.runId)}>
          <Maximize2 className="h-3.5 w-3.5" /> {t("Open")}
        </Button>
        {hidden ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("Show in the dock")}
            title={t("Show it in the dock again")}
            onClick={() => unhideRun(run.runId)}
          >
            <Eye className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("Hide from the dock")}
            title={t("Hide from the dock. It stays here")}
            onClick={() => hideRun(run.runId)}
          >
            <EyeOff className="h-4 w-4" />
          </Button>
        )}
        {running ? (
          <Button variant="danger" size="sm" onClick={() => void cancel(run.runId)}>
            <Ban className="h-3.5 w-3.5" /> {t("Cancel")}
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={() => openRun(run.runId)}>
              {t("Details")}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("Dismiss")}
              title={t("Dismiss (the run stays in Audit)")}
              onClick={() => {
                forgetRun(run.runId);
                clearRun(run.runId);
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}

/**
 * Everything started in this session — running, finished and hidden alike.
 * Finished runs live on in Audit; this view is about what's happening now.
 */
export function ProcessesView() {
  // metadata only: log chunks don't re-render the list
  const runs = useRunMetas();
  const maxConcurrent = useApp((s) => s.maxConcurrent);
  const setMaxConcurrent = useApp((s) => s.setMaxConcurrent);
  const t = useT();
  const active = useRunningCount();

  return (
    <div className="mx-auto max-w-4xl p-5">
      <ViewHeader
        title={t("Processes")}
        subtitle={t(
          "{active} running · {total} this session. One run at a time per project; other projects run in parallel.",
          { active, total: runs.length },
        )}
      />

      <Card className="mb-4 flex items-center justify-between gap-4 p-3.5">
        <div>
          <p className="text-[13px] font-medium">{t("Concurrent runs")}</p>
          <p className="text-[11px] text-text-3">
            {t("Each Sonar scan starts its own container with a JVM. Raise this only if you have the RAM.")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input
            type="range"
            min={1}
            max={10}
            value={maxConcurrent}
            onChange={(e) => setMaxConcurrent(Number(e.target.value))}
            aria-label={t("Maximum concurrent runs")}
            className="w-40 cursor-pointer accent-accent"
          />
          <span className="tnum w-6 text-right text-[13px] font-medium">{maxConcurrent}</span>
        </div>
      </Card>

      {runs.length === 0 ? (
        <EmptyState
          icon={Activity}
          title={t("Nothing running")}
          desc={t(
            "Runs you start from Tools, Findings, Skills or Commands show up here and stay until you dismiss them.",
          )}
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          {[...runs].reverse().map((r) => (
            <Row key={r.runId} run={r} />
          ))}
        </div>
      )}
    </div>
  );
}
