import { exists, readTextFile } from "@tauri-apps/plugin-fs";
import { commitsSince, gitState, remoteWebUrl, tagsOnHead, upstreamState, type GitCommit } from "@/lib/git";
import { githubRepoFromWebUrl } from "@/lib/github";
import { parseSubject, type ParsedSubject } from "@/lib/commit-style";

/**
 * When to cut a release and what it will be called: the last tag, what landed
 * since, and the version that follows. Two ways a project ships:
 *
 * - **release-please** — the action reads the commits on push, keeps a release
 *   pull request open and tags when it merges. Assay only reads; it predicts the
 *   version the way release-please will (its `bump-*-pre-major` rules included)
 *   and flags the commits release-please will skip.
 * - **tags** — a pushed `vX.Y.Z` is the release (this repository works that way).
 *   Assay predicts the version and creates and pushes the annotated tag on a click.
 */

export type ReleaseMode = "release-please" | "tags";

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text: string): Semver | null {
  const m = SEMVER.exec(text.trim().replace(/^v/, ""));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

export function formatVersion(v: Semver, prefix = ""): string {
  return `${prefix}${v.major}.${v.minor}.${v.patch}${v.pre ? `-${v.pre}` : ""}`;
}

/** A tag that names the whole project's version: `v1.2.3` or `1.2.3`, not a package's `web-v1.2.3`. */
export interface RootTag {
  tag: string;
  prefix: "v" | "";
  version: Semver;
}

const ROOT_TAG = /^(v?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** The first root tag in a newest-first list. */
export function rootTagOf(tags: string[]): RootTag | null {
  for (const tag of tags) {
    const m = ROOT_TAG.exec(tag);
    const version = m ? parseVersion(m[2]) : null;
    if (m && version) return { tag, prefix: m[1] === "v" ? "v" : "", version };
  }
  return null;
}

/* ------------------------------ grouping commits ----------------------------- */

export interface ReleaseCommit {
  commit: GitCommit;
  parsed: ParsedSubject | null;
}

export interface CommitGroups {
  /** `feat`. */
  features: ReleaseCommit[];
  /** `fix`, `perf`, `revert`, `deps` — release-please's other changelog sections. */
  fixes: ReleaseCommit[];
  /** Typed, but a type that does not cut a release on its own (docs, chore, refactor…). */
  other: ReleaseCommit[];
  /** No header release-please can read: it skips these entirely. */
  ignored: ReleaseCommit[];
  /** Any commit marked `!`, whatever its type. */
  breaking: number;
}

const FIX_TYPES = new Set(["fix", "perf", "revert", "deps"]);

/** Subjects git writes itself; they are not changes of their own. */
const GIT_GENERATED = /^(Merge |Revert "|fixup! |squash! |amend! )/;

/**
 * Sorts commits the way the release will see them. release-please stops at a
 * leading emoji, so in that mode `✨ feat: …` is ignored; a tag release reads
 * either order, since nothing downstream parses the subject.
 */
export function groupCommits(commits: GitCommit[], mode: ReleaseMode): CommitGroups {
  const groups: CommitGroups = { features: [], fixes: [], other: [], ignored: [], breaking: 0 };
  for (const commit of commits) {
    if (GIT_GENERATED.test(commit.subject)) continue;
    const parsed = parseSubject(commit.subject);
    const item = { commit, parsed };
    if (!parsed || (mode === "release-please" && parsed.emojiFirst)) {
      groups.ignored.push(item);
      continue;
    }
    if (parsed.breaking) groups.breaking++;
    if (parsed.type === "feat") groups.features.push(item);
    else if (FIX_TYPES.has(parsed.type)) groups.fixes.push(item);
    else groups.other.push(item);
  }
  return groups;
}

/** What cuts a release: a feature, a fix-like change, or anything breaking. */
export function releasableCount(g: CommitGroups): number {
  const breakingOther = g.other.filter((c) => c.parsed?.breaking).length;
  return g.features.length + g.fixes.length + breakingOther;
}

/* ---------------------------------- bumping --------------------------------- */

export interface BumpRules {
  /** Before 1.0, a breaking change bumps the minor instead of going to 1.0.0. */
  bumpMinorPreMajor: boolean;
  /** Before 1.0, a feature bumps the patch instead of the minor. */
  bumpPatchForMinorPreMajor: boolean;
}

export const DEFAULT_BUMP_RULES: BumpRules = { bumpMinorPreMajor: false, bumpPatchForMinorPreMajor: false };

export type Bump = "major" | "minor" | "patch";

/** Why the version moves the way it does — each one is a sentence in the panel. */
export type BumpReason = "breaking" | "breaking-pre-major" | "feature" | "feature-pre-major" | "fix";

export interface BumpDecision {
  bump: Bump;
  reason: BumpReason;
}

/** release-please's default versioning, rules included. Null when nothing releasable landed. */
export function decideBump(g: CommitGroups, current: Semver | null, rules: BumpRules): BumpDecision | null {
  if (releasableCount(g) === 0) return null;
  const preMajor = (current?.major ?? 0) === 0;
  if (g.breaking > 0) {
    return preMajor && rules.bumpMinorPreMajor ? { bump: "minor", reason: "breaking-pre-major" } : { bump: "major", reason: "breaking" };
  }
  if (g.features.length > 0) {
    return preMajor && rules.bumpPatchForMinorPreMajor
      ? { bump: "patch", reason: "feature-pre-major" }
      : { bump: "minor", reason: "feature" };
  }
  return { bump: "patch", reason: "fix" };
}

/** The first version a project gets when it has never been tagged. */
export const INITIAL_VERSION: Semver = { major: 0, minor: 1, patch: 0, pre: null };

/** A pre-release suffix is dropped: the next release is a real one. */
export function bumpVersion(current: Semver | null, bump: Bump): Semver {
  if (!current) return INITIAL_VERSION;
  if (bump === "major") return { major: current.major + 1, minor: 0, patch: 0, pre: null };
  if (bump === "minor") return { major: current.major, minor: current.minor + 1, patch: 0, pre: null };
  return { major: current.major, minor: current.minor, patch: current.patch + 1, pre: null };
}

/* --------------------------- release-please files --------------------------- */

export interface ReleasePleaseConfig {
  /** The root package's rules: the top level, overridden by `packages["."]`. */
  rules: BumpRules;
  /** Every package path the config declares, `.` included when it is there. */
  packages: string[];
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function rulesFrom(obj: Json, base: BumpRules): BumpRules {
  const flag = (key: string, fallback: boolean) => (typeof obj[key] === "boolean" ? (obj[key] as boolean) : fallback);
  return {
    bumpMinorPreMajor: flag("bump-minor-pre-major", base.bumpMinorPreMajor),
    bumpPatchForMinorPreMajor: flag("bump-patch-for-minor-pre-major", base.bumpPatchForMinorPreMajor),
  };
}

/** `release-please-config.json`. Null when the text is not a JSON object. */
export function parseReleasePleaseConfig(text: string): ReleasePleaseConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  const packages = isObject(raw.packages) ? raw.packages : {};
  const top = rulesFrom(raw, DEFAULT_BUMP_RULES);
  const root = packages["."];
  return { rules: isObject(root) ? rulesFrom(root, top) : top, packages: Object.keys(packages) };
}

/** `.release-please-manifest.json`: package path → its current version. */
export function parseManifest(text: string): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isObject(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

/* ------------------------------- version files ------------------------------ */

/** The files that commonly carry the project's version, relative to the root. */
export const VERSION_FILES = ["package.json", "Cargo.toml", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml"] as const;

/** `"version"` at the top of a JSON file (package.json, tauri.conf.json). */
export function versionFromJson(text: string): string | null {
  try {
    const raw: unknown = JSON.parse(text);
    return isObject(raw) && typeof raw.version === "string" ? raw.version : null;
  } catch {
    return null;
  }
}

/** `version = "…"` inside `[package]` (or `[workspace.package]`) of a Cargo.toml. */
export function versionFromCargoToml(text: string): string | null {
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section !== "package" && section !== "workspace.package") continue;
    const m = /^version\s*=\s*"([^"]+)"/.exec(line);
    if (m) return m[1];
  }
  return null;
}

export interface VersionFile {
  file: string;
  version: string;
}

/** The version files that say something other than `next` (no prefix on either side). */
export function versionMismatches(files: VersionFile[], next: string): VersionFile[] {
  const want = next.replace(/^v/, "");
  return files.filter((f) => f.version !== want);
}

/* --------------------------------- summary ---------------------------------- */

export interface ReleaseSummary {
  mode: ReleaseMode;
  repo: boolean;
  lastTag: RootTag | null;
  /** The version now: the manifest's for release-please, else the last tag's. */
  current: Semver | null;
  groups: CommitGroups;
  decision: BumpDecision | null;
  rules: BumpRules;
  /** `v` or nothing, as the existing tags write it (`v` when there are none). */
  prefix: "v" | "";
  /** The next version with its prefix, or null when nothing would be released. */
  next: string | null;
  /** release-please packages other than the root, with the manifest's version. */
  otherPackages: { path: string; version: string | null }[];
  /** release-please-config.json exists but could not be read. */
  configUnreadable: boolean;
  versionFiles: VersionFile[];
  branch: string | null;
  clean: boolean;
  ahead: number;
  hasUpstream: boolean;
  webUrl: string | null;
  /** `owner/name` when the remote is on github.com. */
  githubRepo: string | null;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return (await exists(path)) ? await readTextFile(path) : null;
  } catch {
    return null;
  }
}

export async function readReleaseSummary(root: string, mode: ReleaseMode): Promise<ReleaseSummary> {
  const base = root.replace(/[\\/]+$/, "");
  const [state, tags, up, webUrl, configText, manifestText, ...versionTexts] = await Promise.all([
    gitState(root),
    tagsOnHead(root),
    upstreamState(root),
    remoteWebUrl(root),
    readIfExists(`${base}/release-please-config.json`),
    readIfExists(`${base}/.release-please-manifest.json`),
    ...VERSION_FILES.map((f) => readIfExists(`${base}/${f}`)),
  ]);

  const lastTag = rootTagOf(tags);
  const commits = state.repo ? await commitsSince(root, lastTag?.tag ?? null) : [];
  const config = configText !== null ? parseReleasePleaseConfig(configText) : null;
  const manifest = manifestText !== null ? parseManifest(manifestText) : {};
  const rules = mode === "release-please" && config ? config.rules : DEFAULT_BUMP_RULES;

  const manifestRoot = manifest["."] ? parseVersion(manifest["."]) : null;
  const current = (mode === "release-please" ? manifestRoot : null) ?? lastTag?.version ?? null;
  const groups = groupCommits(commits, mode);
  const decision = decideBump(groups, current, rules);
  const prefix = lastTag?.prefix ?? "v";
  // a project never tagged proposes its first version even with nothing typed yet
  const nextVersion = decision ? bumpVersion(current, decision.bump) : !current && commits.length ? INITIAL_VERSION : null;

  const versionFiles: VersionFile[] = [];
  VERSION_FILES.forEach((file, i) => {
    const text = versionTexts[i];
    if (text === null) return;
    const version = file.endsWith(".toml") ? versionFromCargoToml(text) : versionFromJson(text);
    if (version) versionFiles.push({ file, version });
  });

  const packagePaths = new Set([...(config?.packages ?? []), ...Object.keys(manifest)]);
  packagePaths.delete(".");

  return {
    mode,
    repo: state.repo,
    lastTag,
    current,
    groups,
    decision,
    rules,
    prefix,
    next: nextVersion ? formatVersion(nextVersion, prefix) : null,
    otherPackages: [...packagePaths].sort().map((path) => ({ path, version: manifest[path] ?? null })),
    configUnreadable: configText !== null && config === null,
    versionFiles,
    branch: state.branch,
    clean: state.repo && state.changes.length === 0,
    ahead: state.ahead,
    hasUpstream: up.hasUpstream,
    webUrl,
    githubRepo: githubRepoFromWebUrl(webUrl),
  };
}

/** Why the tag button is off, as a sentence key — null when it can run. */
export function tagBlocker(s: Pick<ReleaseSummary, "repo" | "clean" | "hasUpstream" | "ahead">): string | null {
  if (!s.repo) return "This folder is not a git repository.";
  if (!s.clean) return "There are uncommitted changes. Commit them first.";
  if (!s.hasUpstream) return "This branch was never pushed. Push it first.";
  if (s.ahead > 0) return "There are commits not pushed yet. Push the branch first.";
  return null;
}

/** A tag name git will accept and that reads as a version. */
export function validTagName(name: string): boolean {
  return ROOT_TAG.test(name.trim());
}

/** The tag page on the remote's web UI, for the hosts whose URL shape is known. */
export function tagWebUrl(webUrl: string | null, tag: string): string | null {
  if (!webUrl) return null;
  if (/^https:\/\/github\.com\//i.test(webUrl)) return `${webUrl}/releases/tag/${encodeURIComponent(tag)}`;
  if (/^https:\/\/gitlab\.com\//i.test(webUrl)) return `${webUrl}/-/tags/${encodeURIComponent(tag)}`;
  return null;
}
