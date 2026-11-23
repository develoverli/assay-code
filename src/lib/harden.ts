/**
 * Production only: drop the webview's own context menu and browser shortcuts
 * (reload loses in-flight state). This does not make the bundled JS private.
 */

/**
 * `swallow` also stops the app's own listeners; `suppress` only cancels the browser
 * default (Ctrl+P must skip the print dialog yet still reach quick-open).
 */
type KeyVerdict = "swallow" | "suppress" | "allow";

function verdict(e: KeyboardEvent): KeyVerdict {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toUpperCase();
  if (e.key === "F5" || e.key === "F12") return "swallow";
  if (mod && key === "R") return "swallow"; // reload, plain and hard
  if (mod && key === "U") return "swallow"; // view source
  if (mod && e.shiftKey && ["I", "J", "C"].includes(key)) return "swallow";
  if (mod && key === "P" && !e.shiftKey) return "suppress"; // print, but quick-open still runs
  if (mod && key === "S" && !e.shiftKey) return "suppress"; // save page, but Ctrl+S is ours
  return "allow";
}

/** Where a native context menu is still the right answer. */
function wantsNativeMenu(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  // Monaco draws its own menu on top of this event; text fields need theirs
  return !!el.closest(".monaco-editor, input, textarea, [contenteditable='true']");
}

export function hardenWebview(): void {
  if (!import.meta.env.PROD) return;

  window.addEventListener(
    "keydown",
    (e) => {
      const what = verdict(e);
      if (what === "allow") return;
      e.preventDefault();
      if (what === "swallow") e.stopPropagation();
    },
    true,
  );

  window.addEventListener(
    "contextmenu",
    (e) => {
      if (wantsNativeMenu(e.target)) return;
      e.preventDefault();
    },
    true,
  );

  // a file dropped on a webview navigates it away and the app disappears
  for (const type of ["dragover", "drop"] as const) {
    window.addEventListener(type, (e) => e.preventDefault(), true);
  }
}
