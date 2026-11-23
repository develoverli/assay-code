import { invoke } from "@tauri-apps/api/core";

/**
 * Launch at login. The state is read from the OS every time (the user can change
 * it there too), never cached in the DB. Uses `invoke` directly to avoid the
 * plugin's npm wrapper as a dependency.
 */

export async function autostartEnabled(): Promise<boolean> {
  try {
    return await invoke<boolean>("plugin:autostart|is_enabled");
  } catch {
    // unsupported platform or a revoked permission: not enabled, and not an error
    return false;
  }
}

/** Asks the OS to change it, then reads the state back so a failed change shows. */
export async function setAutostartEnabled(on: boolean): Promise<boolean> {
  try {
    await invoke(on ? "plugin:autostart|enable" : "plugin:autostart|disable");
  } catch {
    /* fall through to the read: it is the only thing worth trusting */
  }
  return autostartEnabled();
}
