import type { IBufferLine, IBufferRange, ILink, ILinkHandler, Terminal } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { exists } from "@tauri-apps/plugin-fs";
import { homeDir } from "@tauri-apps/api/path";
import { useBench } from "@/store/bench";
import {
  fileCandidates,
  fileTarget,
  fileUrlToPath,
  findAll,
  resolvePath,
  spaceSplits,
  splitLocation,
  URL_RE,
  urlTarget,
  type Hit,
  type PreviewTarget,
} from "./link-detect";
import { hoverLink, leaveLink } from "./link-preview-state";

/**
 * What an agent prints, made usable: Ctrl/Cmd+click on a `path:line` opens it in
 * the editor, on an image in a preview tab, on a URL in the browser; resting the
 * pointer on any of them shows a preview. A plain click keeps selecting text.
 *
 * Two kinds of link reach here. The ones found by matching the text, below, and
 * the OSC 8 hyperlinks a program writes explicitly (Claude Code does, for paths
 * and URLs) — those xterm handles itself through `linkHandler`, whose default
 * asks `confirm()` and calls `window.open`, neither of which does anything in
 * the webview, and which drops every `file://` link. So both are wired here.
 */

/** A path seen recently: agents create files, so a miss is asked again soon. */
const EXISTS_TTL = 5_000;
const existsCache = new Map<string, { ok: boolean; at: number }>();

async function isFile(path: string): Promise<boolean> {
  const hit = existsCache.get(path);
  if (hit && (hit.ok || Date.now() - hit.at < EXISTS_TTL)) return hit.ok;
  const ok = await exists(path).catch(() => false);
  existsCache.set(path, { ok, at: Date.now() });
  return ok;
}

let home: Promise<string> | null = null;
const homePath = (): Promise<string> => (home ??= homeDir().catch(() => ""));

/** Open what a link points at: code in the editor, an image in a preview tab, a page in the browser. */
export async function activateTarget(target: PreviewTarget): Promise<void> {
  if (target.kind === "url") {
    await openUrl(target.url);
    return;
  }
  if (target.kind === "image") {
    useBench.getState().openPreview(target);
    return;
  }
  await useBench.getState().openAt(target.path, target.name, target.line || 1);
}

const modifier = (e: MouseEvent): boolean => e.ctrlKey || e.metaKey;

function makeLink(
  range: IBufferRange,
  text: string,
  target: PreviewTarget,
  sessionId: string,
): ILink {
  return {
    range,
    text,
    activate: (event) => {
      // plain clicks belong to text selection
      if (!modifier(event)) return;
      void activateTarget(target).catch(() => {});
    },
    hover: (event) => hoverLink(target, { x: event.clientX, y: event.clientY }, sessionId),
    leave: () => leaveLink(),
  };
}

const rangeOf = (hit: Hit, y: number): IBufferRange => ({
  start: { x: hit.start + 1, y },
  end: { x: hit.start + hit.text.length, y },
});

/** The file a hit names, when it is one; a hit with spaces falls back to its pieces. */
async function existingFiles(hit: Hit, cwd: string): Promise<{ hit: Hit; target: PreviewTarget }[]> {
  const homeDirPath = await homePath();
  const check = async (h: Hit): Promise<{ hit: Hit; target: PreviewTarget } | null> => {
    const { path, line } = splitLocation(h.text);
    const absolute = resolvePath(cwd, path, homeDirPath);
    return (await isFile(absolute)) ? { hit: h, target: fileTarget(absolute, line) } : null;
  };
  const whole = await check(hit);
  if (whole) return [whole];
  const pieces = await Promise.all(spaceSplits(hit).map(check));
  return pieces.filter((p): p is { hit: Hit; target: PreviewTarget } => p !== null);
}

/** What `linkHandler` does for OSC 8 links: the same gestures as the matched ones. */
function oscHandler(sessionId: string): ILinkHandler {
  const targetOf = (text: string): PreviewTarget | null => {
    if (/^https?:\/\//i.test(text)) return urlTarget(text);
    const file = fileUrlToPath(text);
    return file ? fileTarget(file.path, file.line) : null;
  };
  return {
    // `file://` is how a program links a path; anything else non-http is refused in `targetOf`
    allowNonHttpProtocols: true,
    activate: (event, text) => {
      if (!modifier(event)) return;
      const target = targetOf(text);
      if (target) void activateTarget(target).catch(() => {});
    },
    hover: (event, text) => {
      const target = targetOf(text);
      if (target) hoverLink(target, { x: event.clientX, y: event.clientY }, sessionId);
    },
    leave: () => leaveLink(),
  };
}

/**
 * Registers the providers on a terminal. `cwd` is what relative paths resolve
 * against — the folder the session was opened in.
 */
export function registerTerminalLinks(term: Terminal, cwd: string, sessionId: string): void {
  term.options.linkHandler = oscHandler(sessionId);

  const lineText = (y: number): string | null => {
    const bufferLine: IBufferLine | undefined = term.buffer.active.getLine(y - 1);
    if (!bufferLine) return null;
    const text = bufferLine.translateToString(true);
    return text.trim() ? text : null;
  };

  term.registerLinkProvider({
    provideLinks: (y, callback) => {
      const text = lineText(y);
      if (!text) return callback(undefined);
      const hits = findAll(text, URL_RE);
      callback(hits.length ? hits.map((h) => makeLink(rangeOf(h, y), h.text, urlTarget(h.text), sessionId)) : undefined);
    },
  });

  term.registerLinkProvider({
    provideLinks: (y, callback) => {
      const text = lineText(y);
      if (!text) return callback(undefined);
      const candidates = fileCandidates(text);
      if (!candidates.length) return callback(undefined);
      // a word that merely looks like a path is not a link: only real files underline
      void Promise.all(candidates.map((c) => existingFiles(c, cwd)))
        .then((found) => {
          const links = found.flat().map(({ hit, target }) => makeLink(rangeOf(hit, y), hit.text, target, sessionId));
          callback(links.length ? links : undefined);
        })
        .catch(() => callback(undefined));
    },
  });
}
