import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, Download, ExternalLink } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { AtRiskList } from "@/components/layout/WindowChrome";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/primitives";
import { useDates } from "@/lib/dates";
import { useT } from "@/lib/i18n";
import { canSelfUpdate, formatBytes, percent, releaseTime, releaseUrl } from "@/lib/updater";
import { cn } from "@/lib/utils";
import { useRunningCount } from "@/store/app";
import { dirtyFiles, liveTerminals, useBench } from "@/store/bench";
import { activeTunnels, usePorts } from "@/store/ports";
import { chipVisible, useUpdater } from "@/store/updater";

/**
 * The header's update chip and its dialog. The chip only appears when there is
 * something to say; the dialog says what changed and lets the user choose when.
 */

const DEV = import.meta.env.DEV;

/** Work an install would end, counted the way the quit confirmation counts it. */
function useAtRiskCount(): number {
  const runs = useRunningCount();
  const terminals = useBench((s) => liveTerminals(s.terminals).length);
  const unsaved = useBench((s) => dirtyFiles(s.files).length);
  const links = usePorts((s) => activeTunnels(s.tunnels).length);
  return runs + terminals + unsaved + links;
}

function UpdateDialog() {
  const t = useT();
  const { ago } = useDates();
  const s = useUpdater(
    useShallow((st) => ({
      open: st.dialogOpen,
      phase: st.phase,
      update: st.update,
      downloaded: st.downloaded,
      total: st.total,
      error: st.error,
      kind: st.kind,
      onQuit: st.onQuit,
    })),
  );
  const setOpen = useUpdater((st) => st.setDialogOpen);
  const installNow = useUpdater((st) => st.installNow);
  const installOnQuit = useUpdater((st) => st.installOnQuit);
  const skip = useUpdater((st) => st.skip);
  const atRisk = useAtRiskCount();
  if (!s.update) return null;

  const { version, current, notes, date } = s.update;
  const selfUpdate = canSelfUpdate(s.kind) && !DEV;
  const busyPhase = s.phase === "downloading" || s.phase === "installing";
  const pct = percent(s.downloaded, s.total);
  const released = releaseTime(date);

  return (
    <Dialog open={s.open} onOpenChange={setOpen}>
      <DialogContent title={t("Assay {version} is available", { version })}>
        <div className="flex flex-col gap-3 text-[13px] leading-relaxed text-text-2">
          <p>
            {t("You have {current}.", { current })}
            {released && <span className="text-text-3"> {t("Released {when}.", { when: ago(released) })}</span>}
          </p>

          {notes.trim() && (
            <pre className="selectable max-h-48 overflow-auto rounded-md border border-border bg-surface-2 p-2.5 font-sans text-[12px] leading-relaxed whitespace-pre-wrap text-text-2">
              {notes.trim()}
            </pre>
          )}
          <button
            type="button"
            onClick={() => void openUrl(releaseUrl(version))}
            className="flex cursor-pointer items-center gap-1 self-start rounded text-[12px] text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <ExternalLink className="h-3.5 w-3.5" /> {t("Release page on GitHub")}
          </button>

          {s.kind === "package" && (
            <p className="text-warn">
              {t("This copy was installed from a .deb or .rpm package, which Assay cannot replace by itself. Download the new version from the release page.")}
            </p>
          )}
          {DEV && s.kind !== "package" && (
            <p className="text-text-3">{t("This is a development run; only an installed copy can update itself.")}</p>
          )}

          {s.phase === "downloading" && (
            <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                {/* scaled, not resized: transform animates without re-laying out the dialog */}
                <div
                  className="h-full origin-left rounded-full bg-accent transition-transform duration-200 ease-out"
                  style={{ transform: `scaleX(${(pct ?? 15) / 100})` }}
                />
              </div>
              <p className="tnum text-[11px] text-text-3">
                {s.total
                  ? t("Downloading… {done} of {total}", { done: formatBytes(s.downloaded), total: formatBytes(s.total) })
                  : t("Downloading…")}
              </p>
            </div>
          )}
          {s.phase === "installing" && <p className="text-text-3">{t("Installing… Assay restarts in a moment.")}</p>}
          {s.onQuit && s.phase === "ready" && (
            <p className="text-success">{t("Downloaded and verified. It installs when you quit Assay.")}</p>
          )}
          {s.error && (
            <p role="alert" className="selectable text-danger">
              {t("The update failed: {error}", { error: s.error })}
            </p>
          )}

          {selfUpdate && atRisk > 0 && !busyPhase && (
            <div className="rounded-md border border-warn/30 bg-warn/10 p-2.5">
              <p className="flex items-center gap-1.5 text-warn">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {t("Updating now restarts Assay and ends this work:")}
              </p>
              <AtRiskList />
            </div>
          )}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {!s.onQuit && (
            <Button variant="ghost" className="mr-auto" disabled={busyPhase} onClick={() => void skip()}>
              {t("Skip this version")}
            </Button>
          )}
          {s.kind === "package" ? (
            <Button variant="primary" onClick={() => void openUrl(releaseUrl(version))}>
              <ExternalLink className="h-3.5 w-3.5" /> {t("Open the release page")}
            </Button>
          ) : (
            <>
              {!s.onQuit && (
                <Button
                  variant="secondary"
                  disabled={!selfUpdate || busyPhase}
                  title={!selfUpdate ? t("This is a development run; only an installed copy can update itself.") : undefined}
                  onClick={() => void installOnQuit()}
                >
                  {t("Install when I quit")}
                </Button>
              )}
              <Button
                variant={atRisk > 0 ? "danger" : "primary"}
                disabled={!selfUpdate || busyPhase}
                loading={busyPhase}
                title={!selfUpdate ? t("This is a development run; only an installed copy can update itself.") : undefined}
                onClick={() => void installNow()}
              >
                <Download className="h-3.5 w-3.5" />
                {atRisk > 0 ? t("Close everything and update") : t("Update and restart")}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function UpdateChip() {
  const t = useT();
  const visible = useUpdater((s) => chipVisible(s));
  const phase = useUpdater((s) => s.phase);
  const version = useUpdater((s) => s.update?.version ?? "");
  const onQuit = useUpdater((s) => s.onQuit);
  const pct = useUpdater((s) => percent(s.downloaded, s.total));
  const setOpen = useUpdater((s) => s.setDialogOpen);

  let label = t("{version} available", { version: `v${version}` });
  if (phase === "downloading") label = pct === null ? t("Downloading…") : t("Downloading {pct}%", { pct });
  else if (phase === "installing") label = t("Installing…");
  else if (phase === "ready" && onQuit) label = t("Updates when you quit");
  else if (phase === "error") label = t("Update failed");

  return (
    <>
      {visible && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={t("Assay {version} is available", { version })}
          className={cn(
            "tnum flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11px] font-medium transition-colors",
            "focus-visible:outline-2 focus-visible:outline-accent",
            phase === "error" ? "bg-danger/10 text-danger hover:bg-danger/20" : "bg-accent-soft text-accent hover:bg-accent-soft/70",
          )}
        >
          <Download className={cn("h-3.5 w-3.5", phase === "downloading" && "animate-pulse")} />
          {label}
        </button>
      )}
      <UpdateDialog />
    </>
  );
}
