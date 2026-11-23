import * as React from "react";
import * as db from "@/lib/db";
import { useUI } from "@/store/ui";
import type { Edit, Finding, Run } from "@/types";
import { fmtDuration } from "@/lib/utils";
import { Undo2 } from "lucide-react";
import { useApp } from "@/store/app";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/dialog";
import { Badge, Button } from "@/components/ui/primitives";
import { SeverityPill, StatusBadge } from "@/components/ui/severity";
import { Terminal } from "@/components/ui/terminal";
import { useT } from "@/lib/i18n";
import { useDates } from "@/lib/dates";

export function RunDetail({ runId }: { runId: string }) {
  const closeRun = useUI((s) => s.closeRun);
  const t = useT();
  const dates = useDates();
  const revertFix = useApp((s) => s.revertFix);
  const [reverting, setReverting] = React.useState(false);
  const [asking, setAsking] = React.useState(false);
  const [run, setRun] = React.useState<Run | null>(null);
  const [findings, setFindings] = React.useState<Finding[]>([]);
  const [edits, setEdits] = React.useState<Edit[]>([]);

  React.useEffect(() => {
    // a slower answer for the run left behind must not land on the one now open
    let ignore = false;
    void db.getRun(runId).then((r) => {
      if (!ignore) setRun(r);
    });
    void db.listFindings({ runId }).then((f) => {
      if (!ignore) setFindings(f);
    });
    void db.listEdits(runId).then((e) => {
      if (!ignore) setEdits(e);
    });
    return () => {
      ignore = true;
    };
  }, [runId]);

  return (
    <Dialog open onOpenChange={(o) => !o && closeRun()}>
      <DialogContent
        title={run?.tool_name ?? t("Run")}
        desc={run ? `${t(run.kind)} · ${dates.at(run.started_at)} · ${fmtDuration(run.duration_ms)}` : ""}
        className="w-[min(820px,94vw)]"
      >
        {run && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={run.status} />
              {run.provider && <Badge tone="accent">{run.provider}</Badge>}
              {run.summary && <span className="text-xs text-text-3">{run.summary}</span>}
              {run.kind === "fix" && edits.length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="ml-auto"
                  loading={reverting}
                  onClick={() => setAsking(true)}
                  title={t("Put these files back the way they were before this fix")}
                >
                  <Undo2 className="h-3.5 w-3.5" /> {t("Revert")}
                </Button>
              )}
            </div>

            <ConfirmDialog
              open={asking}
              onOpenChange={setAsking}
              danger
              title={t("Revert this fix?")}
              confirmLabel={t("Revert")}
              body={
                <p>
                  {t(
                    "Applies the recorded diff in reverse to {n} file(s). If they changed after the fix, git refuses and nothing is touched.",
                    { n: edits.length },
                  )}
                </p>
              }
              onConfirm={() => {
                setReverting(true);
                void revertFix(run.project_id, run.id).finally(() => {
                  setReverting(false);
                  closeRun();
                });
              }}
            />

            <div className="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-[11px] text-text-3 selectable">
              $ {run.cmd}
            </div>

            {findings.length > 0 && (
              <section>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-3">
                  {t("Findings")} ({findings.length})
                </h3>
                <div className="flex max-h-52 flex-col gap-1 overflow-auto rounded-md border border-border p-1.5">
                  {findings.map((f) => (
                    <div key={f.id} className="flex items-start gap-2 rounded px-1.5 py-1 text-xs hover:bg-surface-2">
                      <SeverityPill severity={f.severity} className="shrink-0" />
                      <span className="flex-1 selectable">{f.message}</span>
                      {f.file && <span className="font-mono text-[10px] text-text-3">{f.file}{f.line ? ":" + f.line : ""}</span>}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {edits.length > 0 && (
              <section>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-3">
                  {t("Edits")} ({edits.length})
                </h3>
                <div className="flex flex-col gap-2">
                  {edits.map((e) => (
                    <div key={e.id} className="overflow-hidden rounded-md border border-border">
                      <div className="flex items-center justify-between bg-surface-2 px-2.5 py-1.5 font-mono text-[11px]">
                        <span className="truncate text-text-2 selectable">{e.file}</span>
                        <span className="tnum shrink-0">
                          <span className="text-success">+{e.added}</span> <span className="text-danger">-{e.removed}</span>
                        </span>
                      </div>
                      <Terminal text={e.diff} className="max-h-52 border-0" autoScroll={false} />
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-3">{t("Raw log")}</h3>
              <Terminal text={run.log} className="max-h-72" autoScroll={false} />
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
