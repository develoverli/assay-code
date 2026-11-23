import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import * as db from "@/lib/db";

/** System notifications for work that finishes while the window is hidden. Off by default. */

export const NOTIFY_SETTING = "notify.enabled";
/** Claude finishing a turn in a Workspace terminal. On unless turned off; only applies when notifications are on. */
export const AGENT_NOTIFY_SETTING = "notify.agents";

export async function agentNotificationsEnabled(): Promise<boolean> {
  return (await db.getSetting(AGENT_NOTIFY_SETTING)) !== "0";
}

export async function setAgentNotificationsEnabled(on: boolean): Promise<void> {
  await db.setSetting(AGENT_NOTIFY_SETTING, on ? "1" : "0");
}

let granted: boolean | null = null;

export async function notificationsEnabled(): Promise<boolean> {
  return (await db.getSetting(NOTIFY_SETTING)) === "1";
}

export async function setNotificationsEnabled(on: boolean): Promise<boolean> {
  // ask the OS again: it may have been granted in system settings since we last looked
  if (on) granted = null;
  if (on && !(await ensurePermission())) return false;
  await db.setSetting(NOTIFY_SETTING, on ? "1" : "0");
  return on;
}

/** Ask the OS once, and remember the answer for this session. */
export async function ensurePermission(): Promise<boolean> {
  if (granted !== null) return granted;
  try {
    granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  } catch {
    granted = false;
  }
  return granted;
}

/** Fire and forget: a notification that fails must never break a run. */
export async function notify(title: string, body: string): Promise<void> {
  try {
    if (!(await notificationsEnabled())) return;
    if (!(await ensurePermission())) return;
    sendNotification({ title, body });
  } catch {
    /* the OS said no, or the plugin is unavailable */
  }
}
