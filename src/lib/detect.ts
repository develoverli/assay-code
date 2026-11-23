import { join } from "@tauri-apps/api/path";
import { exists, readDir, readTextFile } from "@tauri-apps/plugin-fs";

/**
 * What a project is made of, so tools that cannot apply are not offered. Two
 * sources: the manifests (what the project declares) and a shallow file sweep
 * (what is there — one Python build script still deserves a Python linter).
 */

/** What people (and the built-in tools) write instead of the canonical tag. */
const ALIASES: Record<string, string> = {
  js: "node",
  javascript: "node",
  nodejs: "node",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  python3: "python",
  rs: "rust",
  golang: "go",
  csharp: "dotnet",
  "c#": "dotnet",
  net: "dotnet",
  rb: "ruby",
  nextjs: "next",
  vuejs: "vue",
  reactjs: "react",
};

const ALIAS_BY_TAG = new Map<string, string>(Object.entries(ALIASES));

/** One tag, in the app's vocabulary. Unknown tags survive, lowercased. */
export function canonicalTag(tag: string): string {
  const t = tag.trim().toLowerCase();
  return ALIAS_BY_TAG.get(t) ?? t;
}

export function canonicalTags(tags: readonly string[]): string[] {
  const out = new Set<string>();
  for (const tag of tags) {
    const c = canonicalTag(tag);
    if (c) out.add(c);
  }
  return [...out];
}

/**
 * Does a tool that declares `toolStack` apply here? Yes when the tool declares
 * nothing (Gitleaks, OSV) or the project's stack is unknown: an empty detection
 * is ignorance, not absence.
 */
export function stackApplies(toolStack: readonly string[], projectStack: readonly string[]): boolean {
  const want = canonicalTags(toolStack);
  if (!want.length) return true;
  const own = new Set(canonicalTags(projectStack));
  if (!own.size) return true;
  return want.some((s) => own.has(s));
}

/* --------------------------------- sources --------------------------------- */

/** Dependencies in package.json worth turning into a tag. */
const DEP_TAGS: [string, string][] = [
  ["next", "next"],
  ["react-native", "react-native"],
  ["expo", "expo"],
  ["react", "react"],
  ["vue", "vue"],
  ["svelte", "svelte"],
  ["astro", "astro"],
  ["vite", "vite"],
  ["typescript", "typescript"],
];

/** A file in the root that declares the language on its own. */
const MANIFESTS: [string, string][] = [
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["setup.py", "python"],
  ["Pipfile", "python"],
  ["environment.yml", "python"],
  ["Cargo.toml", "rust"],
  ["go.mod", "go"],
  ["composer.json", "php"],
  ["Gemfile", "ruby"],
  ["pom.xml", "java"],
  ["build.gradle", "java"],
  ["build.gradle.kts", "java"],
];

/** An extension that is evidence on its own, wherever it turns up. */
const EXT_TAGS: Record<string, string> = {
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  php: "php",
  rb: "ruby",
  java: "java",
  kt: "java",
  cs: "dotnet",
  ts: "typescript",
  tsx: "typescript",
  js: "node",
  jsx: "node",
  mjs: "node",
  cjs: "node",
};

/**
 * Never walked: vendored code and build output. Also what a secret scanner
 * should skip — compiled artifacts are full of high-entropy bytes that look like keys.
 */
export const SKIP_DIRS = new Set([
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
  ".idea",
  ".vscode",
]);

/** How deep the sweep goes, and how many entries it will look at in total. */
const MAX_DEPTH = 3;
const MAX_ENTRIES = 4000;

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

async function readManifests(root: string, tags: Set<string>): Promise<void> {
  try {
    const pj = await join(root, "package.json");
    if (await exists(pj)) {
      tags.add("node");
      const json = JSON.parse(await readTextFile(pj));
      const deps: Record<string, string> = {
        ...(json.dependencies ?? {}),
        ...(json.devDependencies ?? {}),
        ...(json.peerDependencies ?? {}),
      };
      for (const [dep, tag] of DEP_TAGS) if (dep in deps) tags.add(tag);
    }
  } catch {
    /* missing, unreadable or invalid JSON — the file sweep still runs */
  }

  await Promise.all(
    MANIFESTS.map(async ([file, tag]) => {
      if (tags.has(tag)) return;
      try {
        if (await exists(await join(root, file))) tags.add(tag);
      } catch {
        /* unreadable — try the next one */
      }
    }),
  );
}

/**
 * One directory of the sweep: every file it holds is tagged and the
 * subdirectories worth walking next are returned. The budget is shared, so a
 * directory that exhausts it stops the walk everywhere.
 */
async function scanDir(dir: string, tags: Set<string>, budget: { left: number }): Promise<string[]> {
  let entries;
  try {
    entries = await readDir(dir);
  } catch {
    return []; // permissions, a symlink to nowhere: not our problem
  }
  const next: string[] = [];
  for (const e of entries) {
    if (--budget.left <= 0) break;
    if (e.isDirectory) {
      if (!SKIP_DIRS.has(e.name)) next.push(e.name);
      continue;
    }
    const tag = EXT_TAGS[extensionOf(e.name)];
    if (tag) tags.add(tag);
  }
  return Promise.all(next.map((name) => join(dir, name)));
}

/**
 * Walk the tree breadth-first until the budget runs out: the evidence sits near
 * the root, and depth-first would spend the budget inside one branch.
 */
async function sweepFiles(root: string, tags: Set<string>): Promise<void> {
  const budget = { left: MAX_ENTRIES };
  let level: string[] = [root];

  for (let depth = 0; depth <= MAX_DEPTH && level.length && budget.left > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (budget.left <= 0) break;
      next.push(...(await scanDir(dir, tags, budget)));
    }
    level = next;
  }
}

/**
 * The project's stack. Best-effort and never throws: an empty array means
 * "could not tell", which every caller treats as "run anyway".
 */
export async function detectStack(path?: string | null): Promise<string[]> {
  if (!path) return [];
  let root = path;
  // trimmed in a loop, not with a regex: a trailing run of separators makes
  // the regex form backtrack quadratically
  while (root.endsWith("/") || root.endsWith("\\")) root = root.slice(0, -1);
  const tags = new Set<string>();
  try {
    await readManifests(root, tags);
    await sweepFiles(root, tags);
  } catch {
    /* whatever was gathered before the failure is still true */
  }
  // a .ts file anywhere implies the Node toolchain, even without a package.json
  if (tags.has("typescript")) tags.add("node");
  return [...tags];
}
