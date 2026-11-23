export type Severity = "critical" | "high" | "medium" | "low" | "info";
export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export type ToolSource = "tool" | "skill" | "command";
export type ToolKind = "npx" | "docker" | "cli" | "cli-agent";
export type Scope = "local" | "url";
export type RunStatus = "running" | "success" | "error" | "cancelled";
export type RunKind = "scan" | "fix";
export type AIProvider = "claude" | "opencode" | "hermes";

/**
 * The colours a tag can take.
 *
 * A closed list, not a colour picker: every one of these is a token in
 * `globals.css` picked to stay legible on the app's surfaces, and a free hex
 * would let a user make a label they cannot read. Nine is already more than the
 * eye separates at a glance.
 */
export const TAG_COLORS = [
  "violet",
  "blue",
  "teal",
  "green",
  "amber",
  "orange",
  "red",
  "pink",
  "slate",
] as const;

export type TagColor = (typeof TAG_COLORS)[number];

/** A label the user invented, to find their own projects among many. */
export interface Tag {
  id: string;
  name: string;
  color: TagColor;
  created_at: number;
  updated_at: number;
}

export interface Project {
  id: string;
  name: string;
  path?: string | null;
  url?: string | null;
  stack: string[];
  /** Ids of the user's tags on this project. */
  tags: string[];
  authorized: boolean;
  /** Set when the project is retired: hidden from the working views, kept in history. */
  deleted_at?: number | null;
  /** Scans older than this are ignored by Findings — a reset that keeps the past. */
  cleared_at?: number | null;
  /**
   * Last real work on the project: a run started by hand, a terminal or agent
   * opened on it. Selecting it does not count, and neither does the scheduler.
   * Null until then — the list puts those last.
   */
  last_used_at?: number | null;
  /** `owner/name` of the GitHub repository it was cloned from, when Assay did the cloning. */
  github_repo?: string | null;
  /** That repository's visibility as GitHub last reported it; null when not known yet. */
  github_private?: boolean | null;
  created_at: number;
  updated_at: number;
}

/** An extra ESLint plugin the user wired into a lint tool by hand. */
export interface ToolPlugin {
  /** npm package, e.g. `eslint-plugin-sonarjs`. */
  pkg: string;
  /** Preset to pull the rules from, e.g. `sonarjs/recommended`. Empty = plugin only. */
  preset: string;
}

/**
 * Per-tool options. `groups` holds the ids of the enabled option groups declared
 * in `lib/tool-options.ts`; `plugins` holds whatever the user added on top.
 * Global to the tool, not per project.
 */
export interface ToolConfig {
  groups?: string[];
  plugins?: ToolPlugin[];
}

export interface Tool {
  id: string;
  name: string;
  source: ToolSource;
  kind: ToolKind;
  scope: Scope;
  stack: string[];
  cmd: string;
  adapter: string;
  prompt?: string | null;
  /** Options for tools that declare a schema (ESLint, Ruff). */
  config?: ToolConfig | null;
  builtin: boolean;
  enabled: boolean;
  notes?: string | null;
  created_at: number;
  updated_at: number;
}

export interface Run {
  id: string;
  project_id: string;
  tool_id?: string | null;
  tool_name: string;
  kind: RunKind;
  provider?: AIProvider | null;
  cmd: string;
  status: RunStatus;
  exit_code?: number | null;
  log: string;
  summary?: string | null;
  started_at: number;
  finished_at?: number | null;
  duration_ms?: number | null;
}

/**
 * What the user decided about a finding. `open` is untouched; the other three
 * are answers that must survive the next scan, which is what the fingerprint is
 * for.
 */
export type FindingStatus = "open" | "ignored" | "false-positive" | "accepted";

export interface Finding {
  id: string;
  run_id: string;
  project_id: string;
  tool_id?: string | null;
  severity: Severity;
  category?: string | null;
  file?: string | null;
  line?: number | null;
  message: string;
  raw?: string | null;
  fixed: boolean;
  status: FindingStatus;
  /** Why it was ignored / accepted — required by the UI, kept for the audit. */
  status_reason?: string | null;
  status_at?: number | null;
  /** Stable identity across scans: tool + rule + file + message. */
  fingerprint?: string | null;
  created_at: number;
}

export interface Edit {
  id: string;
  run_id: string;
  project_id: string;
  file: string;
  diff: string;
  added: number;
  removed: number;
  created_at: number;
}

/** A normalized finding produced by a tool adapter (pre-persist). */
export interface RawFinding {
  severity: Severity;
  category?: string;
  file?: string;
  line?: number;
  message: string;
  raw?: unknown;
}

/* ---------------------------------- deploy ---------------------------------- */
export type DeployProtocol = "sftp" | "ftp" | "ftps";
/** SFTP logs in with a password or a key; FTP always with the password. */
export type DeployAuth = "password" | "key";

/**
 * A server a project uploads to. The password (or the key's passphrase) is not
 * here: it lives in the OS keychain under the server id.
 */
export interface DeployServer {
  id: string;
  project_id: string;
  name: string;
  protocol: DeployProtocol;
  host: string;
  port: number;
  username: string;
  auth: DeployAuth;
  key_path: string | null;
  /** Where the files land on the server, `/var/www/site`. */
  remote_path: string;
  /** The local folder that is deployed, relative to the project (`dist`); empty for the whole project. */
  local_dir: string;
  excludes: string[];
  /** SHA256 fingerprint accepted on first contact (SFTP). */
  host_key: string | null;
  is_default: boolean;
  auto_upload: boolean;
  last_deploy_at: number | null;
  created_at: number;
}
