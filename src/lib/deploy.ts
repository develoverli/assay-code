import { invoke } from "@tauri-apps/api/core";
import type { DeployAuth, DeployProtocol, DeployServer } from "@/types";
import type { DeployedFile } from "@/lib/db";

/**
 * Deploy: what changed since the last upload to a server, and the upload. A manifest
 * per server records what it last received (an agent never triggers upload-on-save),
 * and `deploy_scan` (Rust) compares it with the disk.
 */

/** Never uploaded unless the user takes it out of the list. `.env` above all. */
export const DEFAULT_EXCLUDES = [
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  ".vscode",
  ".idea",
  ".DS_Store",
  "Thumbs.db",
  ".env",
  ".env.*",
  "graphify-out",
  "*.log",
];

export function defaultPort(protocol: DeployProtocol): number {
  return protocol === "sftp" ? 22 : 21;
}

export const PROTOCOL_LABEL: Record<DeployProtocol, string> = { sftp: "SFTP", ftp: "FTP", ftps: "FTPS" };

/** `deploy@example.com:/var/www` — how a server is recognised in a list. */
export function serverAddress(s: Pick<DeployServer, "username" | "host" | "port" | "protocol" | "remote_path">): string {
  const port = s.port && s.port !== defaultPort(s.protocol) ? `:${s.port}` : "";
  const user = s.username ? `${s.username}@` : "";
  return `${user}${s.host}${port}:${s.remote_path || "~"}`;
}

/** The exclude box: one pattern per line, blanks dropped. */
export function parseExcludes(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/* --------------------------------- sftp.json -------------------------------- */

/** What VS Code's SFTP extension writes in `.vscode/sftp.json` (a subset: what Assay can use). */
interface SftpJsonConfig {
  name?: unknown;
  host?: unknown;
  protocol?: unknown;
  port?: unknown;
  username?: unknown;
  password?: unknown;
  privateKeyPath?: unknown;
  passphrase?: unknown;
  remotePath?: unknown;
  context?: unknown;
  secure?: unknown;
  ignore?: unknown;
  profiles?: unknown;
  defaultProfile?: unknown;
}

/** A server read from sftp.json, before it belongs to a project. */
export interface ServerDraft {
  name: string;
  protocol: DeployProtocol;
  host: string;
  port: number;
  username: string;
  auth: DeployAuth;
  key_path: string | null;
  remote_path: string;
  local_dir: string;
  excludes: string[];
  is_default: boolean;
  /** A password written into the file, to be moved into the keychain on import. */
  secret: string | null;
}

/** sftp.json allows comments; JSON.parse does not. Strings are left alone. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  // a trailing comma before } or ] is the other thing hand-edited JSON carries
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function draftFrom(c: SftpJsonConfig, name: string, isDefault: boolean): ServerDraft | null {
  const host = str(c.host);
  if (!host) return null;
  const raw = str(c.protocol).toLowerCase();
  const protocol: DeployProtocol = raw === "ftp" ? (c.secure === true || c.secure === "control" ? "ftps" : "ftp") : "sftp";
  const port = typeof c.port === "number" && c.port > 0 ? Math.round(c.port) : defaultPort(protocol);
  const keyPath = str(c.privateKeyPath);
  const password = str(c.password);
  const passphrase = typeof c.passphrase === "string" ? c.passphrase : "";
  const auth: DeployAuth = protocol === "sftp" && keyPath ? "key" : "password";
  const ignore = Array.isArray(c.ignore) ? c.ignore.map(str).filter(Boolean) : [];
  return {
    name,
    protocol,
    host,
    port,
    username: str(c.username),
    auth,
    key_path: auth === "key" ? keyPath : null,
    remote_path: str(c.remotePath) || "/",
    local_dir: str(c.context).replace(/^\.\/?/, "").replace(/\\/g, "/").replace(/\/+$/, ""),
    excludes: ignore.length ? ignore : [...DEFAULT_EXCLUDES],
    is_default: isDefault,
    secret: (auth === "key" ? passphrase : password) || null,
  };
}

/**
 * The servers in an sftp.json: one config, or a list of them, each possibly
 * with `profiles` that override it (staging, production). Anything Assay
 * cannot use is skipped rather than guessed; a file that is not JSON throws.
 */
export function parseSftpJson(text: string): ServerDraft[] {
  const parsed: unknown = JSON.parse(stripJsonComments(text));
  const configs = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (c): c is SftpJsonConfig => typeof c === "object" && c !== null,
  );
  const drafts: ServerDraft[] = [];
  configs.forEach((c, i) => {
    const base = str(c.name) || str(c.host) || `Server ${i + 1}`;
    const profiles = typeof c.profiles === "object" && c.profiles !== null ? (c.profiles as Record<string, unknown>) : null;
    const names = profiles ? Object.keys(profiles) : [];
    if (!names.length) {
      const d = draftFrom(c, base, drafts.length === 0);
      if (d) drafts.push(d);
      return;
    }
    const preferred = str(c.defaultProfile);
    for (const profile of names) {
      const overrides = profiles?.[profile];
      const merged: SftpJsonConfig = { ...c, ...(typeof overrides === "object" && overrides ? overrides : {}) };
      const d = draftFrom(merged, `${base} · ${profile}`, false);
      if (d) drafts.push(d);
    }
    const pick = drafts.find((d) => d.name === `${base} · ${preferred}`) ?? drafts[0];
    if (pick && !drafts.some((d) => d.is_default)) pick.is_default = true;
  });
  return drafts;
}

/** The servers as VS Code's sftp.json, with `uploadOnSave` on. Never a password: the file is often in git. */
export function toSftpJson(servers: DeployServer[]): string {
  const configs = servers.map((s) => {
    const c: Record<string, unknown> = {
      name: s.name,
      host: s.host,
      protocol: s.protocol === "sftp" ? "sftp" : "ftp",
      port: s.port,
      username: s.username,
      remotePath: s.remote_path,
      uploadOnSave: true,
    };
    if (s.protocol === "ftps") c.secure = true;
    if (s.local_dir) c.context = `./${s.local_dir}`;
    if (s.auth === "key" && s.key_path) c.privateKeyPath = s.key_path;
    if (s.excludes.length) c.ignore = s.excludes;
    return c;
  });
  return `${JSON.stringify(configs.length === 1 ? configs[0] : configs, null, 2)}\n`;
}

/* --------------------------------- changes ---------------------------------- */

export interface ScanResult {
  added: DeployedFile[];
  modified: DeployedFile[];
  /** Same content, new mtime: recorded, never uploaded. */
  touched: DeployedFile[];
  deleted: string[];
  files: number;
}

export type ChangeKind = "added" | "modified" | "deleted";

export interface DeployChange {
  path: string;
  kind: ChangeKind;
  /** Absent for a deletion. */
  file?: DeployedFile;
}

/** Added and modified in one list, by path; deletions apart, since they are never picked by default. */
export function changesOf(scan: ScanResult): { uploads: DeployChange[]; deletions: DeployChange[] } {
  const uploads: DeployChange[] = [
    ...scan.added.map((file) => ({ path: file.path, kind: "added" as const, file })),
    ...scan.modified.map((file) => ({ path: file.path, kind: "modified" as const, file })),
  ].sort((a, b) => a.path.localeCompare(b.path));
  const deletions = scan.deleted.map((path) => ({ path, kind: "deleted" as const }));
  return { uploads, deletions };
}

/* ------------------------------------ ipc ----------------------------------- */

/** The shape `deploy.rs` takes: everything it needs to connect, nothing secret. */
function connOf(s: DeployServer) {
  return {
    serverId: s.id,
    protocol: s.protocol,
    host: s.host.trim(),
    port: s.port,
    username: s.username.trim(),
    auth: s.protocol === "sftp" ? s.auth : "password",
    keyPath: s.key_path,
    remotePath: s.remote_path.trim(),
    hostKey: s.host_key,
  };
}

export function scanServer(root: string, server: DeployServer, known: DeployedFile[]): Promise<ScanResult> {
  return invoke<ScanResult>("deploy_scan", { root, localDir: server.local_dir, excludes: server.excludes, known });
}

export type TestResult =
  | { status: "ok"; cwd: string; entries: string[] }
  | { status: "unknown-host"; fingerprint: string }
  | { status: "host-changed"; expected: string; fingerprint: string };

export function testServer(server: DeployServer): Promise<TestResult> {
  return invoke<TestResult>("deploy_test", { conn: connOf(server) });
}

export interface UploadResult {
  uploaded: string[];
  deleted: string[];
  failed: { path: string; error: string }[];
  cancelled: boolean;
}

export interface UploadProgress {
  jobId: string;
  path: string;
  action: "upload" | "delete";
  done: number;
  total: number;
  error: string | null;
}

export const PROGRESS_EVENT = "deploy://progress";

export function uploadToServer(
  jobId: string,
  root: string,
  server: DeployServer,
  files: string[],
  deletes: string[],
): Promise<UploadResult> {
  return invoke<UploadResult>("deploy_upload", {
    jobId,
    conn: connOf(server),
    root,
    localDir: server.local_dir,
    files,
    deletes,
  });
}

export function cancelUpload(jobId: string): Promise<void> {
  return invoke("deploy_cancel", { jobId });
}

export function setServerSecret(serverId: string, secret: string): Promise<void> {
  return invoke("deploy_secret_set", { serverId, secret });
}

export function deleteServerSecret(serverId: string): Promise<void> {
  return invoke("deploy_secret_delete", { serverId });
}

export function hasServerSecret(serverId: string): Promise<boolean> {
  return invoke<boolean>("deploy_secret_has", { serverId });
}
