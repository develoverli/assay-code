import type { IBufferLine, ILink, Terminal } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { exists } from "@tauri-apps/plugin-fs";
import { useBench } from "@/store/bench";
import { tr } from "@/lib/i18n";

/**
 * Ctrl/Cmd+click on what an agent prints: `path:line` opens in the editor, a URL
 * in the browser. A plain click must keep selecting text.
 */

/** `src/lib/db.ts:485:12`, `./x.py:3`, `D:\work\app\main.rs` — with the line if it's there. */
// Bounded pieces with no nested quantifiers, so a path-like line cannot
// backtrack exponentially. `(?::\d)?\d*` is `(?::\d+)?` without the nesting.
const FILE_RE =
  /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[~\w.-]{1,64}[\\/])[\w .\-\\/]{0,256}\.[\w-]{1,16}(?::\d)?\d*(?::\d)?\d*/g;

const URL_RE = /https?:\/\/[^\s"'`<>)\]}]+/g;

interface Hit {
  text: string;
  /** 0-based index into the line. */
  start: number;
}

function findAll(line: string, re: RegExp): Hit[] {
  const out: Hit[] = [];
  re.lastIndex = 0;
  for (const m of line.matchAll(re)) {
    if (m.index === undefined) continue;
    out.push({ text: m[0], start: m.index });
  }
  return out;
}

const DIGITS = /^\d+$/;

/**
 * Split `path:line:col` without eating a Windows drive letter. Scanned from the
 * right rather than with `/^(.*?):(\d+)/`, which backtracks quadratically.
 */
function splitLocation(raw: string): { path: string; line: number } {
  const parts = raw.split(":");
  // a trailing `:col` only counts when a line number sits in front of it
  if (parts.length > 2 && DIGITS.test(parts[parts.length - 1]) && DIGITS.test(parts[parts.length - 2])) {
    parts.pop();
  }
  const last = parts.pop();
  if (last === undefined || !DIGITS.test(last)) return { path: raw, line: 0 };
  return { path: parts.join(":"), line: Number(last) || 0 };
}

function isAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/");
}

function resolve(cwd: string, path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (isAbsolute(path)) return clean;
  // the trailing slashes come off in a loop: `/\/+$/` backtracks quadratically
  let base = cwd.replace(/\\/g, "/");
  while (base.endsWith("/")) base = base.slice(0, -1);
  return `${base}/${clean}`;
}

async function openFile(cwd: string, raw: string): Promise<void> {
  const { path, line } = splitLocation(raw);
  const absolute = resolve(cwd, path);
  // a word that merely looks like a path is not a link
  if (!(await exists(absolute).catch(() => false))) return;
  const name = absolute.split("/").pop() ?? absolute;
  await useBench.getState().openAt(absolute, name, line || 1);
}

/**
 * Registers the providers on a terminal. `cwd` is what relative paths resolve
 * against — the folder the session was opened in.
 */
export function registerTerminalLinks(term: Terminal, host: HTMLElement, cwd: string): void {
  const provider = (
    y: number,
    callback: (links: ILink[] | undefined) => void,
    kind: "file" | "url",
  ): void => {
    const buffer = term.buffer.active;
    const bufferLine: IBufferLine | undefined = buffer.getLine(y - 1);
    if (!bufferLine) return callback(undefined);
    const text = bufferLine.translateToString(true);
    if (!text.trim()) return callback(undefined);

    const hits = findAll(text, kind === "url" ? URL_RE : FILE_RE);
    if (!hits.length) return callback(undefined);

    callback(
      hits.map((hit) => ({
        range: {
          start: { x: hit.start + 1, y },
          end: { x: hit.start + hit.text.length, y },
        },
        text: hit.text,
        activate: (event: MouseEvent, uri: string) => {
          // plain clicks belong to text selection
          if (!event.ctrlKey && !event.metaKey) return;
          if (kind === "url") void openUrl(uri).catch(() => {});
          else void openFile(cwd, uri).catch(() => {});
        },
        hover: (_event: MouseEvent, uri: string) => {
          host.title = tr("Ctrl+click to open {target}", { target: uri });
        },
        leave: () => {
          host.title = "";
        },
      })),
    );
  };

  term.registerLinkProvider({
    provideLinks: (y, cb) => provider(y, cb, "url"),
  });
  term.registerLinkProvider({
    provideLinks: (y, cb) => provider(y, cb, "file"),
  });
}
