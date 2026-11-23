import type { UnlistenFn } from "@tauri-apps/api/event";
import * as React from "react";
import { useApp, runningRuns, useRunMetas, useRunningCount } from "@/store/app";
import { dirtyFiles, liveTerminals, useBench } from "@/store/bench";
import { ensureTray } from "@/lib/tray";
import { appWindow, nativeFrame } from "@/lib/window-frame";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { tr, useT } from "@/lib/i18n";

/**
 * Closing asks every time whether to minimize to the tray or quit: scans and
 * agent terminals outlive the window, and the right answer differs each time.
 */

const GLYPH = "h-[9px] w-[9px]";

function Minimize() {
  return (
    <svg viewBox="0 0 10 10" className={GLYPH} aria-hidden>
      <path d="M0 5h10" stroke="currentColor" strokeWidth={1} fill="none" />
    </svg>
  );
}

function Maximize() {
  return (
    <svg viewBox="0 0 10 10" className={GLYPH} aria-hidden>
      <rect x={0.5} y={0.5} width={9} height={9} stroke="currentColor" strokeWidth={1} fill="none" />
    </svg>
  );
}

function Restore() {
  return (
    <svg viewBox="0 0 10 10" className={GLYPH} aria-hidden>
      <g stroke="currentColor" strokeWidth={1} fill="none">
        <path d="M2.5 2.5V0.5h7v7h-2" />
        <rect x={0.5} y={2.5} width={7} height={7} />
      </g>
    </svg>
  );
}

function Close() {
  return (
    <svg viewBox="0 0 10 10" className={GLYPH} aria-hidden>
      <g stroke="currentColor" strokeWidth={1}>
        <path d="M0 0l10 10" />
        <path d="M10 0L0 10" />
      </g>
    </svg>
  );
}

function ControlButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-9 w-10 shrink-0 cursor-pointer items-center justify-center text-text-2 transition-colors",
        danger ? "hover:bg-danger hover:text-bg" : "hover:bg-surface-2 hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

/**
 * What quitting would kill or lose, by name. Mounted only while the quit
 * confirmation is open, so only then does it follow the arrays themselves.
 */
function AtRiskList() {
  const t = useT();
  const runs = useRunMetas();
  const terminals = useBench((s) => s.terminals);
  const files = useBench((s) => s.files);
  return (
    <ul className="mt-3 space-y-1">
      {runs.filter((r) => r.status === "running").map((r) => (
        <li key={r.runId} className="truncate font-mono text-[11px] text-text-3">
          {r.projectName} · {r.label}
        </li>
      ))}
      {liveTerminals(terminals).map((term) => (
        <li key={term.id} className="truncate font-mono text-[11px] text-text-3">
          {t("terminal")} · {term.title}
        </li>
      ))}
      {dirtyFiles(files).map((f) => (
        <li key={f.path} className="truncate font-mono text-[11px] text-text-3" title={f.path}>
          {t("unsaved")} · {f.name}
        </li>
      ))}
    </ul>
  );
}

/**
 * The window controls plus the guards on the window's life cycle: closing asks
 * tray or quit, quitting asks about work still going, and reloading is blocked
 * while anything is in flight. Always mounted; on macOS only the buttons are absent.
 */
export function WindowControls({ maximized }: { maximized: boolean }) {
  const cancel = useApp((s) => s.cancel);
  const setError = useApp((s) => s.setError);
  const t = useT();
  const closeTerminal = useBench((s) => s.closeTerminal);
  // counts, not arrays: the log stream rewrites `runs` many times a second and
  // every keystroke in an editor rewrites `files`, while a number changes only
  // when a run, a terminal or an unsaved edit starts or ends
  const running = useRunningCount();
  // a live agent in a Bench terminal is work in flight too, and dies with the app
  const liveTermCount = useBench((s) => liveTerminals(s.terminals).length);
  const busy = running + liveTermCount;
  // editors from every project: a tab hidden behind a project switch is exactly
  // the one whose unsaved work would go quietly
  const unsavedCount = useBench((s) => dirtyFiles(s.files).length);
  const atRisk = busy + unsavedCount;

  const [closing, setClosing] = React.useState(false);
  const [quitting, setQuitting] = React.useState(false);

  // read the live counts inside listeners without re-registering them
  const busyRef = React.useRef(busy);
  const unsavedRef = React.useRef(unsavedCount);
  React.useEffect(() => {
    busyRef.current = busy;
    unsavedRef.current = unsavedCount;
  }, [busy, unsavedCount]);
  // quitting loses unsaved editors too, so that door asks about them as well
  const riskRef = React.useRef(atRisk);
  React.useEffect(() => {
    riskRef.current = atRisk;
  }, [atRisk]);
  // `what` is the English key; it reaches the error bar in the user's language
  const fail = React.useCallback(
    (what: string) => (e: unknown) =>
      setError(`${tr(what)}: ${e instanceof Error ? e.message : String(e)}`),
    [setError],
  );

  const hideToTray = React.useCallback(() => {
    appWindow.hide().catch(fail("Could not hide the window"));
  }, [fail]);

  /** Every close path lands here: the X, Alt+F4, the window menu. */
  const requestClose = React.useCallback(() => setClosing(true), []);

  const showWindow = React.useCallback(async () => {
    await appWindow.show();
    await appWindow.unminimize();
    await appWindow.setFocus();
  }, []);

  // ── tray: the only way back in, and the only way out ──────────────────────
  React.useEffect(() => {
    void ensureTray(
      {
        onToggleWindow: () => {
          void (async () => {
            if (await appWindow.isVisible()) hideToTray();
            else await showWindow();
          })().catch(fail("Tray toggle failed"));
        },
        onQuit: () => {
          void (async () => {
            if (riskRef.current > 0) {
              await showWindow();
              setQuitting(true);
            } else {
              await appWindow.destroy();
            }
          })().catch(fail("Quit failed"));
        },
      },
      busy,
    ).catch(fail("Tray unavailable"));
  }, [busy, fail, hideToTray, showWindow]);

  // ── the native close path (Alt+F4, the OS menu) asks too ──────────────────
  React.useEffect(() => {
    let alive = true;
    let unlisten: UnlistenFn | undefined;
    appWindow
      .onCloseRequested((e) => {
        e.preventDefault();
        requestClose();
      })
      .then((un) => {
        if (alive) unlisten = un;
        else un();
      })
      .catch(fail("Close guard unavailable"));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [fail, requestClose]);

  // ── reloading mid-run orphans the child processes, and drops unsaved edits ─
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const reload =
        e.key === "F5" || ((e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R"));
      const n = busyRef.current;
      const files = unsavedRef.current;
      if (!reload || n + files === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const why: string[] = [];
      if (n === 1) why.push(t("1 process is still going (a run or a Bench terminal) — close it before reloading."));
      else if (n > 1)
        why.push(t("{n} processes are still going (runs or Bench terminals) — close them before reloading.", { n }));
      if (files === 1) why.push(t("1 open file has changes that are not on disk — save it before reloading."));
      else if (files > 1)
        why.push(t("{n} open files have changes that are not on disk — save them before reloading.", { n: files }));
      setError(why.join(" "));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [setError, t]);

  const chooseTray = React.useCallback(() => {
    setClosing(false);
    hideToTray();
  }, [hideToTray]);

  /** Quit for real; with work in flight, through the same confirmation as the tray's Quit. */
  const chooseQuit = React.useCallback(() => {
    setClosing(false);
    if (riskRef.current > 0) setQuitting(true);
    else appWindow.destroy().catch(fail("Quit failed"));
  }, [fail]);

  // reads what is in flight at the moment of the click, so it needs no array deps
  const cancelAllAndQuit = React.useCallback(() => {
    void (async () => {
      await Promise.allSettled([
        ...runningRuns(useApp.getState().runs).map((r) => cancel(r.runId)),
        ...liveTerminals(useBench.getState().terminals).map((term) => closeTerminal(term.id)),
      ]);
      await appWindow.destroy();
    })().catch(fail("Quit failed"));
  }, [cancel, closeTerminal, fail]);

  return (
    <>
      {!nativeFrame && (
        <div className="relative z-40 -mr-3 flex shrink-0 self-stretch">
          <ControlButton
            label={t("Minimize")}
            onClick={() => appWindow.minimize().catch(fail("Minimize failed"))}
          >
            <Minimize />
          </ControlButton>
          <ControlButton
            label={maximized ? t("Restore") : t("Maximize")}
            onClick={() => appWindow.toggleMaximize().catch(fail("Maximize failed"))}
          >
            {maximized ? <Restore /> : <Maximize />}
          </ControlButton>
          <ControlButton label={t("Close")} onClick={requestClose} danger>
            <Close />
          </ControlButton>
        </div>
      )}

      <Dialog open={closing} onOpenChange={(o) => !o && setClosing(false)}>
        <DialogContent title={t("Close Assay?")}>
          <p className="text-[13px] leading-relaxed text-text-2">
            {t(
              "Minimizing hides the window and leaves the icon in the tray, next to the clock — scans and terminals carry on. Quitting closes Assay for good.",
            )}
          </p>
          {busy > 0 && (
            <p className="mt-2 text-[13px] leading-relaxed text-warn">
              {busy === 1
                ? t("1 process is still going. Minimizing keeps it alive; quitting kills it.")
                : t("{n} processes are still going. Minimizing keeps them alive; quitting kills them.", {
                    n: busy,
                  })}
            </p>
          )}
          {unsavedCount > 0 && (
            <p className="mt-2 text-[13px] leading-relaxed text-warn">
              {unsavedCount === 1
                ? t("1 open file has changes that are not on disk. Quitting loses them.")
                : t("{n} open files have changes that are not on disk. Quitting loses them.", {
                    n: unsavedCount,
                  })}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setClosing(false)}>
              {t("Cancel")}
            </Button>
            <Button variant="secondary" onClick={chooseQuit}>
              {t("Quit completely")}
            </Button>
            <Button variant="primary" onClick={chooseTray}>
              {t("Minimize to the tray")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={quitting}
        onOpenChange={setQuitting}
        title={t("Quit with work in flight?")}
        body={
          <>
            {busy > 0 && (
              <p>
                {busy === 1
                  ? t(
                      "1 process is still going. Quitting kills it — partial scan output and anything an agent was doing in a terminal is lost.",
                    )
                  : t(
                      "{n} processes are still going. Quitting kills them — partial scan output and anything an agent was doing in a terminal is lost.",
                      { n: busy },
                    )}
              </p>
            )}
            {unsavedCount > 0 && (
              <p className={busy > 0 ? "mt-2" : undefined}>
                {unsavedCount === 1
                  ? t("1 open file has changes that are not on disk. Quitting loses them.")
                  : t("{n} open files have changes that are not on disk. Quitting loses them.", {
                      n: unsavedCount,
                    })}
              </p>
            )}
            <AtRiskList />
          </>
        }
        confirmLabel={busy > 0 ? t("Kill everything & quit") : t("Discard & quit")}
        danger
        onConfirm={cancelAllAndQuit}
      />
    </>
  );
}
