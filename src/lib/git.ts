import { runProgram, runProgramOnce } from "@/lib/exec";
import { getAccount, isGitHubHttpsRemote, remoteAuthEnv, TokenRejectedError, withGitHubToken } from "@/lib/github";

/**
 * The git the Workspace needs. Every write is behind a button the user pressed, and
 * nothing discards work: no reset, no force, no discarding the working tree.
 */

export interface GitChange {
  /** Porcelain status pair, e.g. ` M`, `??`, `A `. */
  code: string;
  path: string;
  /** A rename's old path: staging or unstaging one side alone leaves the other behind. */
  from?: string;
  staged: boolean;
  untracked: boolean;
}

/** What happened to a file, as the tree and tabs show it (`MM`, ` M`, `M ` are all "modified"). */
export type GitFileStatus = "modified" | "added" | "untracked" | "deleted" | "renamed" | "conflict";

/** Both sides of the pair claimed by different commits — a merge left this. */
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function classifyStatus(code: string): GitFileStatus {
  if (CONFLICT_CODES.has(code)) return "conflict";
  if (code === "??") return "untracked";
  // the worst thing that happened to the file wins, index side or work tree
  const letters = code.replace(/ /g, "");
  if (letters.includes("D")) return "deleted";
  if (letters.includes("R")) return "renamed";
  if (letters.includes("A")) return "added";
  return "modified";
}

/** A path as git prints it (and the status map is keyed): repo-relative, slash-separated. */
export function relPath(root: string, absolute: string): string {
  const norm = (v: string) => v.replace(/\\/g, "/");
  const base = norm(root);
  const full = norm(absolute);
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return full.toLowerCase().startsWith(prefix.toLowerCase()) ? full.slice(prefix.length) : full;
}

export interface GitCommit {
  hash: string;
  subject: string;
  author: string;
  /** Author date in epoch millis — formatted by the app, in the app's language. */
  at: number;
}

export interface GitState {
  repo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
}

async function git(root: string, args: string[]): Promise<{ code: number | null; out: string }> {
  const res = await runProgramOnce("git", ["-C", root, ...args]).catch(() => null);
  return { code: res?.code ?? null, out: res?.stdout ?? "" };
}

/** `## main...origin/main [ahead 2, behind 1]` — the header porcelain prints. */
function parseBranchLine(line: string): { branch: string | null; ahead: number; behind: number } {
  const head = line.replace(/^## /, "");
  const branch = head.split("...")[0].trim() || null;
  const ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0);
  return { branch: branch === "HEAD (no branch)" ? null : branch, ahead, behind };
}

/**
 * `git status --porcelain=v1 -z` output. Without `-z` git C-quotes paths with spaces,
 * quotes or non-ASCII bytes, and passing those back to `git add` matches nothing.
 * With it records are NUL-terminated and verbatim; a rename is `R  new\0old\0`.
 */
export function parseStatusZ(out: string): Omit<GitState, "repo"> {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const changes: GitChange[] = [];
  const records = out.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith("## ")) {
      ({ branch, ahead, behind } = parseBranchLine(record));
      continue;
    }
    const codePair = record.slice(0, 2);
    const change: GitChange = {
      code: codePair,
      path: record.slice(3),
      staged: !codePair.startsWith(" ") && !codePair.startsWith("?"),
      untracked: codePair === "??",
    };
    // a rename or copy carries its source as the next record
    if (codePair.includes("R") || codePair.includes("C")) change.from = records[++i];
    changes.push(change);
  }
  return { branch, ahead, behind, changes };
}

export async function gitState(root: string): Promise<GitState> {
  const { code, out } = await git(root, ["status", "--porcelain=v1", "-z", "-b", "--untracked-files=all"]);
  if (code !== 0) return { repo: false, branch: null, ahead: 0, behind: 0, changes: [] };
  return { repo: true, ...parseStatusZ(out) };
}

/** Splits git's line-oriented output. */
const NEWLINE = /\r?\n/;

/** Unit separator: a byte no commit subject will contain. */
const SEP = "\u001f";

export async function gitLog(root: string, limit = 12): Promise<GitCommit[]> {
  const { code, out } = await git(root, [
    "log",
    `-n${limit}`,
    `--pretty=format:%h%x1f%s%x1f%an%x1f%at`,
  ]);
  if (code !== 0) return [];
  return out
    .split(NEWLINE)
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, author, at] = line.split(SEP);
      return {
        hash,
        subject: subject ?? "",
        author: author ?? "",
        at: Number(at) * 1000 || 0,
      };
    });
}

/* ---------------------------------- writes ---------------------------------- */
export interface GitResult {
  ok: boolean;
  /** Whatever git said, for the error bar. */
  output: string;
}

/**
 * Nobody can answer git from here: an editor or a password prompt would hang forever.
 * `:` is git's "no editor" (keeps the prepared message); the prompt switch makes a
 * missing credential fail instead.
 */
const UNATTENDED_ENV: Record<string, string> = {
  GIT_EDITOR: ":",
  GIT_SEQUENCE_EDITOR: ":",
  GIT_MERGE_AUTOEDIT: "no",
  GIT_TERMINAL_PROMPT: "0",
};

async function run(root: string, args: string[], env: Record<string, string> = {}): Promise<GitResult> {
  const res = await runProgram("git", ["-C", root, ...args], { env: { ...UNATTENDED_ENV, ...env } }).result.catch(
    () => null,
  );
  return { ok: res?.code === 0, output: (res?.combined ?? "").trim() };
}

// 401 only: a 403 is "this token may not do that" (no push rights, SSO not granted),
// which a renewal cannot change, and renewing spends a single-use refresh token.
const AUTH_REFUSED = /Authentication failed|Invalid username or password|could not read Username|terminal prompts disabled|The requested URL returned error: 401\b/i;

/** Whether git's output says the credentials were refused, as opposed to lacking permission. */
export function isAuthRefusal(output: string): boolean {
  return AUTH_REFUSED.test(output);
}

/**
 * Talk to the remote with the linked GitHub account when the remote is github.com
 * over https (a refusal gets one renewal and retry); otherwise plain git with the
 * user's own credentials.
 */
async function runWithRemoteAuth(root: string, remote: string | null, args: string[]): Promise<GitResult> {
  const url = remote ? (await git(root, ["remote", "get-url", remote])).out : "";
  if (!isGitHubHttpsRemote(url) || !(await getAccount())) return run(root, args);
  try {
    return await withGitHubToken(async (token) => {
      const res = await run(root, args, remoteAuthEnv(token));
      if (!res.ok && isAuthRefusal(res.output)) throw new TokenRejectedError(res.output);
      return res;
    });
  } catch (e) {
    if (e instanceof TokenRejectedError) return { ok: false, output: e.detail || e.message };
    throw e;
  }
}

/** The remote the current branch pushes to and pulls from, else the first one. */
async function trackedRemote(root: string, branch: string | null, fallback: string | null): Promise<string | null> {
  if (!branch) return fallback;
  const configured = (await git(root, ["config", "--get", `branch.${branch}.remote`])).out.trim();
  return configured || fallback;
}

/** Stage exactly these paths. Passing none stages nothing, on purpose. */
export async function stagePaths(root: string, paths: string[]): Promise<GitResult> {
  if (!paths.length) return { ok: true, output: "" };
  return run(root, ["add", "--", ...paths]);
}

/** Take exactly these paths back out of the index; `restore --staged` touches no file on disk. */
export async function unstagePaths(root: string, paths: string[]): Promise<GitResult> {
  if (!paths.length) return { ok: true, output: "" };
  return run(root, ["restore", "--staged", "--", ...paths]);
}

/** Commit what is staged. The message goes as an argument, never through a shell. */
export async function commit(root: string, message: string): Promise<GitResult> {
  return run(root, ["commit", "-m", message]);
}

export interface UpstreamState {
  branch: string | null;
  /** False when the branch has never been pushed. */
  hasUpstream: boolean;
  remote: string | null;
}

export async function upstreamState(root: string): Promise<UpstreamState> {
  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).out.trim() || null;
  const tracked = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const remote = (await git(root, ["remote"])).out.split(NEWLINE).find(Boolean) ?? null;
  return { branch, hasUpstream: tracked.code === 0, remote };
}

/** Push the current branch, setting its upstream on the first push. */
export async function push(root: string): Promise<GitResult> {
  const { branch, hasUpstream, remote } = await upstreamState(root);
  if (hasUpstream) return runWithRemoteAuth(root, await trackedRemote(root, branch, remote), ["push"]);
  if (!branch || !remote) return { ok: false, output: "No remote to push to." };
  return runWithRemoteAuth(root, remote, ["push", "-u", remote, branch]);
}

/**
 * Pull: fast-forward when possible, otherwise merge with git's own message, never
 * rebase. The flags override the user's `pull.rebase` / `pull.ff` so every machine
 * behaves alike; a clashing merge leaves conflicts for the Conflicts panel.
 */
export async function pull(root: string): Promise<GitResult> {
  const { branch, remote } = await upstreamState(root);
  return runWithRemoteAuth(root, await trackedRemote(root, branch, remote), ["pull", "--no-rebase", "--ff", "--no-edit"]);
}

/* ------------------------------ friendly errors ----------------------------- */
/** What git's refusal means, in a sentence a person can act on. First match wins. */
const EXPLANATIONS: [RegExp, string][] = [
  [/CONFLICT|Automatic merge failed|could not apply/i, "The changes that came in clash with yours. Resolve them in Conflicts."],
  [
    /You have not concluded your merge|MERGE_HEAD exists|unmerged files|resolve your current index first/i,
    "A merge is still in progress. Finish or cancel it in Conflicts first.",
  ],
  [
    /\[rejected\].*\((fetch first|non-fast-forward)\)|Updates were rejected because/i,
    "The remote has commits you don't have yet. Pull first, then push again.",
  ],
  [
    /Your local changes to the following files would be overwritten/i,
    "You have uncommitted changes in files that would be overwritten. Commit them first, then try again.",
  ],
  [
    /untracked working tree files would be overwritten/i,
    "Untracked files here have the same names as incoming ones. Commit or move them first, then try again.",
  ],
  [/There is no tracking information|no tracking information/i, "This branch has no upstream to pull from. Push it first."],
  [
    /Authentication failed|Permission denied \(publickey|terminal prompts disabled|could not read Username|Invalid username or password/i,
    "The remote refused your credentials. Reconnect GitHub in Settings › General, or sign in to git (for example `gh auth login`), and try again.",
  ],
  [
    /Could not resolve host|unable to access|Could not read from remote repository|Connection (timed out|refused)/i,
    "Could not reach the remote. Check your connection and that the repository still exists.",
  ],
  [/nothing to commit|no changes added to commit/i, "There is nothing staged to commit."],
];

/** The plain reading of git's output, or null when it is not recognised. */
export function explainGitError(output: string): string | null {
  for (const [pattern, sentence] of EXPLANATIONS) if (pattern.test(output)) return sentence;
  return null;
}

/* --------------------------------- conflicts -------------------------------- */
/** The operation that stopped half-way and left conflicts behind. */
export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert";

export interface ConflictFile {
  path: string;
  /** The porcelain pair: `UU` both edited, `UD`/`DU` one side deleted it, `AA` both added. */
  code: string;
}

export interface ConflictState {
  operation: GitOperation | null;
  files: ConflictFile[];
}

/** The refs that exist only while each operation is stopped. */
const OPERATION_HEADS: [GitOperation, string][] = [
  ["merge", "MERGE_HEAD"],
  ["rebase", "REBASE_HEAD"],
  ["cherry-pick", "CHERRY_PICK_HEAD"],
  ["revert", "REVERT_HEAD"],
];

export async function conflictState(root: string): Promise<ConflictState> {
  const [state, ...heads] = await Promise.all([
    gitState(root),
    ...OPERATION_HEADS.map(([, head]) => git(root, ["rev-parse", "-q", "--verify", head])),
  ]);
  const files = state.repo
    ? state.changes.filter((c) => classifyStatus(c.code) === "conflict").map((c) => ({ path: c.path, code: c.code }))
    : [];
  const at = heads.findIndex((h) => h.code === 0);
  return { operation: at >= 0 ? OPERATION_HEADS[at][0] : null, files };
}

/** One side deleted the file and the other changed it — settled by keeping or deleting it. */
export function isDeleteConflict(code: string): boolean {
  return code.includes("D");
}

/** Mark one file resolved: its content as it is on disk goes into the index. */
export async function markResolved(root: string, path: string): Promise<GitResult> {
  return run(root, ["add", "--", path]);
}

/** A delete/modify conflict settled by deleting: the file leaves the tree and the index. */
export async function resolveByDeleting(root: string, path: string): Promise<GitResult> {
  return run(root, ["rm", "--quiet", "--", path]);
}

/**
 * Conclude the stopped operation once nothing is left unresolved. Each keeps
 * the message git prepared — the editor is `:` — so nothing waits on a prompt.
 */
export async function continueOperation(root: string, op: GitOperation): Promise<GitResult> {
  if (op === "merge") return run(root, ["commit", "--no-edit"]);
  return run(root, [op, "--continue"]);
}

/** Undo the stopped operation back to where it started. The caller confirms first. */
export async function abortOperation(root: string, op: GitOperation): Promise<GitResult> {
  return run(root, [op, "--abort"]);
}

/** One stretch of a conflicted file: text both sides agree on, or a clash. */
export type ConflictSegment =
  | { kind: "text"; text: string }
  | { kind: "conflict"; ours: string; theirs: string; base: string | null; oursLabel: string; theirsLabel: string };

export type HunkChoice = "ours" | "theirs" | "both";

const MARK_OURS = "<<<<<<<";
const MARK_BASE = "|||||||";
const MARK_SPLIT = "=======";
const MARK_THEIRS = ">>>>>>>";

/** A marker is the seven characters alone, or followed by a space and its label. */
function isMarker(line: string, mark: string): boolean {
  if (!line.startsWith(mark)) return false;
  const rest = line.slice(mark.length);
  return rest === "" || rest.startsWith(" ") || rest.startsWith("\r") || rest.startsWith("\n");
}

function markerLabel(line: string): string {
  return line.slice(7).replace(/\r?\n$/, "").trim();
}

/**
 * Split a file git left with conflict markers into its stretches. Lines keep their
 * endings, so joining gives the file back byte for byte; an unclosed block stays text.
 */
export function parseConflicts(content: string): ConflictSegment[] {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const out: ConflictSegment[] = [];
  let text = "";
  let i = 0;
  while (i < lines.length) {
    const open = lines[i];
    if (!isMarker(open, MARK_OURS)) {
      text += open;
      i++;
      continue;
    }
    let ours = "";
    let base: string | null = null;
    let theirs = "";
    let section: "ours" | "base" | "theirs" = "ours";
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (section === "ours" && isMarker(line, MARK_BASE)) {
        section = "base";
        base = "";
      } else if (section !== "theirs" && isMarker(line, MARK_SPLIT)) {
        section = "theirs";
      } else if (section === "theirs" && isMarker(line, MARK_THEIRS)) {
        close = j;
        break;
      } else if (section === "ours") ours += line;
      else if (section === "base") base = `${base ?? ""}${line}`;
      else theirs += line;
    }
    if (close < 0) {
      text += lines.slice(i).join("");
      break;
    }
    if (text) out.push({ kind: "text", text });
    text = "";
    out.push({
      kind: "conflict",
      ours,
      theirs,
      base,
      oursLabel: markerLabel(open),
      theirsLabel: markerLabel(lines[close]),
    });
    i = close + 1;
  }
  if (text) out.push({ kind: "text", text });
  return out;
}

/** The file with each clash settled by its choice; one left open keeps its markers. */
export function resolveConflicts(segments: ConflictSegment[], choices: (HunkChoice | null)[]): string {
  let n = 0;
  return segments
    .map((seg) => {
      if (seg.kind === "text") return seg.text;
      const choice = choices[n++] ?? null;
      if (choice === "ours") return seg.ours;
      if (choice === "theirs") return seg.theirs;
      if (choice === "both") return seg.ours + seg.theirs;
      const base = seg.base !== null ? `${MARK_BASE}\n${seg.base}` : "";
      return `${MARK_OURS} ${seg.oursLabel}\n${seg.ours}${base}${MARK_SPLIT}\n${seg.theirs}${MARK_THEIRS} ${seg.theirsLabel}\n`;
    })
    .join("");
}

/** Whether a file still carries a conflict block — the gate on "Mark resolved". */
export function hasConflictMarkers(content: string): boolean {
  return parseConflicts(content).some((s) => s.kind === "conflict");
}

/* --------------------------------- branches --------------------------------- */
export interface BranchList {
  current: string | null;
  local: string[];
}

export async function listBranches(root: string): Promise<BranchList> {
  const { code, out } = await git(root, ["branch", "--format=%(refname:short)"]);
  if (code !== 0) return { current: null, local: [] };
  const { branch } = await upstreamState(root);
  return { current: branch, local: out.split(NEWLINE).map((l) => l.trim()).filter(Boolean) };
}

/**
 * Move to another branch, or start one from here. Never `--force`: git refusing to
 * lose uncommitted work is the point.
 */
export async function switchBranch(root: string, name: string, create = false): Promise<GitResult> {
  const args = create ? ["switch", "-c", name] : ["switch", name];
  return run(root, args);
}

/**
 * `git@github.com:me/repo.git` and friends → the https page a browser can open.
 * User and password are always dropped (an https remote can embed a token, and this
 * URL reaches tooltips and browser history); non-web URLs are refused.
 */
export function webUrlFromRemote(raw: string): string | null {
  const remote = raw.trim();
  if (!remote) return null;
  const scp = /^[^@/\s]+@([^:/\s]+):(.+?)(?:\.git)?\/?$/.exec(remote);
  const candidate = scp
    ? `https://${scp[1]}/${scp[2]}`
    : remote.replace(/^ssh:\/\//, "https://").replace(/\.git\/?$/, "");
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    // an ssh remote's port is sshd's, not the web server's
    if (remote.startsWith("ssh://")) url.port = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export async function remoteWebUrl(root: string): Promise<string | null> {
  const { remote } = await upstreamState(root);
  if (!remote) return null;
  return webUrlFromRemote((await git(root, ["remote", "get-url", remote])).out);
}

/**
 * The diff of the given paths against HEAD, plus new files whole, capped (edits
 * first, so a huge generated file only truncates the tail). New files go through
 * `--no-index` against `/dev/null` rather than `add -N`, so the index is never written.
 */
export async function diffForPaths(
  root: string,
  paths: string[],
  untracked: string[] = [],
  maxChars = 12000,
): Promise<string> {
  const args = ["diff", "HEAD", "--no-color"];
  if (paths.length) args.push("--", ...paths);
  const { out } = await git(root, args);
  const parts = [out.trim()];
  for (const path of untracked) {
    // `--no-index` always exits 1 here (the sides differ); only the output matters
    const added = await git(root, ["diff", "--no-index", "--no-color", "--", "/dev/null", path]);
    if (added.out.trim()) parts.push(added.out.trim());
  }
  const all = parts.filter(Boolean).join("\n");
  return all.length > maxChars ? `${all.slice(0, maxChars)}\n… (diff truncated)` : all;
}

/* -------------------------------- ignoring ---------------------------------- */
/** Is this folder inside a git work tree at all? */
export async function isRepo(root: string): Promise<boolean> {
  const { code, out } = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  return code === 0 && out.trim() === "true";
}

/**
 * Does git already ignore this path? `check-ignore` also honours parent rules,
 * `.git/info/exclude` and the global ignore file. A git failure counts as "not".
 */
export async function isIgnored(root: string, rel: string): Promise<boolean> {
  const { code } = await git(root, ["check-ignore", "-q", "--", rel]);
  return code === 0;
}

/** How many files under this path git already tracks (ignoring is not retroactive). */
export async function trackedUnder(root: string, rel: string): Promise<number> {
  const { code, out } = await git(root, ["ls-files", "--", rel]);
  if (code !== 0) return 0;
  return out.split(NEWLINE).filter((l) => l.trim()).length;
}
