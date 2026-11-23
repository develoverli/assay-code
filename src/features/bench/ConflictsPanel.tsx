import { Check, GitMerge, RefreshCw, TriangleAlert, Undo2 } from "lucide-react";
import * as React from "react";
import {
  abortOperation,
  conflictState,
  continueOperation,
  explainGitError,
  isDeleteConflict,
  type ConflictState,
  type GitOperation,
} from "@/lib/git";
import { useBench } from "@/store/bench";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/primitives";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { fileGlyph } from "./icons";

/**
 * The files a stopped merge, rebase, cherry-pick or revert left in conflict,
 * each opening in the work area. Finish is offered once none is left; Cancel
 * aborts the operation and asks first.
 */

const OPERATION_LABEL: Record<GitOperation, string> = {
  merge: "Merge in progress",
  rebase: "Rebase in progress",
  "cherry-pick": "Cherry-pick in progress",
  revert: "Revert in progress",
};

const FINISH_LABEL: Record<GitOperation, string> = {
  merge: "Finish merge",
  rebase: "Continue rebase",
  "cherry-pick": "Continue cherry-pick",
  revert: "Continue revert",
};

const CANCEL_LABEL: Record<GitOperation, string> = {
  merge: "Cancel merge",
  rebase: "Cancel rebase",
  "cherry-pick": "Cancel cherry-pick",
  revert: "Cancel revert",
};

export function ConflictsPanel({ root }: { root: string }) {
  const t = useT();
  const gitStatus = useBench((s) => s.gitStatus);
  const conflict = useBench((s) => s.conflict);
  const openConflict = useBench((s) => s.openConflict);
  const closeConflict = useBench((s) => s.closeConflict);
  const setError = useBench((s) => s.setError);
  const refreshGitStatus = useBench((s) => s.refreshGitStatus);

  const [state, setState] = React.useState<ConflictState | null>(null);
  const [busy, setBusy] = React.useState<null | "finish" | "cancel">(null);
  const [asking, setAsking] = React.useState(false);

  const load = React.useCallback(() => {
    void conflictState(root)
      .then(setState)
      .catch(() => setState({ operation: null, files: [] }));
  }, [root]);

  // the heartbeat's status is the cue: resolving a file here or in a terminal moves it
  React.useEffect(load, [load, gitStatus]);

  const act = (kind: "finish" | "cancel", op: GitOperation) => {
    setError(null);
    setBusy(kind);
    void (kind === "finish" ? continueOperation(root, op) : abortOperation(root, op))
      .then(async (res) => {
        if (!res.ok) {
          const plain = explainGitError(res.output);
          if (plain) setError(t(plain), res.output);
          else setError(res.output || t("git refused."));
        }
        if (res.ok) closeConflict();
        await refreshGitStatus();
        load();
      })
      .finally(() => setBusy(null));
  };

  if (!state) return <p className="px-3 py-3 text-[11px] text-text-3">{t("reading…")}</p>;

  const { operation, files } = state;
  const remaining = files.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border-soft px-2 py-1.5">
        <GitMerge className="h-3.5 w-3.5 shrink-0 text-warn" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-text">
          {operation ? t(OPERATION_LABEL[operation]) : t("Conflicts")}
        </span>
        <button
          type="button"
          onClick={load}
          title={t("Reload")}
          aria-label={t("Reload")}
          className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <p className="px-2 pt-2 text-[10px] uppercase tracking-wide text-text-3">
          {remaining === 1 ? t("1 file to resolve") : t("{n} files to resolve", { n: remaining })}
        </p>
        {remaining === 0 ? (
          <p className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-success">
            <Check className="h-3.5 w-3.5" />
            {operation ? t("Everything is resolved. Finish to wrap it up.") : t("No conflicts.")}
          </p>
        ) : (
          <div className="py-1">
            {files.map((f) => {
              const name = f.path.split("/").pop() ?? f.path;
              const { Icon, tone } = fileGlyph(name);
              const open = conflict?.rel === f.path;
              return (
                <button
                  type="button"
                  key={f.path}
                  onClick={() => openConflict({ path: `${root}/${f.path}`, rel: f.path, name })}
                  title={f.path}
                  aria-current={open ? "true" : undefined}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-1.5 px-2 py-[3px] text-left text-[12px] transition-colors",
                    open ? "bg-accent-soft text-accent" : "text-text-2 hover:bg-surface-2 hover:text-text",
                  )}
                >
                  <span className="w-4 shrink-0 font-mono text-[10px] text-crit">!</span>
                  <Icon className={cn("h-3.5 w-3.5 shrink-0", tone)} />
                  <span className="min-w-0 flex-1 truncate">{f.path}</span>
                  {isDeleteConflict(f.code) && (
                    <span className="shrink-0 text-[10px] text-text-3">{t("deleted on one side")}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {operation && (
        <div className="shrink-0 border-t border-border bg-surface p-2">
          {remaining > 0 && (
            <p className="mb-2 flex items-start gap-1.5 text-[11px] text-text-3">
              <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-warn" />
              {t("Open each file, choose what to keep, and mark it resolved.")}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button
              variant="primary"
              size="sm"
              disabled={remaining > 0 || busy !== null}
              loading={busy === "finish"}
              onClick={() => act("finish", operation)}
            >
              <Check className="h-3.5 w-3.5" /> {t(FINISH_LABEL[operation])}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              loading={busy === "cancel"}
              onClick={() => setAsking(true)}
            >
              <Undo2 className="h-3.5 w-3.5" /> {t(CANCEL_LABEL[operation])}
            </Button>
          </div>
        </div>
      )}

      {operation && (
        <ConfirmDialog
          open={asking}
          onOpenChange={setAsking}
          danger
          title={t("{action}?", { action: t(CANCEL_LABEL[operation]) })}
          confirmLabel={t(CANCEL_LABEL[operation])}
          body={
            <p>
              {t(
                "The branch goes back to where it was before this started, and every choice made in these files is lost. Commit or save anything you want to keep before cancelling.",
              )}
            </p>
          }
          onConfirm={() => act("cancel", operation)}
        />
      )}
    </div>
  );
}
