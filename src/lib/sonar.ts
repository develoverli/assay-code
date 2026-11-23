/**
 * SonarQube integration.
 *
 * Sonar has no standalone mode: the scanner only *uploads* to a server, which
 * then computes the issues asynchronously. So an Assay Sonar run is orchestrated
 * (see `startSonarScan` in runner.ts) rather than being a single shell command:
 *
 *   1. ensureServer()  — docker network + container, wait for /api/system/status
 *   2. ensureProject() — create the project (idempotent) under a stable key
 *   3. scanner         — docker sonar-scanner-cli, streamed to the run log
 *   4. waitForTask()   — poll the Compute Engine task parsed from the scanner log
 *   5. collect()       — issues + hotspots + quality gate + measures + rule help
 *
 * The server can also be an external one (self-hosted or SonarQube Cloud): then
 * only steps 2-5 run, against the host/token configured in Settings.
 */
import { fetch } from "@tauri-apps/plugin-http";
import { runOnce } from "@/lib/exec";
import * as db from "@/lib/db";
import { tr } from "@/lib/i18n";

/* ---------------------------------- config ---------------------------------- */
/** Container + docker network Assay manages. The scanner joins this network. */
export const SONAR_CONTAINER = "sechub-sonar";
const SONAR_NETWORK = "sechub-sonar";
const SONAR_IMAGE = "sonarqube:community";
const SCANNER_IMAGE = "sonarsource/sonar-scanner-cli";
/** The port SonarQube listens on inside its container. */
const CONTAINER_PORT = "9000";
const DEFAULT_PORT = CONTAINER_PORT;
/** Server URL as seen from *inside* the scanner container (same docker network). */
const INTERNAL_HOST = `http://${SONAR_CONTAINER}:${CONTAINER_PORT}`;
const ADMIN_PASSWORD_SETTING = "sonar.adminPassword";
const TOKEN_SETTING = "sonar.token";
/** SonarQube's first boot takes ~1-2 minutes. */
const WAIT_UP_TIMEOUT_MS = 300_000;

export interface SonarConfig {
  /** true → Assay owns the docker container; false → point at an existing server. */
  managed: boolean;
  /** Published port of the managed container (also the localhost port). */
  port: string;
  /** Base URL used by Assay itself. For managed mode it's http://127.0.0.1:<port>. */
  host: string;
  /** Analysis + Web API token. Auto-generated in managed mode. */
  token: string;
  /** Admin password of the managed container (generated on first boot). */
  adminPassword: string;
  /** SonarQube Cloud's organization key; only sent when filled in. */
  organization: string;
}

export async function getSonarConfig(): Promise<SonarConfig> {
  const [managed, port, host, token, adminPassword, organization] = await Promise.all([
    db.getSetting("sonar.managed"),
    db.getSetting("sonar.port"),
    db.getSetting("sonar.host"),
    db.getSetting(TOKEN_SETTING),
    db.getSetting(ADMIN_PASSWORD_SETTING),
    db.getSetting("sonar.organization"),
  ]);
  const isManaged = managed !== "0";
  const p = port || DEFAULT_PORT;
  // the trailing slashes come off in a loop: `/\/+$/` backtracks quadratically
  // 127.0.0.1, not localhost: the container is bound to IPv4 loopback only, and
  // localhost may resolve to ::1 first
  let resolvedHost = isManaged ? `http://127.0.0.1:${p}` : host || "";
  while (resolvedHost.endsWith("/")) resolvedHost = resolvedHost.slice(0, -1);
  return {
    managed: isManaged,
    port: p,
    host: resolvedHost,
    token: token ?? "",
    adminPassword: adminPassword ?? "",
    organization: (organization ?? "").trim(),
  };
}

/**
 * Stable per-project key: survives renames, so Sonar keeps the history. The
 * `sechub-` prefix (like the container and volume names) is frozen: changing it
 * would orphan every analysis already on the user's server.
 */
export function projectKey(projectId: string): string {
  return `sechub-${projectId}`;
}

/* ----------------------------------- http ----------------------------------- */
type Auth = { token: string } | { user: string; pass: string };

function authHeader(auth: Auth): string {
  if ("token" in auth) return `Bearer ${auth.token}`;
  const basic = btoa(`${auth.user}:${auth.pass}`);
  return `Basic ${basic}`;
}

interface ApiOpts {
  method?: "GET" | "POST";
  auth?: Auth;
  /** Query string / form params. */
  params?: Record<string, string | number | undefined>;
  /** Don't throw on a non-2xx response — return the parsed body instead. */
  soft?: boolean;
}

function qs(params: Record<string, string | number | undefined> = {}): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.set(k, String(v));
  return u.toString();
}

class SonarApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** A JSON body as Sonar returns it: its fields are unknown until they are read. */
type Json = Record<string, unknown>;

function obj(v: unknown): Json {
  return typeof v === "object" && v !== null ? (v as Json) : {};
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  return typeof v === "string" ? v : String(v);
}

/** The `errors[]` Sonar returns on a failure, as one sentence. */
function errorText(body: unknown): string {
  return list(obj(body).errors)
    .map((e) => String(obj(e).msg))
    .join("; ");
}

interface RawResponse {
  ok: boolean;
  status: number;
  statusText: string;
  /** Parsed JSON, the raw text when it isn't JSON, or null when empty. */
  body: unknown;
}

/** One Web API request. GET params go in the query, POST params in the body. */
async function send(host: string, path: string, opts: ApiOpts): Promise<RawResponse> {
  const method = opts.method ?? "GET";
  const query = qs(opts.params);
  const search = method === "GET" && query ? `?${query}` : "";
  const url = `${host}${path}${search}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.auth) headers.Authorization = authHeader(opts.auth);
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";

  const res = await fetch(url, { method, headers, body: method === "POST" ? query : undefined });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, statusText: res.statusText, body };
}

/** Call the Sonar Web API; throws on a non-2xx response unless `soft`. */
async function api<T = unknown>(host: string, path: string, opts: ApiOpts = {}): Promise<T> {
  const { ok, status, statusText, body } = await send(host, path, opts);
  if (!ok && !opts.soft) {
    const msg = errorText(body) || (typeof body === "string" ? body.slice(0, 200) : "") || statusText;
    throw new SonarApiError(status, `Sonar ${path} → ${status}: ${msg}`);
  }
  return body as T;
}

/** Same call, but the caller also needs the status (e.g. to report *why* it failed). */
async function apiRaw(host: string, path: string, opts: ApiOpts = {}): Promise<{ ok: boolean; status: number; body: unknown }> {
  const { ok, status, body } = await send(host, path, opts);
  return { ok, status, body };
}

/* --------------------------------- docker ----------------------------------- */
type Log = (line: string) => void;

async function dockerAvailable(): Promise<boolean> {
  return (await runOnce("docker --version")).code === 0;
}

export type ContainerState = "running" | "stopped" | "absent";

export async function containerState(): Promise<ContainerState> {
  const r = await runOnce(`docker inspect -f "{{.State.Running}}" ${SONAR_CONTAINER}`);
  if (r.code !== 0) return "absent";
  return r.stdout.trim().toLowerCase().startsWith("true") ? "running" : "stopped";
}

/** True when the container publishes a port on anything but 127.0.0.1 (empty HostIp = all interfaces). */
async function publishedBeyondLoopback(): Promise<boolean> {
  const r = await runOnce(`docker inspect -f "{{json .HostConfig.PortBindings}}" ${SONAR_CONTAINER}`);
  if (r.code !== 0) return false;
  try {
    const bindings = JSON.parse(r.stdout.trim()) as Record<string, { HostIp?: string }[] | null> | null;
    return Object.values(bindings ?? {}).some((list) => (list ?? []).some((b) => (b.HostIp ?? "") !== "127.0.0.1"));
  } catch {
    return false;
  }
}

async function ensureNetwork(): Promise<void> {
  const r = await runOnce(`docker network inspect ${SONAR_NETWORK}`);
  if (r.code !== 0) await runOnce(`docker network create ${SONAR_NETWORK}`);
}

/** Create (or start) the managed SonarQube container. Data lives in named volumes. */
export async function startServer(port: string, log: Log = () => {}): Promise<void> {
  if (!(await dockerAvailable())) throw new Error("Docker is not available on PATH — SonarQube needs it.");
  await ensureNetwork();
  let state = await containerState();
  if (state !== "absent" && (await publishedBeyondLoopback())) {
    // created by an older Assay on every interface; the data lives in named volumes,
    // so recreating it loopback-only loses nothing
    log(`[assay] ${SONAR_CONTAINER} is reachable from the network — recreating it on 127.0.0.1 only…\n`);
    await removeServer();
    state = "absent";
  }
  if (state === "running") return;
  if (state === "stopped") {
    log(`[assay] starting existing container ${SONAR_CONTAINER}…\n`);
    const r = await runOnce(`docker start ${SONAR_CONTAINER}`);
    if (r.code !== 0) throw new Error(`docker start failed: ${r.combined.trim().slice(0, 300)}`);
    return;
  }
  log(`[assay] creating ${SONAR_CONTAINER} (${SONAR_IMAGE}) on port ${port}…\n`);
  const cmd = [
    "docker run -d",
    `--name ${SONAR_CONTAINER}`,
    `--network ${SONAR_NETWORK}`,
    // loopback only: admin/admin is live until the first rotation, and nobody else needs it
    `-p 127.0.0.1:${port}:${CONTAINER_PORT}`,
    "-e SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true",
    `-v ${SONAR_CONTAINER}-data:/opt/sonarqube/data`,
    `-v ${SONAR_CONTAINER}-extensions:/opt/sonarqube/extensions`,
    `-v ${SONAR_CONTAINER}-logs:/opt/sonarqube/logs`,
    "--restart unless-stopped",
    SONAR_IMAGE,
  ].join(" ");
  const r = await runOnce(cmd);
  if (r.code !== 0) throw new Error(`docker run failed: ${r.combined.trim().slice(0, 300)}`);
}

export async function stopServer(): Promise<void> {
  await runOnce(`docker stop ${SONAR_CONTAINER}`);
}

/** Remove the container. Named volumes (and therefore the analysis history) stay. */
export async function removeServer(): Promise<void> {
  await runOnce(`docker rm -f ${SONAR_CONTAINER}`);
}

/* -------------------------------- server state ------------------------------- */
export type SystemStatus = "UP" | "STARTING" | "DOWN" | "UNREACHABLE";

export async function systemStatus(host: string): Promise<SystemStatus> {
  try {
    const r = await api<{ status?: string }>(host, "/api/system/status", { soft: true });
    const s = String(r?.status ?? "").toUpperCase();
    if (s === "UP" || s === "STARTING" || s === "DOWN") return s;
    return s ? "DOWN" : "UNREACHABLE";
  } catch {
    return "UNREACHABLE";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll /api/system/status until UP. */
async function waitForUp(host: string, log: Log, timeoutMs = WAIT_UP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    const s = await systemStatus(host);
    if (s === "UP") {
      if (announced) log("[assay] SonarQube is up.\n");
      return;
    }
    if (!announced) {
      log("[assay] waiting for SonarQube to be ready (first boot takes ~1-2 min)…\n");
      announced = true;
    }
    await sleep(3000);
  }
  throw new Error(`SonarQube at ${host} did not become ready in time. Check "docker logs ${SONAR_CONTAINER}".`);
}

/** Public wrapper: poll until the server answers, for UI that starts it by hand. */
export async function waitUntilUp(host: string, timeoutMs = WAIT_UP_TIMEOUT_MS): Promise<void> {
  await waitForUp(host, () => {}, timeoutMs);
}

/* -------------------------------- bootstrap ---------------------------------- */
/**
 * A uniform random index in [0, n): bytes at or above the largest multiple of n are
 * rejected, since `byte % n` would favour the first `256 % n` characters.
 */
export function uniformIndex(n: number, random: () => number = () => crypto.getRandomValues(new Uint8Array(1))[0]): number {
  const limit = 256 - (256 % n);
  for (;;) {
    const b = random();
    if (b < limit) return b % n;
  }
}

/** A password that meets SonarQube's policy (upper, lower, digit, special) by construction. */
function randomPassword(): string {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%*_+-=?"];
  const all = sets.join("");
  const pick = (chars: string, n: number) => Array.from({ length: n }, () => chars[uniformIndex(chars.length)]);
  const out = [...sets.flatMap((set) => pick(set, 2)), ...pick(all, 12)];
  // shuffle so the guaranteed classes aren't all up front
  const order = crypto.getRandomValues(new Uint32Array(out.length));
  return out
    .map((c, i) => ({ c, k: order.at(i) ?? 0 }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.c)
    .join("");
}

/** Does this admin password work? */
async function adminWorks(host: string, pass: string): Promise<boolean> {
  const r = await api<{ valid?: boolean }>(host, "/api/authentication/validate", {
    auth: { user: "admin", pass },
    soft: true,
  });
  return !!r?.valid;
}

/**
 * Find usable admin credentials and mint an analysis token. A fresh container
 * has admin/admin, which is rotated first; a rejected rotation stops the setup.
 */
async function bootstrapCredentials(host: string, log: Log): Promise<string> {
  const stored = (await db.getSetting(ADMIN_PASSWORD_SETTING)) ?? "";
  let password = "";

  if (stored && (await adminWorks(host, stored))) {
    password = stored;
  } else if (await adminWorks(host, "admin")) {
    log("[assay] first run — rotating the default admin password…\n");
    const candidate = randomPassword();
    const res = await apiRaw(host, "/api/users/change_password", {
      method: "POST",
      auth: { user: "admin", pass: "admin" },
      params: { login: "admin", previousPassword: "admin", password: candidate },
    });
    if (res.ok && (await adminWorks(host, candidate))) {
      // store before anything else can fail, so the new password is never lost
      await db.setSetting(ADMIN_PASSWORD_SETTING, candidate);
      password = candidate;
    } else {
      // never carry on with admin/admin: a server anyone on the machine can administer
      const why = str(obj(res.body).result) || errorText(res.body) || `HTTP ${res.status}`;
      log(`[assay] could not rotate the admin password (${why}).\n`);
      throw new Error(
        tr(
          "SonarQube refused to change its default admin password ({why}), so Assay stopped rather than keep admin/admin. Sign in at {host} as admin/admin, set a new password and enter it in Settings › SonarQube — or remove the container there and try again.",
          { why, host },
        ),
      );
    }
  } else {
    throw new Error(
      `The SonarQube admin password is not "admin" and Assay doesn't have it. ` +
        `Enter it in Settings → SonarQube, or remove the container there to start fresh.`,
    );
  }

  log("[assay] generating an analysis token…\n");
  const name = `assay-${Date.now()}`;
  const res = await api<{ token?: string }>(host, "/api/user_tokens/generate", {
    method: "POST",
    auth: { user: "admin", pass: password },
    params: { name },
  });
  if (!res?.token) throw new Error("SonarQube did not return a token.");
  await db.setSetting(TOKEN_SETTING, res.token);
  return res.token;
}

/** Verify a token still works (it can be revoked from Sonar's UI). */
async function tokenValid(host: string, token: string): Promise<boolean> {
  const r = await api<{ valid?: boolean }>(host, "/api/authentication/validate", { auth: { token }, soft: true });
  return !!r?.valid;
}

/**
 * Bring the configured server to a usable state and return {host, token}.
 * Managed mode starts docker and self-provisions credentials; external mode only
 * validates what's in Settings.
 */
export async function ensureServer(log: Log = () => {}): Promise<{ host: string; token: string; managed: boolean }> {
  const cfg = await getSonarConfig();
  if (!cfg.managed) {
    if (!cfg.host) throw new Error("No SonarQube host configured — set it in Settings.");
    if (!cfg.token) throw new Error("No SonarQube token configured — set it in Settings.");
    const s = await systemStatus(cfg.host);
    if (s !== "UP") throw new Error(`SonarQube at ${cfg.host} is ${s.toLowerCase()}.`);
    return { host: cfg.host, token: cfg.token, managed: false };
  }

  await startServer(cfg.port, log);
  await waitForUp(cfg.host, log);
  let token = cfg.token;
  if (!token || !(await tokenValid(cfg.host, token))) token = await bootstrapCredentials(cfg.host, log);
  return { host: cfg.host, token, managed: true };
}

/* --------------------------------- projects ---------------------------------- */
/**
 * Create the Sonar project so it shows up with a readable name. Best-effort: a
 * token without "Create Projects" still scans (the server auto-provisions), and
 * the scanner reports any real error. Returns an error message, or null.
 */
export async function ensureProject(host: string, token: string, key: string, name: string): Promise<string | null> {
  const found = await api<{ components?: { key: string }[] }>(host, "/api/projects/search", {
    auth: { token },
    params: { projects: key },
    soft: true,
  });
  if (found?.components?.some((c) => c.key === key)) return null;
  const created = await api(host, "/api/projects/create", {
    method: "POST",
    auth: { token },
    params: { project: key, name: name.slice(0, 255) },
    soft: true,
  });
  const msg: string = errorText(created);
  if (msg && !/already exists/i.test(msg)) return msg;
  return null;
}

/* ---------------------------------- scanner ---------------------------------- */
const EXCLUSIONS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/target/**",
  "**/vendor/**",
  "**/.git/**",
  "**/*.min.js",
  // build output and tool artifacts — noise, and some of it is unreadable
  // through a Windows bind mount (see JS_EXCLUSIONS below)
  "**/.next/**",
  "**/.nuxt/**",
  "**/.svelte-kit/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/coverage/**",
  "**/.venv/**",
  "**/__pycache__/**",
  "**/.unlighthouse/**",
  "**/strix_runs/**",
].join(",");

/**
 * The JS/TS analyzer walks the project ignoring `sonar.exclusions`, and an
 * unreadable directory on a Windows bind mount kills it with `EINVAL ... readdir`,
 * so the list is repeated on the property that walk does honour.
 */
const JS_EXCLUSIONS = EXCLUSIONS;

export interface ScannerCmdOpts {
  path: string;
  key: string;
  token: string;
  /** Server URL reachable from inside the scanner container. */
  hostForScanner: string;
  /** Container name, so a cancelled run can `docker rm -f` it. */
  containerName: string;
  /** Assay's own container: the scanner joins its docker network (which an external server lacks). */
  managed: boolean;
  /** SonarQube Cloud only; empty everywhere else. */
  organization?: string;
  /** Replace the token with a placeholder (for the stored/displayed command). */
  redact?: boolean;
}

/**
 * The scanner writes its work directory to /tmp inside the container, never into
 * the mounted project — Assay must not dirty the user's working tree (the AI fix
 * loop diffs it).
 */
export function scannerArgs(o: ScannerCmdOpts): string[] {
  // the trailing separators come off in a loop: `/[\\/]+$/` backtracks quadratically
  let path = o.path;
  while (path.endsWith("/") || path.endsWith("\\")) path = path.slice(0, -1);
  return [
    "run",
    "--rm",
    "--name",
    o.containerName,
    ...(o.managed ? ["--network", SONAR_NETWORK] : []),
    "-e",
    `SONAR_HOST_URL=${o.hostForScanner}`,
    "-e",
    `SONAR_TOKEN=${o.redact ? "***" : o.token}`,
    "-v",
    `${path}:/usr/src`,
    SCANNER_IMAGE,
    `-Dsonar.projectKey=${o.key}`,
    "-Dsonar.sources=.",
    `-Dsonar.exclusions=${EXCLUSIONS}`,
    `-Dsonar.javascript.exclusions=${JS_EXCLUSIONS}`,
    "-Dsonar.scm.disabled=true",
    "-Dsonar.working.directory=/tmp/scannerwork",
    ...(o.organization ? [`-Dsonar.organization=${o.organization}`] : []),
  ];
}

/** The program `scannerArgs` belongs to. */
export const SCANNER_PROGRAM = "docker";

/** Human-readable argv for the confirmation and the audit log. Display only: never spawned. */
export function formatCmd(program: string, args: string[]): string {
  return [program, ...args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a))].join(" ");
}

/** Server URL to hand the scanner: the container name on our network, or the external host. */
export function hostForScanner(cfg: { managed: boolean; host: string }): string {
  return cfg.managed ? INTERNAL_HOST : cfg.host;
}

export async function killScanner(containerName: string): Promise<void> {
  await runOnce(`docker rm -f ${containerName}`);
}

/** Remove scanner containers whose run died with the webview (reload, crash, quit). */
export async function killOrphanScanners(): Promise<number> {
  try {
    const r = await runOnce("docker ps -aq --filter name=sechub-scan-");
    const ids = r.stdout.split(/\s+/).filter(Boolean);
    if (ids.length) await runOnce(`docker rm -f ${ids.join(" ")}`);
    return ids.length;
  } catch {
    return 0; // no docker — nothing to clean
  }
}

/* ------------------------------- compute engine ------------------------------- */
/** The scanner prints `.../api/ce/task?id=XXXX` — cheaper than reading .scannerwork. */
export function parseTaskId(log: string): string | null {
  const m = log.match(/api\/ce\/task\?id=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/** Wait for the server to finish computing the analysis it just received. */
export async function waitForTask(host: string, token: string, taskId: string, log: Log, timeoutMs = 600_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  log("[assay] analysis uploaded — waiting for SonarQube to process it…\n");
  while (Date.now() < deadline) {
    const r = await api<{ task?: { status?: string; errorMessage?: string } }>(host, "/api/ce/task", {
      auth: { token },
      params: { id: taskId },
      soft: true,
    });
    const status = String(r?.task?.status ?? "").toUpperCase();
    if (status === "SUCCESS") return;
    if (status === "FAILED" || status === "CANCELED") {
      throw new Error(`SonarQube analysis ${status.toLowerCase()}: ${r?.task?.errorMessage ?? "no details"}`);
    }
    await sleep(2000);
  }
  throw new Error("Timed out waiting for SonarQube to process the analysis.");
}

/* --------------------------------- collection --------------------------------- */
export interface SonarPayload {
  key: string;
  host: string;
  issues: unknown[];
  hotspots: unknown[];
  qualityGate: unknown;
  measures: Record<string, string>;
  /** ruleKey → { name, help } used as the remediation hint for the AI fix. */
  rules: Record<string, { name?: string; help?: string }>;
}

const PAGE = 500;

/** Page through a Sonar search endpoint (they cap at 500 per page / 10k total). */
async function pageAll(host: string, token: string, path: string, params: Record<string, string | number>, field: string, max = 2000): Promise<unknown[]> {
  const out: unknown[] = [];
  let p = 1;
  while (out.length < max) {
    const r = obj(await api<Json>(host, path, { auth: { token }, params: { ...params, ps: PAGE, p }, soft: true }));
    // `field` is a value, so the page is read out of an own-key Map
    const batch = list(new Map(Object.entries(r)).get(field));
    out.push(...batch);
    const reported = obj(r.paging).total ?? r.total;
    const total: number = typeof reported === "number" ? reported : out.length;
    if (batch.length < PAGE || out.length >= total) break;
    p++;
  }
  return out.slice(0, max);
}

/** `componentKeys` was renamed to `components`; try the current name first. */
async function searchIssues(host: string, token: string, key: string): Promise<unknown[]> {
  try {
    const r = await pageAll(host, token, "/api/issues/search", { components: key, resolved: "false" }, "issues");
    if (r.length) return r;
  } catch {
    /* fall through to the legacy param */
  }
  return pageAll(host, token, "/api/issues/search", { componentKeys: key, resolved: "false" }, "issues");
}

const MEASURE_KEYS = [
  "coverage",
  "duplicated_lines_density",
  "sqale_index",
  "ncloc",
  "bugs",
  "vulnerabilities",
  "code_smells",
  "security_hotspots",
].join(",");

function stripHtml(html: string): string {
  return html
    // unrolled rather than `[\s\S]*?`, which backtracks quadratically
    .replace(/<pre(?:[^<]|<(?!\/pre>))*<\/pre>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "How to fix" text for a rule, cached per session (one call per unique rule). */
const ruleCache = new Map<string, { name?: string; help?: string }>();

async function fetchRule(host: string, token: string, ruleKey: string): Promise<{ name?: string; help?: string }> {
  const hit = ruleCache.get(ruleKey);
  if (hit) return hit;
  let value: { name?: string; help?: string } = {};
  try {
    const r = await api<Json>(host, "/api/rules/show", { auth: { token }, params: { key: ruleKey }, soft: true });
    const rule = obj(r).rule;
    if (rule) {
      const sections = list(obj(rule).descriptionSections);
      const how =
        obj(sections.find((s) => obj(s).key === "how_to_fix")).content ??
        obj(sections.find((s) => obj(s).key === "root_cause")).content;
      value = { name: str(obj(rule).name), help: stripHtml(String(how ?? obj(rule).htmlDesc ?? "")).slice(0, 700) };
    }
  } catch {
    /* rule help is a nice-to-have */
  }
  ruleCache.set(ruleKey, value);
  return value;
}

/** Everything Assay shows for one analysis: issues, hotspots, gate, measures, rule help. */
export async function collect(host: string, token: string, key: string): Promise<SonarPayload> {
  const [issues, hotspots, gate, measures] = await Promise.all([
    searchIssues(host, token, key),
    pageAll(host, token, "/api/hotspots/search", { projectKey: key }, "hotspots"),
    api<Json>(host, "/api/qualitygates/project_status", { auth: { token }, params: { projectKey: key }, soft: true }),
    api<Json>(host, "/api/measures/component", { auth: { token }, params: { component: key, metricKeys: MEASURE_KEYS }, soft: true }),
  ]);

  const ruleKeys = new Set<string>();
  for (const i of issues) {
    const rule = obj(i).rule;
    if (rule) ruleKeys.add(String(rule));
  }
  const uniqueRules = [...ruleKeys].slice(0, 60);
  // collected as entries and turned into the record once: no keyed writes
  const ruleEntries = await Promise.all(
    uniqueRules.map(async (r) => [r, await fetchRule(host, token, r)] as const),
  );
  const rules: Record<string, { name?: string; help?: string }> = Object.fromEntries(ruleEntries);

  const byMetric = new Map<string, string>();
  for (const m of list(obj(obj(measures).component).measures)) {
    const measure = obj(m);
    const value = measure.value ?? obj(list(measure.periods)[0]).value ?? "";
    byMetric.set(String(measure.metric), String(value));
  }
  const measureMap: Record<string, string> = Object.fromEntries(byMetric);

  return { key, host, issues, hotspots, qualityGate: obj(gate).projectStatus ?? null, measures: measureMap, rules };
}

/** Deep link to the project dashboard, for the run log. */
export function dashboardUrl(host: string, key: string): string {
  return `${host}/dashboard?id=${encodeURIComponent(key)}`;
}
