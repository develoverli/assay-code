import { join } from "@tauri-apps/api/path";
import { readDir, readTextFile, stat, writeTextFile } from "@tauri-apps/plugin-fs";
import { tr } from "@/lib/i18n";

/**
 * The file side of Bench: a lazy tree rooted at the project folder (a recursive
 * listing is unusable with `node_modules`), and the guards on what may be opened.
 */

export interface TreeEntry {
  name: string;
  path: string;
  dir: boolean;
  /** Hidden unless "Show ignored" is on: build output, vendored code, VCS metadata. */
  ignored: boolean;
}

/** Directories that are never what you came to read. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".output",
  "coverage",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".turbo",
  ".cache",
  ".gradle",
  "vendor",
]);

/** Anything Monaco can't show as text. */
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tiff",
  "pdf", "zip", "gz", "tar", "7z", "rar", "jar", "war",
  "exe", "dll", "so", "dylib", "bin", "o", "a", "obj", "pdb",
  "mp3", "mp4", "wav", "ogg", "webm", "mov", "avi", "mkv",
  "woff", "woff2", "ttf", "otf", "eot",
  "db", "sqlite", "sqlite3", "wasm", "class", "pyc",
]);

/** Above this a file is a data dump, not something you edit by hand. */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** A real `.env`, not `.env.example` — those are meant to be read and shared. */
export function isSecretFile(name: string): boolean {
  const n = name.toLowerCase();
  if (!n.startsWith(".env")) return false;
  return !/\.(example|sample|template|dist)$/.test(n);
}

/** Children of one directory, folders first, sorted, ignored ones last. */
export async function listDir(
  path: string,
  showIgnored: boolean,
  showDotfiles = true,
): Promise<TreeEntry[]> {
  const raw = await readDir(path);
  const kept: { name: string; dir: boolean; ignored: boolean }[] = [];
  for (const e of raw) {
    const dir = !!e.isDirectory;
    const ignored = dir && IGNORED_DIRS.has(e.name);
    if (ignored && !showIgnored) continue;
    if (!showDotfiles && e.name.startsWith(".")) continue;
    kept.push({ name: e.name, dir, ignored });
  }
  const out: TreeEntry[] = await Promise.all(
    kept.map(async (e) => ({ ...e, path: await join(path, e.name) })),
  );
  return out.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    if (a.ignored !== b.ignored) return a.ignored ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

/** A file found by name, relative to the search root. */
export interface NameHit {
  name: string;
  path: string;
  /** Folder it lives in, relative to the root — shown under the name. */
  dir: string;
}

/**
 * One directory's worth of the walk: matching files are appended to `hits` and
 * the subdirectories to visit next are returned.
 */
function collectNameHits(
  entries: TreeEntry[],
  current: { path: string; rel: string },
  needle: string,
  hits: NameHit[],
  limit: number,
): { path: string; rel: string }[] {
  const queue: { path: string; rel: string }[] = [];
  for (const e of entries) {
    if (e.dir) {
      queue.push({ path: e.path, rel: current.rel ? `${current.rel}/${e.name}` : e.name });
      continue;
    }
    if (!e.name.toLowerCase().includes(needle)) continue;
    hits.push({ name: e.name, path: e.path, dir: current.rel || "." });
    if (hits.length >= limit) break;
  }
  return queue;
}

/**
 * Walk the tree for file names containing `query`. Breadth-first, capped by hits and
 * by directories visited since it runs on every keystroke; ignored folders are skipped.
 */
export async function searchFileNames(
  root: string,
  query: string,
  limit = 200,
  maxDirs = 800,
): Promise<NameHit[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 1) return [];
  const hits: NameHit[] = [];
  const queue: { path: string; rel: string }[] = [{ path: root, rel: "" }];
  let visited = 0;

  while (queue.length && hits.length < limit && visited < maxDirs) {
    const current = queue.shift()!;
    visited += 1;
    let entries: TreeEntry[];
    try {
      entries = await listDir(current.path, false);
    } catch {
      continue;
    }
    queue.push(...collectNameHits(entries, current, needle, hits, limit));
  }
  return hits;
}

export type OpenedFile =
  | { ok: true; content: string; readOnly: boolean; note?: string }
  | { ok: false; reason: string };

/** Read a file for the editor: binaries and oversized files are refused, a real `.env` opens read-only. */
export async function openFile(path: string, name: string): Promise<OpenedFile> {
  if (BINARY_EXT.has(extensionOf(name))) {
    return { ok: false, reason: tr("Binary file — Assay doesn't open these.") };
  }
  try {
    const info = await stat(path);
    if (typeof info.size === "number" && info.size > MAX_EDIT_BYTES) {
      const mb = (info.size / 1024 / 1024).toFixed(1);
      return { ok: false, reason: tr("{mb} MB — too large to edit here.", { mb }) };
    }
  } catch {
    /* no stat, try reading anyway */
  }
  try {
    const content = await readTextFile(path);
    if (isSecretFile(name)) {
      return {
        ok: true,
        content,
        readOnly: true,
        note: tr("Secrets file — opened read-only so nothing here can be changed by accident."),
      };
    }
    return { ok: true, content, readOnly: false };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function saveFile(path: string, content: string): Promise<void> {
  await writeTextFile(path, content);
}

/** A folder dropped on the editor is not an error, it is simply not a file. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return !!(await stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/** Last-write-wins is fine; silently clobbering an agent's edit is not. */
export async function modifiedAt(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    const t = info.mtime;
    return t ? new Date(t).getTime() : null;
  } catch {
    return null;
  }
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  rb: "ruby",
  php: "php",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  xml: "xml",
  dockerfile: "dockerfile",
};

/** Monaco language id for a file name, falling back to plain text. */
export function languageOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower.startsWith(".env")) return "ini";
  if (lower === "makefile") return "makefile";
  return LANGUAGE_BY_EXT[extensionOf(name)] ?? "plaintext";
}
