import type { LimitWindow } from "@/lib/agent-signals";

/** How Claude's plan limits read in the status bar. */

/** No tone below 80 %; `warn` from 80 %, `danger` from 95 %. */
export function usageTone(pct: number): "danger" | "warn" | null {
  if (pct >= 95) return "danger";
  if (pct >= 80) return "warn";
  return null;
}

/** A window whose reset time has passed no longer holds the percentage it had. */
export function windowElapsed(w: LimitWindow, now: number): boolean {
  return w.resetsAt * 1000 <= now;
}

/** `2h 10m`, `45m`, `<1m`: the time until a window resets, short enough for the bar. */
export function shortUntil(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "<1m";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}
