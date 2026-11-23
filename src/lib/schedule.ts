import * as db from "@/lib/db";
import { useApp, runningRuns } from "@/store/app";

/**
 * Unattended scans. Off by default and never while another run is going. The
 * interval is a floor: the check runs every few minutes and skips what isn't due.
 */

export const SCHEDULE_SETTING = "schedule.hours";

/** Options the Settings card offers, in hours. 0 is off. */
export const SCHEDULE_CHOICES = [0, 6, 12, 24, 168];

const CHECK_EVERY_MS = 5 * 60 * 1000;

export async function scheduleHours(): Promise<number> {
  const raw = await db.getSetting(SCHEDULE_SETTING).catch(() => null);
  const n = Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function setScheduleHours(hours: number): Promise<void> {
  await db.setSetting(SCHEDULE_SETTING, String(hours));
}

/** The projects whose last scan is older than the interval. */
async function due(hours: number): Promise<string[]> {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const projects = useApp.getState().projects;
  const checked = await Promise.all(
    projects.map(async (p) => {
      const scannable = !!p.path || (!!p.url && p.authorized);
      if (!scannable) return null;
      const runs = await db.listScanRuns(p.id, 1).catch(() => []);
      const last = runs[0]?.started_at ?? 0;
      return last < cutoff ? p.id : null;
    }),
  );
  return checked.filter((id): id is string => id !== null);
}

async function tick(): Promise<void> {
  const hours = await scheduleHours();
  if (!hours) return;
  const state = useApp.getState();
  if (!state.ready || runningRuns(state.runs).length) return;
  const ids = await due(hours);
  // one project per tick: the next one gets its turn in five minutes
  // unattended: nobody worked on the project, so it keeps its place in the list
  if (ids[0]) await state.scanAll(ids[0], undefined, { unattended: true });
}

/** Starts the loop and returns the function that stops it. */
export function startScheduler(): () => void {
  const timer = window.setInterval(() => {
    void tick().catch(() => {});
  }, CHECK_EVERY_MS);
  return () => window.clearInterval(timer);
}
