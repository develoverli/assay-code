import { useEffect } from "react";
import { useApp } from "@/store/app";
import { useLang, useT } from "@/lib/i18n";
import { startScheduler } from "@/lib/schedule";
import { onAgentStatus, onAgentStop } from "@/lib/agent-signals";
import { useClaudeUsage } from "@/store/claude-usage";
import { useBench } from "@/store/bench";
import { useUI } from "@/store/ui";
import { usePorts } from "@/store/ports";
import { useUpdater } from "@/store/updater";
import { AppShell } from "@/components/layout/AppShell";
import { Spinner } from "@/components/ui/primitives";

export default function App() {
  const ready = useApp((s) => s.ready);
  const init = useApp((s) => s.init);
  const setError = useApp((s) => s.setError);
  const initLang = useLang((s) => s.init);
  const langReady = useLang((s) => s.ready);
  const t = useT();

  useEffect(() => {
    init().catch((e) => setError((e as Error).message));
  }, [init, setError]);

  // the stored language is read first, so no copy flashes in the wrong one
  useEffect(() => {
    void initLang();
  }, [initLang]);

  // public links held in Rust survive a reload; pick them back up, and start the
  // heartbeat that closes one whose server stopped listening
  useEffect(() => {
    usePorts.getState().init().catch(() => undefined);
  }, []);

  // a new version on GitHub Releases: looked for after launch and every 6 h, unless turned off
  useEffect(() => {
    useUpdater.getState().init().catch(() => undefined);
  }, []);

  // unattended scans, if the user turned them on
  useEffect(() => startScheduler(), []);

  // Claude finishing a turn in a Workspace terminal, from anywhere in the app
  useEffect(() => {
    void useClaudeUsage.getState().load();
    const offStatus = onAgentStatus((e) => useClaudeUsage.getState().apply(e));
    const off = onAgentStop((e) => void useBench.getState().agentStopped(e));
    // refocusing the window with that terminal in front clears its attention dot
    const onFocus = () => {
      const b = useBench.getState();
      if (useUI.getState().view === "bench" && b.focus === "terminal" && b.activeTerminal && b.attention[b.activeTerminal])
        b.setActiveTerminal(b.activeTerminal);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      void off.then((f) => f());
      void offStatus.then((f) => f());
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!ready || !langReady) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-bg text-text-3">
        <Spinner className="h-5 w-5" />
        <p className="text-xs">{t("Loading Assay…")}</p>
      </div>
    );
  }
  return <AppShell />;
}
