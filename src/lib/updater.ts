import { invoke } from "@tauri-apps/api/core";

/**
 * Self-update, the pure half. The updater plugin reads `latest.json` from the
 * newest *published* GitHub release (a draft is invisible to it, which is the
 * point: publishing is the act that ships), checks the minisign signature against
 * the public key compiled into the app, and installs. Nothing about the user is
 * sent; the request is a plain GET of that file.
 */

/** On unless the user turned it off; stored as "off" only. */
export const AUTO_SETTING = "updates.auto";
/** The version the user chose to skip; the chip stays away until a newer one. */
export const SKIP_SETTING = "updates.skipped";

/** After launch, so the check never competes with the boot. */
export const FIRST_CHECK_DELAY_MS = 15_000;
/** Assay lives in the tray for days; once a launch is not enough. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const RELEASES = "https://github.com/develoverli/assay-code/releases";

/** How this copy was installed: only `bundle` and `appimage` can replace themselves. */
export type InstallKind = "bundle" | "appimage" | "package";

export function canSelfUpdate(kind: InstallKind): boolean {
  return kind !== "package";
}

/** Whether an available version should show at all. */
export function shouldOffer(available: string, skipped: string | null): boolean {
  return available !== skipped;
}

/** The release page of one version, for notes and for installs that update by hand. */
export function releaseUrl(version: string): string {
  return `${RELEASES}/tag/v${version.replace(/^v/, "")}`;
}

/** Bytes as the dialog shows them: `12.4 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Download progress 0–100, or null while the size is unknown. */
export function percent(downloaded: number, total: number | null): number | null {
  if (!total) return null;
  return Math.min(100, Math.round((downloaded / total) * 100));
}

/**
 * The release time, in ms. The plugin hands `pub_date` back in the `time` crate's
 * own format (`2026-11-20 10:00:00.0 +00:00:00`), which `Date.parse` refuses, so
 * the date part alone is the fallback.
 */
export function releaseTime(date: string | null): number | null {
  if (!date) return null;
  const full = Date.parse(date);
  if (Number.isFinite(full)) return full;
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(date.trim());
  const ms = day ? Date.parse(`${day[1]}T00:00:00Z`) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export async function installKind(): Promise<InstallKind> {
  const kind = await invoke<string>("install_kind");
  return kind === "appimage" || kind === "package" ? kind : "bundle";
}
