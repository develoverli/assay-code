/**
 * What counts as a link in what an agent prints, and what a link points at.
 * Pure on purpose: the terminal providers and the hover preview both lean on it,
 * and a regex that drifts is the kind of thing that breaks silently.
 */

/**
 * A path with a folder in it: `src/lib/db.ts:485:12`, `./x.py:3`, `~/a/b.md`.
 * No spaces, because agents write `Edited src/a.ts and src/b.ts` and a space in
 * the class glued both into one path that did not exist. Bounded pieces with no
 * nested quantifiers, so a path-like line cannot backtrack exponentially;
 * `(?::\d)?\d*` is `(?::\d+)?` without the nesting.
 */
const RELATIVE_RE =
  /(?:\.{1,2}[\\/]|~[\\/]|[\w.-]{1,64}[\\/])[\w.\-\\/@+]{0,256}\.[A-Za-z][\w-]{0,15}(?::\d)?\d*(?::\d)?\d*/g;

/**
 * An absolute path. Windows folders carry spaces (`C:\Program Files\…`), so
 * here a space is allowed, and `fileCandidates` falls back to the shorter
 * readings when the long one is not a file.
 */
// the lookbehind keeps `/lib/db.ts` from being read out of the middle of `src/lib/db.ts`
const ABSOLUTE_RE =
  /(?<![\w.~-])(?:[A-Za-z]:[\\/]|\/(?=[\w.-]{1,64}\/))[\w .\-\\/@+]{0,256}\.[A-Za-z][\w-]{0,15}(?::\d)?\d*(?::\d)?\d*/g;

/** A bare name with an extension: `README.md`, `package.json:12`. Only a link when it exists. */
const BARE_RE = /[\w-][\w.-]{0,127}\.[A-Za-z][\w-]{0,15}(?::\d)?\d*(?::\d)?\d*/g;

export const URL_RE = /https?:\/\/[^\s"'`<>)\]}]+/g;

export interface Hit {
  text: string;
  /** 0-based index into the line. */
  start: number;
}

export function findAll(line: string, re: RegExp): Hit[] {
  const out: Hit[] = [];
  re.lastIndex = 0;
  for (const m of line.matchAll(re)) {
    if (m.index === undefined) continue;
    out.push({ text: m[0], start: m.index });
  }
  return out;
}

const overlaps = (a: Hit, b: Hit): boolean => a.start < b.start + b.text.length && b.start < a.start + a.text.length;

/** Characters an agent leaves stuck to a path that are never part of one. */
function trimTrail(hit: Hit): Hit {
  let text = hit.text;
  while (text.length && ".,;:".includes(text[text.length - 1])) text = text.slice(0, -1);
  return { text, start: hit.start };
}

/** A version number (`1.2.3`), a domain (`github.com`) or a host:port reads like a name; none are files. */
function looksLikeFile(text: string): boolean {
  return !/^v?\d+(\.\d+)+$/.test(text) && !/^www\./i.test(text);
}

/**
 * Every reading of a line that might be a file, longest first where they
 * overlap. Each one still has to exist on disk before it is shown as a link;
 * this only decides what is worth asking about. URLs are taken out first so
 * `github.com/a/b.ts` inside a link is not offered twice.
 */
export function fileCandidates(line: string): Hit[] {
  const urls = findAll(line, URL_RE);
  const taken: Hit[] = [...urls];
  const out: Hit[] = [];
  const add = (hit: Hit): void => {
    const h = trimTrail(hit);
    if (!h.text || taken.some((t) => overlaps(t, h))) return;
    taken.push(h);
    out.push(h);
  };

  for (const hit of findAll(line, ABSOLUTE_RE)) {
    add(hit);
    // `D:\a b\c.ts` and `D:\a` are both readings; the shorter ones, split at
    // spaces, are tried only by whoever checks the disk (see `spaceSplits`)
  }
  for (const hit of findAll(line, RELATIVE_RE)) add(hit);
  for (const hit of findAll(line, BARE_RE)) {
    if (looksLikeFile(trimTrail(hit).text)) add(hit);
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The shorter readings of an absolute hit that contains spaces: everything up
 * to each space that is followed by more path, then each piece that is itself a
 * path. `D:\work\a.ts and D:\work\b.ts` yields both files.
 */
export function spaceSplits(hit: Hit): Hit[] {
  if (!hit.text.includes(" ")) return [];
  const out: Hit[] = [];
  let offset = 0;
  for (const piece of hit.text.split(" ")) {
    for (const h of [...findAll(piece, ABSOLUTE_RE), ...findAll(piece, RELATIVE_RE)]) {
      const shifted = trimTrail({ text: h.text, start: hit.start + offset + h.start });
      if (shifted.text && !out.some((o) => overlaps(o, shifted))) out.push(shifted);
    }
    offset += piece.length + 1;
  }
  return out;
}

const DIGITS = /^\d+$/;

/**
 * Split `path:line:col` without eating a Windows drive letter. Scanned from the
 * right rather than with `/^(.*?):(\d+)/`, which backtracks quadratically.
 */
export function splitLocation(raw: string): { path: string; line: number } {
  const parts = raw.split(":");
  // a trailing `:col` only counts when a line number sits in front of it
  if (parts.length > 2 && DIGITS.test(parts[parts.length - 1]) && DIGITS.test(parts[parts.length - 2])) {
    parts.pop();
  }
  if (parts.length < 2) return { path: raw, line: 0 };
  const last = parts[parts.length - 1];
  if (!DIGITS.test(last)) return { path: raw, line: 0 };
  parts.pop();
  return { path: parts.join(":"), line: Number(last) || 0 };
}

export function isAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/");
}

/** Slash-separated and absolute: relative paths resolve against the session's folder, `~` against home. */
export function resolvePath(cwd: string, path: string, home = ""): string {
  const clean = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (isAbsolute(path)) return clean;
  const base = clean.startsWith("~/") && home ? home : cwd;
  const rest = clean.startsWith("~/") && home ? clean.slice(2) : clean;
  // the trailing slashes come off in a loop: `/\/+$/` backtracks quadratically
  let root = base.replace(/\\/g, "/");
  while (root.endsWith("/")) root = root.slice(0, -1);
  return `${root}/${rest}`;
}

/**
 * A `file://` link (what Claude Code writes in an OSC 8 hyperlink) as a path
 * and a line. Null for anything that is not a local file: a `file://server/…`
 * share is somebody else's machine. A line comes from `#L12` or a trailing `:12`.
 */
export function fileUrlToPath(raw: string): { path: string; line: number } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;
  if (url.hostname && url.hostname !== "localhost") return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // `/D:/work/a.ts` is how a drive letter comes out of a URL
  if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  const hash = /^#L(\d+)/.exec(url.hash);
  if (hash) return { path, line: Number(hash[1]) };
  return splitLocation(path);
}

/** What a preview shows: a slice of code, a picture, or a page. */
export type PreviewTarget =
  | { kind: "code"; path: string; name: string; line: number }
  | { kind: "image"; path: string; name: string }
  | { kind: "url"; url: string; local: boolean };

export const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp"]);

const extOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

/** `localhost`, `127.0.0.1`, `[::1]` and `0.0.0.0`: the dev server an agent just started. */
export function isLocalUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "0.0.0.0" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

export function fileTarget(absolute: string, line: number): PreviewTarget {
  const name = absolute.split("/").pop() ?? absolute;
  return IMAGE_EXT.has(extOf(name)) ? { kind: "image", path: absolute, name } : { kind: "code", path: absolute, name, line };
}

export function urlTarget(url: string): PreviewTarget {
  return { kind: "url", url, local: isLocalUrl(url) };
}

/** One identity per target, for the pinned tab (`p:<id>`) and for comparing two hovers. */
export function targetId(target: PreviewTarget): string {
  return target.kind === "url" ? target.url : target.path;
}

/**
 * The lines a code preview shows: a window around `line` (1-based, 0 = top),
 * and which of them is the one pointed at, relative to the window.
 */
export function sliceAround(
  text: string,
  line: number,
  size = 15,
): { lines: string[]; first: number; mark: number | null } {
  const all = text.split(/\r?\n/);
  const at = line > 0 ? Math.min(line, all.length) : 0;
  const before = at ? Math.floor(size / 3) : 0;
  const first = Math.max(1, (at || 1) - before);
  const lines = all.slice(first - 1, first - 1 + size);
  return { lines, first, mark: at ? at - first : null };
}
