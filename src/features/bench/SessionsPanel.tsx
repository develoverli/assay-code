import { MessagesSquare, Play, RefreshCw, User } from "lucide-react";
import * as React from "react";
import { listSessions, type AgentSession } from "@/lib/sessions";
import { useBench } from "@/store/bench";
import { useT } from "@/lib/i18n";
import { useDates } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { launcherGlyph } from "./icons";

/**
 * The Claude Code sessions already on disk for this project. Each row shows the
 * task, who spoke last and what they said, so it is recognisable without opening.
 */

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function SessionRow({ session, onResume }: { session: AgentSession; onResume: () => void }) {
  const t = useT();
  const dates = useDates();
  const { Icon, tone } = launcherGlyph("claude");
  const fromAgent = session.lastRole === "assistant";
  const Speaker = fromAgent ? Icon : User;

  return (
    <div className="group flex items-start gap-2 border-b border-border-soft px-2 py-2 last:border-b-0 hover:bg-surface-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-medium text-text" title={session.title || session.id}>
          {session.title || t("Untitled session")}
        </p>

        {session.lastText && (
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-text-2">
            <span className={cn("font-medium", fromAgent ? tone : "text-text-3")}>
              {fromAgent ? t("Agent:") : t("You:")}
            </span>{" "}
            {session.lastText}
          </p>
        )}

        <p className="mt-1 flex items-center gap-1.5 text-[10px] text-text-3">
          <Speaker className={cn("h-3 w-3 shrink-0", fromAgent ? tone : "text-text-3")} />
          <span>Claude</span>
          {session.messages > 0 && (
            <>
              <span aria-hidden>·</span>
              <span className="tnum">{t("{n} msgs", { n: session.messages })}</span>
            </>
          )}
          <span aria-hidden>·</span>
          <span className="tnum">
            {session.modified ? dates.ago(session.modified) : size(session.bytes)}
          </span>
        </p>
      </div>

      <button
        type="button"
        onClick={onResume}
        title={t("Resume this session in a terminal")}
        aria-label={t("Resume this session in a terminal")}
        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-text-3 transition-colors hover:bg-surface hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Play className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function SessionsPanel({ root }: { root: string }) {
  const t = useT();
  const resumeSession = useBench((s) => s.resumeSession);
  const [sessions, setSessions] = React.useState<AgentSession[] | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    setBusy(true);
    void listSessions(root)
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setBusy(false));
  }, [root]);

  React.useEffect(load, [load]);

  let body: React.ReactNode;
  if (sessions === null) {
    body = <p className="px-3 py-3 text-[11px] text-text-3">{t("reading…")}</p>;
  } else if (sessions.length === 0) {
    body = (
      <p className="px-3 py-3 text-[11px] leading-relaxed text-text-3">
        {t("No Claude sessions recorded for this folder yet. Start one from the + menu and it shows up here.")}
      </p>
    );
  } else {
    body = sessions.map((s) => (
      <SessionRow key={s.id} session={s} onResume={() => void resumeSession(s.id, root)} />
    ));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border-soft px-2 py-1.5">
        <MessagesSquare className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 text-[10px] uppercase tracking-wide text-text-3">
          {t("Claude sessions")}
        </span>
        <button
          type="button"
          onClick={load}
          title={t("Reload")}
          aria-label={t("Reload")}
          className="flex h-5 w-5 cursor-pointer items-center justify-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
        >
          <RefreshCw className={cn("h-3 w-3", busy && "animate-spin")} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
    </div>
  );
}
