import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { platform } from "@tauri-apps/plugin-os";
import * as React from "react";

export const appWindow = getCurrentWindow();

/**
 * macOS keeps its native frame (traffic lights over the content via
 * `titleBarStyle: "Overlay"`), so the app only draws its own controls on
 * Windows and Linux, where the window is undecorated.
 */
export const nativeFrame: boolean = (() => {
  try {
    return platform() === "macos";
  } catch {
    return false;
  }
})();

/** Width reserved for the macOS traffic lights sitting on top of the sidebar. */
export const macTrafficLightInset = 70;

/**
 * Tracks the maximized state so the frame can drop its radius and border when
 * the window is flush against the screen edges.
 */
export function useMaximized(): boolean {
  const [maximized, setMaximized] = React.useState(false);
  React.useEffect(() => {
    if (nativeFrame) return;
    let alive = true;
    let unlisten: UnlistenFn | undefined;
    const sync = () => {
      appWindow
        .isMaximized()
        .then((m) => {
          if (alive) setMaximized(m);
        })
        .catch(() => {});
    };
    sync();
    appWindow
      .onResized(sync)
      .then((un) => {
        if (alive) unlisten = un;
        else un();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);
  return maximized;
}

/** Mirrors the frame state onto <html> so the CSS can square off the corners. */
export function useFrameStyling(maximized: boolean): void {
  React.useEffect(() => {
    const root = document.documentElement;
    root.dataset.nativeFrame = String(nativeFrame);
    root.dataset.maximized = String(maximized);
  }, [maximized]);
}
