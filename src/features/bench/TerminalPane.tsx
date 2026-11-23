import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import * as React from "react";
import { onPtyData, onPtyExit, ptyResize, ptyScrollback, ptyWrite } from "@/lib/pty";
import { useBench } from "@/store/bench";
import { useT } from "@/lib/i18n";
import { pasteIntoTerminal, writeClipboard } from "@/lib/clipboard";
import { droppedPathText, resolveShell } from "@/lib/bench-term";
import { registerTerminalLinks } from "./terminal-links";

/**
 * The terminals, over real PTYs. Each session owns a detached DOM node moved in
 * and out of the pane; xterm instances and the output bridge live outside React
 * so a tab switch, view change or remount never loses a session's screen.
 */

interface Attached {
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
}

const attached = new Map<string, Attached>();
let bridge: Promise<void> | null = null;

/**
 * A design token from globals.css, where every one used here is always defined. Should one ever
 * read empty, xterm keeps its own default for that slot rather than a colour invented here.
 */
const token = (name: string): string | undefined =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;

/** One subscription for the whole app, independent of what is mounted. */
function ensureBridge(): Promise<void> {
  if (!bridge) {
    bridge = (async () => {
      await onPtyData(({ id, data }) => attached.get(id)?.term.write(data));
      await onPtyExit((id) => {
        attached.get(id)?.term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
        useBench.getState().markTerminalDead(id);
      });
    })();
  }
  return bridge;
}

/** Files on the clipboard type the same line a drop would. */
async function pathLine(id: string, paths: string[]): Promise<string> {
  const cwd = useBench.getState().terminals.find((x) => x.id === id)?.cwd ?? "";
  return droppedPathText(await resolveShell(), cwd, paths);
}

async function attach(id: string): Promise<Attached> {
  const found = attached.get(id);
  if (found) return found;

  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";

  const term = new Terminal({
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: 12,
    lineHeight: 1.25,
    cursorBlink: true,
    scrollback: 5000,
    theme: {
      background: token("--color-bg"),
      foreground: token("--color-text"),
      cursor: token("--color-accent"),
      selectionBackground: token("--color-accent-soft"),
      black: token("--color-surface-2"),
      red: token("--color-danger"),
      green: token("--color-success"),
      yellow: token("--color-warn"),
      blue: token("--color-low"),
      magenta: token("--color-accent"),
      cyan: token("--color-low"),
      white: token("--color-text"),
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  // ctrl+click on a path or a URL the agent printed
  registerTerminalLinks(term, host, useBench.getState().terminals.find((x) => x.id === id)?.cwd ?? "");

  // Ctrl+C copies only with a selection, otherwise it is the interrupt. Ctrl+V
  // goes through `term.paste`, which brackets the text so an agent takes a
  // multi-line paste as one block instead of running each line
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !(e.ctrlKey || e.metaKey) || e.altKey) return true;
    const key = e.key.toUpperCase();
    if (key === "V") {
      // the event is not cancelled: when the webview pastes, this stands down
      pasteIntoTerminal((text) => term.paste(text), (paths) => pathLine(id, paths));
      return false;
    }
    if (key === "C") {
      const selection = term.getSelection();
      if (selection) {
        void writeClipboard(selection);
        term.clearSelection();
        return false;
      }
      // nothing selected: plain Ctrl+C is how an agent gets stopped
      return !e.shiftKey;
    }
    return true;
  });

  // one gesture, the same in the terminal and in every text field
  host.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const selection = term.getSelection();
    if (selection) {
      void writeClipboard(selection);
      term.clearSelection();
      return;
    }
    pasteIntoTerminal((text) => term.paste(text), (paths) => pathLine(id, paths));
  });

  term.onData((data) => {
    // the first keystroke is what makes this session worth a confirmation
    useBench.getState().markTerminalUsed(id);
    void ptyWrite(id, data).catch(() => {});
  });

  const entry = { term, fit, host };
  attached.set(id, entry);

  // whatever the session printed before this tab existed
  const past = await ptyScrollback(id).catch(() => "");
  if (past) term.write(past);
  return entry;
}

function detachAll(container: HTMLElement, keep: string | null): void {
  for (const [id, a] of attached) {
    if (id !== keep && a.host.parentElement === container) a.host.remove();
  }
}

/** The terminal surface; its tabs live in the shared strip above it. */
export function TerminalPane() {
  const t = useT();
  // every project's sessions, because a closed tab's screen is disposed here and
  // hiding one behind a project switch must not throw its buffer away
  const terminals = useBench((s) => s.terminals);
  const activeTerminal = useBench((s) => s.activeTerminal);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    void ensureBridge();
  }, []);

  // move the active session's node into the pane, park the others
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    detachAll(container, activeTerminal);
    if (!activeTerminal) return;
    void attach(activeTerminal).then((a) => {
      if (cancelled || !containerRef.current) return;
      if (a.host.parentElement !== containerRef.current) containerRef.current.appendChild(a.host);
      a.fit.fit();
      a.term.focus();
      void ptyResize(activeTerminal, a.term.cols, a.term.rows).catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [activeTerminal, terminals.length]);

  // the pane is resizable, and the program has to be told
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (!activeTerminal) return;
      const a = attached.get(activeTerminal);
      if (!a || a.host.parentElement !== container) return;
      a.fit.fit();
      void ptyResize(activeTerminal, a.term.cols, a.term.rows).catch(() => {});
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeTerminal]);

  // a closed tab's screen goes with it
  React.useEffect(() => {
    const live = new Set(terminals.map((x) => x.id));
    for (const [id, a] of attached) {
      if (live.has(id)) continue;
      a.host.remove();
      a.term.dispose();
      attached.delete(id);
    }
  }, [terminals]);

  return (
    <div className="relative h-full min-h-0 overflow-hidden p-1.5">
      <div ref={containerRef} className="h-full w-full" />
      {!activeTerminal && (
        <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-[12px] text-text-3">
          {t("No terminal open — use + to start one in this project.")}
        </div>
      )}
    </div>
  );
}
