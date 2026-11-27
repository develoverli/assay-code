/**
 * GitHub: the linked account, the repositories it can see, cloning, and the auth
 * header for push/pull.
 *
 * Linking is an OAuth device flow: no client secret, no local server, no URL scheme.
 * The token lives in the settings table and only ever leaves as a header to GitHub.
 * git receives it through `GIT_CONFIG_*` in the environment, so it never appears on
 * a command line or in a clone's `.git/config`.
 */
import { fetch } from "@tauri-apps/plugin-http";
import { exists } from "@tauri-apps/plugin-fs";
import * as db from "@/lib/db";
import { runProgram, type ProcResult, type StreamKind } from "@/lib/exec";
import type { Project } from "@/types";

/**
 * The OAuth App this build talks to. Public by design: device-flow apps carry no
 * secret. Forks register their own with "Enable Device Flow" ticked.
 */
export const GITHUB_CLIENT_ID = "Ov23liZthLOlD5Fv4BiK";

/** `repo` for private repositories (clone, push, pull); `read:org` for organisation-shared ones. */
const GITHUB_SCOPES = "repo read:org";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const API = "https://api.github.com";
const GITHUB_WEB = "https://github.com";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** GitHub refuses requests with no User-Agent; the name is all it asks for. */
const USER_AGENT = "Assay";
/** 100 per page is the API's maximum; ten pages is more repositories than a list can show. */
const REPOS_PER_PAGE = 100;
const REPOS_MAX_PAGES = 10;

const SETTING_TOKEN = "github.token";
const SETTING_LOGIN = "github.login";
const SETTING_AVATAR = "github.avatar";
const SETTING_REFRESH = "github.refreshToken";
const SETTING_EXPIRES = "github.expiresAt";
const SETTING_REFRESH_EXPIRES = "github.refreshExpiresAt";

/** A token this close to its end is renewed before it is used, not after it fails. */
const RENEW_MARGIN_MS = 5 * 60 * 1000;
const CODE_EXPIRED = "The code expired before it was used. Start again to get a new one.";
const CANCELLED = "Cancelled.";
const SETTING_CLONE_ROOT = "github.cloneRoot";

/* --------------------------------- account ---------------------------------- */
/**
 * The token and what renews it. Expiring tokens live 8 hours, their refresh token
 * 6 months; a non-expiring token has neither field and is used as it is.
 */
export interface TokenGrant {
  token: string;
  refreshToken: string | null;
  /** Epoch ms; null for a token that does not expire. */
  expiresAt: number | null;
  refreshExpiresAt: number | null;
}

export interface GitHubAccount extends TokenGrant {
  login: string;
  avatarUrl: string;
}

const num = (v: string | null): number | null => (v && Number.isFinite(Number(v)) ? Number(v) : null);

export async function getAccount(): Promise<GitHubAccount | null> {
  const [token, login, avatar, refresh, expires, refreshExpires] = await Promise.all([
    db.getSetting(SETTING_TOKEN),
    db.getSetting(SETTING_LOGIN),
    db.getSetting(SETTING_AVATAR),
    db.getSetting(SETTING_REFRESH),
    db.getSetting(SETTING_EXPIRES),
    db.getSetting(SETTING_REFRESH_EXPIRES),
  ]);
  if (!token || !login) return null;
  return {
    token,
    login,
    avatarUrl: avatar ?? "",
    refreshToken: refresh || null,
    expiresAt: num(expires),
    refreshExpiresAt: num(refreshExpires),
  };
}

async function saveGrant(g: TokenGrant): Promise<void> {
  await Promise.all([
    db.setSetting(SETTING_TOKEN, g.token),
    db.setSetting(SETTING_REFRESH, g.refreshToken ?? ""),
    db.setSetting(SETTING_EXPIRES, g.expiresAt ? String(g.expiresAt) : ""),
    db.setSetting(SETTING_REFRESH_EXPIRES, g.refreshExpiresAt ? String(g.refreshExpiresAt) : ""),
  ]);
}

async function saveAccount(a: GitHubAccount): Promise<void> {
  await Promise.all([saveGrant(a), db.setSetting(SETTING_LOGIN, a.login), db.setSetting(SETTING_AVATAR, a.avatarUrl)]);
}

/**
 * Forget the token locally. Revoking the grant needs the client secret this app
 * lacks, so the user does that under github.com/settings/applications.
 */
export async function disconnect(): Promise<void> {
  await Promise.all([
    saveGrant({ token: "", refreshToken: null, expiresAt: null, refreshExpiresAt: null }),
    db.setSetting(SETTING_LOGIN, ""),
    db.setSetting(SETTING_AVATAR, ""),
  ]);
}

export async function getCloneRoot(): Promise<string> {
  return (await db.getSetting(SETTING_CLONE_ROOT)) ?? "";
}

export async function setCloneRoot(root: string): Promise<void> {
  await db.setSetting(SETTING_CLONE_ROOT, root);
}

/* -------------------------------- device flow ------------------------------- */
export interface DeviceCode {
  deviceCode: string;
  /** What the user types at `verificationUri`. */
  userCode: string;
  verificationUri: string;
  /** Seconds between polls, as GitHub asked. */
  interval: number;
  /** When the code stops working, epoch ms. */
  expiresAt: number;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  /** Seconds; present only when the app hands out expiring tokens. */
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

/** A token answer as what Assay keeps: the token, what renews it, and when each ends. */
export function grantFrom(r: TokenResponse, now: number): TokenGrant | null {
  if (!r.access_token) return null;
  return {
    token: r.access_token,
    refreshToken: r.refresh_token || null,
    expiresAt: r.expires_in ? now + r.expires_in * 1000 : null,
    refreshExpiresAt: r.refresh_token_expires_in ? now + r.refresh_token_expires_in * 1000 : null,
  };
}

/** Whether a grant should be renewed before its next use. */
export function needsRenewal(g: Pick<TokenGrant, "expiresAt" | "refreshToken">, now: number): boolean {
  return !!g.refreshToken && g.expiresAt !== null && g.expiresAt - now < RENEW_MARGIN_MS;
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function postForm<T>(url: string, fields: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: form(fields),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Ask GitHub for a code. The caller shows it and then polls with `waitForToken`. */
export async function startDeviceFlow(clientId = GITHUB_CLIENT_ID): Promise<DeviceCode> {
  if (!clientId) throw new Error("No GitHub OAuth client id is configured in this build.");
  const r = await postForm<DeviceCodeResponse>(DEVICE_CODE_URL, { client_id: clientId, scope: GITHUB_SCOPES });
  return {
    deviceCode: r.device_code,
    userCode: r.user_code,
    verificationUri: r.verification_uri,
    interval: Math.max(1, r.interval || 5),
    expiresAt: Date.now() + (r.expires_in || 900) * 1000,
  };
}

/** What the poll loop should do after one answer from GitHub. */
export type PollStep =
  | { kind: "wait"; interval: number }
  | { kind: "token"; grant: TokenGrant }
  | { kind: "fail"; reason: string };

/**
 * One device-flow answer: pending keeps polling, slow_down adds five seconds, and
 * everything else is final.
 */
export function readPollAnswer(r: TokenResponse, interval: number, now = Date.now()): PollStep {
  const grant = grantFrom(r, now);
  if (grant) return { kind: "token", grant };
  switch (r.error) {
    case "authorization_pending":
      return { kind: "wait", interval };
    case "slow_down":
      return { kind: "wait", interval: interval + 5 };
    case "expired_token":
      return { kind: "fail", reason: CODE_EXPIRED };
    case "access_denied":
      return { kind: "fail", reason: "Authorisation was cancelled on GitHub." };
    default:
      return { kind: "fail", reason: r.error_description || r.error || "GitHub returned no token." };
  }
}

/**
 * Wait `ms`, or reject with CANCELLED when `signal` aborts. The abort listener is
 * removed when the timer wins, so a long device-flow poll does not pile them up.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(CANCELLED));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error(CANCELLED));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll until the user has authorised, the code expires, or `signal` aborts.
 * On success the account is looked up and stored, and returned.
 */
export async function waitForToken(
  code: DeviceCode,
  signal?: AbortSignal,
  clientId = GITHUB_CLIENT_ID,
): Promise<GitHubAccount> {
  let interval = code.interval;
  for (;;) {
    if (signal?.aborted) throw new Error(CANCELLED);
    if (Date.now() > code.expiresAt) throw new Error(CODE_EXPIRED);
    await sleep(interval * 1000, signal);
    const r = await postForm<TokenResponse>(ACCESS_TOKEN_URL, {
      client_id: clientId,
      device_code: code.deviceCode,
      grant_type: DEVICE_GRANT,
    });
    const step = readPollAnswer(r, interval);
    if (step.kind === "wait") {
      interval = step.interval;
      continue;
    }
    if (step.kind === "fail") throw new Error(step.reason);
    const viewer = await fetchViewer(step.grant.token);
    const account: GitHubAccount = { ...step.grant, login: viewer.login, avatarUrl: viewer.avatar_url };
    await saveAccount(account);
    return account;
  }
}

/* ------------------------------- token renewal ------------------------------ */
/**
 * Trade the refresh token for a new pair (device-flow tokens renew without a client
 * secret). GitHub rotates the refresh token on every use, so the new one is saved at once.
 */
async function renew(refreshToken: string): Promise<TokenGrant> {
  const r = await postForm<TokenResponse>(ACCESS_TOKEN_URL, {
    client_id: GITHUB_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const grant = grantFrom(r, Date.now());
  if (!grant) throw new TokenRejectedError(r.error_description || r.error || "GitHub did not renew the token.");
  await saveGrant(grant);
  return grant;
}

/**
 * One renewal at a time. The refresh token is single use: two calls renewing
 * at once would spend it twice, and the second answer would sign the user out.
 */
let renewing: Promise<TokenGrant> | null = null;

function renewOnce(refreshToken: string): Promise<TokenGrant> {
  renewing ??= renew(refreshToken).finally(() => {
    renewing = null;
  });
  return renewing;
}

/**
 * Run `fn` with a token GitHub will accept: renewed first when about to expire, and
 * once more if refused anyway. A refusal after that is the caller's to report.
 */
export async function withGitHubToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
  const account = await getAccount();
  if (!account) throw new TokenRejectedError("No GitHub account is linked.");
  if (account.refreshExpiresAt !== null && account.refreshExpiresAt <= Date.now()) {
    throw new TokenRejectedError("The GitHub link is older than six months and has to be made again.");
  }
  const token = needsRenewal(account, Date.now()) && account.refreshToken
    ? (await renewOnce(account.refreshToken)).token
    : account.token;
  try {
    return await fn(token);
  } catch (e) {
    if (!(e instanceof TokenRejectedError) || !account.refreshToken) throw e;
    // a clock off by more than the margin, or a token GitHub ended early
    const fresh = await getAccount();
    const retry = fresh?.token && fresh.token !== token ? fresh.token : (await renewOnce(fresh?.refreshToken ?? account.refreshToken)).token;
    return fn(retry);
  }
}

/* ----------------------------------- api ------------------------------------ */
interface Viewer {
  login: string;
  avatar_url: string;
}

export interface Repo {
  id: number;
  name: string;
  /** `owner/name`, the identity Assay stores on a project. */
  fullName: string;
  owner: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  description: string;
  language: string;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  /** Last push, epoch ms; what the list is ordered by. */
  pushedAt: number;
}

interface RepoResponse {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  private: boolean;
  fork: boolean;
  archived: boolean;
  description: string | null;
  language: string | null;
  default_branch: string;
  html_url: string;
  clone_url: string;
  pushed_at: string | null;
}

/** GitHub refused the stored token (revoked, expired, or a refresh that failed). */
export class TokenRejectedError extends Error {
  /** What GitHub itself said, shown under the sentence so the reason is never guessed. */
  readonly detail: string;
  constructor(detail = "") {
    super("GitHub no longer accepts the saved token.");
    this.name = "TokenRejectedError";
    this.detail = detail;
  }
}

async function api<T>(token: string, path: string): Promise<{ body: T; link: string | null }> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": USER_AGENT,
    },
  });
  if (res.status === 401) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new TokenRejectedError(body?.message ?? "401 Unauthorized");
  }
  if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}`);
  return { body: (await res.json()) as T, link: res.headers.get("link") };
}

async function fetchViewer(token: string): Promise<Viewer> {
  return (await api<Viewer>(token, "/user")).body;
}

/** The `page` the `Link` header's `rel="next"` points at, or null on the last page. */
export function nextPageOf(link: string | null): number | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (!m) continue;
    const page = /[?&]page=(\d+)/.exec(m[1]);
    return page ? Number(page[1]) : null;
  }
  return null;
}

function mapRepo(r: RepoResponse): Repo {
  return {
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    owner: r.owner.login,
    private: r.private,
    fork: r.fork,
    archived: r.archived,
    description: r.description ?? "",
    language: r.language ?? "",
    defaultBranch: r.default_branch,
    htmlUrl: r.html_url,
    cloneUrl: r.clone_url,
    pushedAt: r.pushed_at ? Date.parse(r.pushed_at) : 0,
  };
}

/**
 * Every repository the account can clone — its own, the ones it collaborates
 * on, and the ones its organisations share — most recently pushed first.
 */
export async function listRepos(token: string): Promise<Repo[]> {
  const out: Repo[] = [];
  let page: number | null = 1;
  while (page !== null && page <= REPOS_MAX_PAGES) {
    const query = `per_page=${REPOS_PER_PAGE}&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`;
    const { body, link } = await api<RepoResponse[]>(token, `/user/repos?${query}`);
    out.push(...body.map(mapRepo));
    page = nextPageOf(link);
  }
  return out;
}

/* --------------------------------- releases --------------------------------- */
/** The pull request release-please keeps open with the next version and its changelog. */
export interface ReleasePullRequest {
  number: number;
  title: string;
  url: string;
}

export interface PublishedRelease {
  tag: string;
  name: string;
  url: string;
  /** Epoch ms; 0 when GitHub gave none (a draft). */
  publishedAt: number;
}

export interface ReleaseInfo {
  pullRequest: ReleasePullRequest | null;
  latest: PublishedRelease | null;
}

/** The label release-please puts on its pull request until the release is cut. */
const RELEASE_PENDING_LABEL = "autorelease: pending";

/** `owner/name` from a repository's web URL on github.com, else null. */
export function githubRepoFromWebUrl(url: string | null): string | null {
  if (!url) return null;
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** A GET whose 404 is an answer ("there is none"), not a failure. */
async function apiOrNull<T>(token: string, path: string): Promise<T | null> {
  try {
    return (await api<T>(token, path)).body;
  } catch (e) {
    if (e instanceof Error && /answered 404\b/.test(e.message)) return null;
    throw e;
  }
}

interface IssueResponse {
  number: number;
  title: string;
  html_url: string;
  pull_request?: unknown;
}

interface ReleaseResponse {
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string | null;
}

/**
 * Read-only: the open release pull request (found by its label) and the newest
 * published release. Two GETs with the linked account; nothing is written.
 */
export async function fetchReleaseInfo(fullName: string): Promise<ReleaseInfo> {
  const [owner, name] = fullName.split("/");
  const repo = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  return withGitHubToken(async (token) => {
    const label = encodeURIComponent(RELEASE_PENDING_LABEL);
    const [issues, latest] = await Promise.all([
      apiOrNull<IssueResponse[]>(token, `${repo}/issues?state=open&labels=${label}&per_page=10`),
      apiOrNull<ReleaseResponse>(token, `${repo}/releases/latest`),
    ]);
    // the issues endpoint lists pull requests too; only those carry `pull_request`
    const pr = (issues ?? []).find((i) => i.pull_request != null);
    return {
      pullRequest: pr ? { number: pr.number, title: pr.title, url: pr.html_url } : null,
      latest: latest
        ? {
            tag: latest.tag_name,
            name: latest.name?.trim() || latest.tag_name,
            url: latest.html_url,
            publishedAt: latest.published_at ? Date.parse(latest.published_at) : 0,
          }
        : null,
    };
  });
}

/** Case-insensitive match on `owner/name` and the description, every word required. */
export function filterRepos(repos: Repo[], query: string): Repo[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return repos;
  return repos.filter((r) => {
    const hay = `${r.fullName} ${r.description}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/* ---------------------------------- clone ----------------------------------- */
/** Where a repository lands: `<root>/<name>`, joined with the separator the root already uses. */
export function cloneDestination(root: string, name: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  const sep = trimmed.includes("\\") && !trimmed.includes("/") ? "\\" : "/";
  return `${trimmed}${sep}${name}`;
}

/**
 * The same folder written two ways: separators unified, trailing ones dropped,
 * and case folded for a Windows path (drive letter), whose filesystem ignores it.
 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const s = p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[a-zA-Z]:/.test(s) ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

const authHeader = (token: string): string => `Authorization: Basic ${btoa(`x-access-token:${token}`)}`;

/**
 * The environment for cloning: the token through `GIT_CONFIG_COUNT` (git 2.31+), never
 * on the command line or in the clone's config, and `GIT_TERMINAL_PROMPT=0` so a
 * refused clone fails instead of hanging on an invisible password prompt.
 */
export function cloneEnv(token: string | null): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  if (token) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = authHeader(token);
  }
  return env;
}

/**
 * The same header for push/pull, scoped by URL to github.com so no other host ever
 * receives it. Takes precedence over the user's credential helper.
 */
export function remoteAuthEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${GITHUB_WEB}/.extraHeader`,
    GIT_CONFIG_VALUE_0: authHeader(token),
  };
}

/** Only an https remote on github.com can take the token; ssh keeps the user's key. */
export function isGitHubHttpsRemote(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" && u.hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

export interface CloneResult extends ProcResult {
  dest: string;
}

/** `git clone --progress <url> <dest>`, streaming git's progress. The folder must not exist yet. */
export async function cloneRepo(
  repo: Repo,
  root: string,
  token: string,
  onData?: (chunk: string, stream: StreamKind) => void,
): Promise<CloneResult> {
  const dest = cloneDestination(root, repo.name);
  if (await exists(dest)) throw new Error(`${dest} already exists.`);
  const env = cloneEnv(repo.private ? token : null);
  const { result } = runProgram("git", ["clone", "--progress", repo.cloneUrl, dest], { env, onData });
  const r = await result;
  return { ...r, dest };
}

/** The command the dialog shows before it runs, with nothing secret in it. */
export function cloneCommandPreview(repo: Repo, root: string): string {
  return `git clone ${repo.cloneUrl} ${cloneDestination(root, repo.name)}`;
}

/* ------------------------------ project filters ----------------------------- */
/** The account (user or organisation) a cloned project came from, or null for the rest. */
export function githubOwnerOf(project: Pick<Project, "github_repo">): string | null {
  const full = project.github_repo;
  if (!full) return null;
  const slash = full.indexOf("/");
  return slash > 0 ? full.slice(0, slash) : null;
}

export interface GitHubOwnerCount {
  owner: string;
  count: number;
}

/**
 * Every account the list was cloned from, most projects first, then by name so
 * two accounts with one project each keep a stable order.
 */
export function githubOwners(projects: Pick<Project, "github_repo">[]): GitHubOwnerCount[] {
  const counts = new Map<string, number>();
  for (const p of projects) {
    const owner = githubOwnerOf(p);
    if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([owner, count]) => ({ owner, count }))
    .sort((a, b) => b.count - a.count || a.owner.localeCompare(b.owner));
}

/** Only the projects cloned from `owner`; null means no filter. */
export function filterByGithubOwner<P extends Pick<Project, "github_repo">>(projects: P[], owner: string | null): P[] {
  if (!owner) return projects;
  return projects.filter((p) => githubOwnerOf(p) === owner);
}
