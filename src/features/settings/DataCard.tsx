import { Database, ShieldAlert, Trash2 } from "lucide-react";
import * as React from "react";
import { useApp } from "@/store/app";
import * as db from "@/lib/db";
import { Button, Card, Select } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useT } from "@/lib/i18n";

const KEEP_CHOICES = [30, 90, 180, 365];

/** Purging history is a button, never a background job: deleting that record has to be a decision. */
export function DataCard() {
  const t = useT();
  const setError = useApp((s) => s.setError);
  const [days, setDays] = React.useState(90);
  const [asking, setAsking] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [removed, setRemoved] = React.useState<number | null>(null);

  const purge = () => {
    setBusy(true);
    db.purgeHistory(days)
      .then(setRemoved)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Card className="mb-4 flex flex-col gap-4 p-4">
      <div className="flex items-start gap-2.5">
        <Database className="mt-0.5 h-4 w-4 shrink-0 text-text-3" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[13px] font-medium">{t("Run history")}</p>
              <p className="text-[11px] text-text-3">
                {t(
                  "Every run keeps its log, findings and diffs. Deleting old ones frees space and takes them out of Audit and Stats for good.",
                )}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Select
                className="w-[130px]"
                value={String(days)}
                onChange={(v) => setDays(Number(v))}
                aria-label={t("Keep runs from the last")}
                options={KEEP_CHOICES.map((d) => ({ value: String(d), label: t("{n} days", { n: d }) }))}
              />
              <Button variant="danger" size="sm" loading={busy} onClick={() => setAsking(true)}>
                <Trash2 className="h-3.5 w-3.5" /> {t("Delete older")}
              </Button>
            </div>
          </div>
          {removed !== null && (
            <p className="mt-2 text-[11px] text-text-3">
              {removed === 0 ? t("Nothing was old enough to delete.") : t("{n} runs deleted.", { n: removed })}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-start gap-2.5 border-t border-border-soft pt-4">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
        <p className="text-[11px] text-text-2">
          {t(
            "Tokens you enter (SonarQube, LLM keys) are stored in Assay's local SQLite database in plain text, like any local dev tool. Anyone with your user account can read them. Use tokens scoped to what Assay needs, and revoke them when you stop using it.",
          )}
        </p>
      </div>

      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        danger
        title={t("Delete runs older than {n} days?", { n: days })}
        confirmLabel={t("Delete")}
        body={
          <p>
            {t(
              "Their logs, findings and recorded diffs go with them, from Audit and from Stats. Findings from the latest scan of each tool are not affected.",
            )}
          </p>
        }
        onConfirm={purge}
      />
    </Card>
  );
}
