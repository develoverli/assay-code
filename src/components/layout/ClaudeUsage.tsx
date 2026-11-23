import { CalendarClock, Gauge, Timer } from "lucide-react";
import * as React from "react";
import { useClaudeUsage, type ContextReading } from "@/store/claude-usage";
import { shortUntil, usageTone, windowElapsed } from "@/lib/claude-limits";
import { useBench } from "@/store/bench";
import { useDates } from "@/lib/dates";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { LimitWindow } from "@/lib/agent-signals";

/**
 * Claude's plan limits and the active session's context, left of the memory
 * reading. Everything here comes from the status line of the Claude sessions
 * running in Workspace; with none ever opened, nothing is shown.
 */

/** How often the countdown is redrawn. Minutes are its resolution. */
const TICK_MS = 30_000;

/** `15.5k`, `1.2M` — token counts for a tooltip. */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const TONE = { danger: "text-danger", warn: "text-warn" } as const;

function Pct({ value }: { value: number }) {
  const tone = usageTone(value);
  return <span className={cn("tnum", tone && TONE[tone])}>{Math.round(value)}%</span>;
}

function useNow(): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/**
 * The context to show: the Claude terminal in front, else the one in this
 * project that reported last. Terminals of other projects never stand in.
 */
function useContext(): { title: string; reading: ContextReading } | null {
  const context = useClaudeUsage((s) => s.context);
  const terminals = useBench((s) => s.terminals);
  const projectId = useBench((s) => s.projectId);
  const active = useBench((s) => s.activeTerminal);
  return React.useMemo(() => {
    const mine = terminals.filter((x) => x.kind === "claude" && x.projectId === projectId && context[x.id]);
    const front = mine.find((x) => x.id === active);
    const latest = mine.reduce<(typeof mine)[number] | undefined>(
      (best, x) => (!best || context[x.id].at > context[best.id].at ? x : best),
      undefined,
    );
    const pick = front ?? latest;
    return pick ? { title: pick.title, reading: context[pick.id] } : null;
  }, [context, terminals, projectId, active]);
}

export function ClaudeUsage() {
  const t = useT();
  const { at, ago } = useDates();
  const limits = useClaudeUsage((s) => s.limits);
  const ctx = useContext();
  const now = useNow();
  if (!limits && !ctx) return null;

  const read = limits ? t("read {ago}", { ago: ago(limits.at) }) : "";
  const windowTitle = (label: string, w: LimitWindow) =>
    `${label}: ${Math.round(w.usedPercentage)}% · ${t("resets {when}", { when: at(w.resetsAt * 1000, "EEE d MMM, HH:mm") })} · ${read}`;

  return (
    <div className="flex min-w-0 items-center gap-3">
      {limits?.fiveHour && (
        <span className="flex shrink-0 items-center gap-1" title={windowTitle(t("5-hour window"), limits.fiveHour)}>
          <Timer className="h-3 w-3" aria-hidden />
          <span>5h</span>
          {windowElapsed(limits.fiveHour, now) ? (
            <span>{t("reset")}</span>
          ) : (
            <>
              <Pct value={limits.fiveHour.usedPercentage} />
              <span className="tnum">· {shortUntil(limits.fiveHour.resetsAt * 1000 - now)}</span>
            </>
          )}
        </span>
      )}
      {limits?.sevenDay && (
        <span className="flex shrink-0 items-center gap-1" title={windowTitle(t("Weekly limit"), limits.sevenDay)}>
          <CalendarClock className="h-3 w-3" aria-hidden />
          <span>{t("Week")}</span>
          {windowElapsed(limits.sevenDay, now) ? (
            <span>{t("reset")}</span>
          ) : (
            <>
              <Pct value={limits.sevenDay.usedPercentage} />
              <span>· {at(limits.sevenDay.resetsAt * 1000, "EEE HH:mm")}</span>
            </>
          )}
        </span>
      )}
      {ctx && (
        <span
          className="flex min-w-0 items-center gap-1"
          title={
            ctx.reading.usedTokens != null && ctx.reading.size
              ? `${t("Context of {name}", { name: ctx.title })}: ${compact(ctx.reading.usedTokens)} / ${compact(ctx.reading.size)} · ${ago(ctx.reading.at)}`
              : t("Context of {name}", { name: ctx.title })
          }
        >
          <Gauge className="h-3 w-3 shrink-0" aria-hidden />
          <span>{t("Ctx")}</span>
          <Pct value={ctx.reading.usedPercentage} />
          <span className="truncate">· {ctx.title}</span>
        </span>
      )}
    </div>
  );
}
