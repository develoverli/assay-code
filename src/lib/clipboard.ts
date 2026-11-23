import { invoke } from "@tauri-apps/api/core";

/**
 * Copy and paste that work inside a webview. In the shipped window the native paste
 * does not always arrive, so this watches for it and steps in a beat later only when
 * it never came: the shortcut is never cancelled and text is never pasted twice.
 *
 * Reads go through Rust (`tauri-plugin-clipboard-manager` commands, invoked directly
 * with no npm wrapper), falling back to `navigator.clipboard` for `pnpm dev`.
 */

/** When Chromium last delivered a real paste, so the fallback can stand down. */
let lastNativePaste = 0;
/** How long after a keystroke the native event is still plausibly on its way. */
const NATIVE_GRACE_MS = 250;
/** Long enough for Chromium to have fired its own paste, short enough to feel instant. */
const FALLBACK_DELAY_MS = 60;

function noteNativePaste(): void {
  lastNativePaste = Date.now();
}

/** True when the webview already pasted this, and doing it again would duplicate it. */
function nativePasteHappened(): boolean {
  return Date.now() - lastNativePaste < NATIVE_GRACE_MS;
}

/** The clipboard, or an empty string when neither route can read it. */
async function readClipboard(): Promise<string> {
  try {
    return (await invoke<string>("plugin:clipboard-manager|read_text")) ?? "";
  } catch {
    /* no Rust behind the window: the browser is the only route left */
  }
  try {
    return (await navigator.clipboard.readText()) ?? "";
  } catch {
    return "";
  }
}

export async function writeClipboard(text: string): Promise<void> {
  if (!text) return;
  try {
    await invoke("plugin:clipboard-manager|write_text", { text, label: null });
    return;
  } catch {
    /* same fallback, the other way round */
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* nothing to do: the selection stays where it is */
  }
}

/* --------------------------- files and images ------------------------------ */

/** The paths a file manager put on the clipboard (copying a file leaves no text). */
async function clipboardFilePaths(): Promise<string[]> {
  try {
    return (await invoke<string[]>("clipboard_files")) ?? [];
  } catch {
    /* browser, or a clipboard that holds no file list */
    return [];
  }
}

/**
 * The clipboard's image, written by Rust to a temp PNG; the path is what an agent can
 * act on, and the raw pixels never enter the webview.
 */
async function clipboardImageFile(): Promise<string | null> {
  try {
    return (await invoke<string | null>("clipboard_image_to_temp_file")) ?? null;
  } catch {
    /* no Rust behind the window, or an image too large to be worth a paste */
    return null;
  }
}

/** The paths behind a paste when the clipboard holds no text: copied files, else the image. */
async function clipboardPaths(): Promise<string[]> {
  const files = await clipboardFilePaths();
  if (files.length) return files;
  const image = await clipboardImageFile();
  return image ? [image] : [];
}

/** Those paths in a plain text field: absolute, slash separated, unquoted (no shell reads it). */
export function clipboardPathText(paths: string[]): string {
  return paths.map((p) => p.replace(/\\/g, "/")).join(" ");
}

/**
 * What a paste means in a terminal: text first, then copied files' paths, then the
 * clipboard image as a temp file. `format` turns paths into a line for the session's shell.
 */
export function pasteIntoTerminal(
  paste: (text: string) => void,
  format: (paths: string[]) => Promise<string>,
): void {
  window.setTimeout(() => {
    void (async () => {
      const text = await readClipboard();
      if (text) {
        // the webview may have pasted this already; pasting it twice is worse
        if (!nativePasteHappened()) paste(text);
        return;
      }
      const paths = await clipboardPaths();
      if (!paths.length) return;
      const line = await format(paths);
      if (line) paste(line);
    })();
  }, FALLBACK_DELAY_MS);
}

/** The same three answers, for a text field instead of a terminal. */
function pasteIntoField(insert: (text: string) => void): void {
  window.setTimeout(() => {
    void (async () => {
      const text = await readClipboard();
      if (text) {
        if (!nativePasteHappened()) insert(text);
        return;
      }
      await pasteFieldNow(insert);
    })();
  }, FALLBACK_DELAY_MS);
}

/** The right-click half: no native paste is coming, so nothing waits for one. */
async function pasteFieldNow(insert: (text: string) => void): Promise<void> {
  const text = await readClipboard();
  if (text) {
    insert(text);
    return;
  }
  const line = clipboardPathText(await clipboardPaths());
  if (line) insert(line);
}

/* ------------------------------- text fields -------------------------------- */
type TextField = HTMLInputElement | HTMLTextAreaElement;

function editableAt(target: EventTarget | null): TextField | HTMLElement | null {
  const el = target instanceof Element ? target : null;
  if (!el) return null;
  // Monaco brings its own menu, its own clipboard and its own undo stack
  if (el.closest(".monaco-editor")) return null;
  const field = el.closest("input, textarea, [contenteditable='true']");
  if (!(field instanceof HTMLElement)) return null;
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    return field.readOnly || field.disabled ? null : field;
  }
  return field;
}

function selectionIn(field: TextField | HTMLElement): string {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    return field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
  }
  return window.getSelection()?.toString() ?? "";
}

/**
 * Type text into a field as if the user had. `insertText` keeps React and the undo
 * stack in sync; assigning `value` directly would bypass both.
 */
function insertText(field: TextField | HTMLElement, text: string): void {
  field.focus();
  if (document.execCommand("insertText", false, text)) return;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText(text, start, end, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Clipboard fallback for every text field in the app. Right-click follows the
 * terminal's rule: with a selection it copies, without one it pastes.
 */
export function installClipboardFallback(): void {
  document.addEventListener("paste", noteNativePaste, true);

  document.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toUpperCase();
      if (key !== "V") return;
      const field = editableAt(e.target);
      if (!field) return;
      // the shortcut is left alone: if the webview pastes, this never fires
      pasteIntoField((text) => insertText(field, text));
    },
    true,
  );

  document.addEventListener(
    "contextmenu",
    (e) => {
      const field = editableAt(e.target);
      if (!field) return;
      const selected = selectionIn(field);
      e.preventDefault();
      if (selected) void writeClipboard(selected);
      else void pasteFieldNow((text) => insertText(field, text));
    },
    true,
  );
}
