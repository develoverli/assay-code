import Database from "@tauri-apps/plugin-sql";
import type {
  DeployServer,
  Edit,
  Finding,
  Project,
  Tag,
  TagColor,
  RawFinding,
  Run,
  Severity,
  Tool,
  ToolConfig,
  FindingStatus,
} from "@/types";
import { now, uid } from "@/lib/utils";

let _db: Database | null = null;

const DB_FILE = "assay.db";

async function getDb(): Promise<Database> {
  if (!_db) _db = await Database.load(`sqlite:${DB_FILE}`);
  return _db;
}

const b = (v: unknown) => (v ? 1 : 0);
const jarr = (v: unknown): string[] => {
  try {
    const p = JSON.parse(String(v ?? "[]"));
    return Array.isArray(p) ? p.map(String) : [];
  } catch {
    return [];
  }
};

/* ---------------------------------- mappers --------------------------------- */
/** One row as SQLite hands it back: its columns are unknown until they are read. */
type Row = Record<string, unknown>;

function mapProject(r: Row): Project {
  return {
    ...r,
    stack: jarr(r.stack),
    authorized: !!r.authorized,
    github_private: r.github_private == null ? null : !!r.github_private,
    tags: [],
  } as unknown as Project;
}

function mapTag(r: Row): Tag {
  return { ...r, color: String(r.color ?? "slate") } as unknown as Tag;
}

/** Hang each project's tag ids on it, with one query for the whole list. */
async function withTags(rows: Row[]): Promise<Project[]> {
  const projects = rows.map(mapProject);
  if (!projects.length) return projects;
  const db = await getDb();
  const links = await db.select<Row[]>("SELECT project_id, tag_id FROM project_tags");
  const byProject = new Map<string, string[]>();
  for (const l of links) {
    const key = String(l.project_id);
    const list = byProject.get(key);
    if (list) list.push(String(l.tag_id));
    else byProject.set(key, [String(l.tag_id)]);
  }
  for (const p of projects) p.tags = byProject.get(p.id) ?? [];
  return projects;
}

/** Stored tool options; anything unparseable falls back to the schema defaults. */
const jcfg = (v: unknown): ToolConfig | null => {
  if (v == null) return null;
  try {
    const p: unknown = JSON.parse(String(v));
    return p && typeof p === "object" && !Array.isArray(p) ? (p as ToolConfig) : null;
  } catch {
    return null;
  }
};

function mapTool(r: Row): Tool {
  return {
    ...r,
    stack: jarr(r.stack),
    config: jcfg(r.config),
    builtin: !!r.builtin,
    enabled: !!r.enabled,
  } as unknown as Tool;
}

function mapFinding(r: Row): Finding {
  return { ...r, fixed: !!r.fixed, status: (r.status as FindingStatus) ?? "open" } as unknown as Finding;
}

/**
 * The identity of a finding across scans: tool, rule, file and digit-normalised
 * message. The line is left out so a dismissed finding survives code moving.
 */
function fingerprintOf(toolId: string | null, f: RawFinding): string {
  const message = String(f.message ?? "")
    .replace(/\d+/g, "#")
    .slice(0, 160);
  return [toolId ?? "", f.category ?? "", f.file ?? "", message].join("|");
}

/* --------------------------------- projects --------------------------------- */
export async function listProjects(): Promise<Project[]> {
  const db = await getDb();
  // most recently worked on first; the never-used ones after, newest added
  // first — the same rule `sortByLastUse` applies in memory when a use lands
  const rows = await db.select<Row[]>(
    `SELECT * FROM projects WHERE deleted_at IS NULL
     ORDER BY last_used_at IS NULL, last_used_at DESC, created_at DESC`,
  );
  return withTags(rows);
}

/** Record real work on a project. Not an edit, so updated_at stays where it is. */
export async function touchProject(id: string, at: number): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE projects SET last_used_at=$2 WHERE id=$1", [id, at]);
}

/** Every project ever, retired ones included — for Stats and Audit. */
export async function listAllProjects(): Promise<Project[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>(
    "SELECT * FROM projects ORDER BY last_used_at IS NULL, last_used_at DESC, created_at DESC",
  );
  return rows.map(mapProject);
}

async function getProject(id: string): Promise<Project | null> {
  const db = await getDb();
  const rows = await db.select<Row[]>("SELECT * FROM projects WHERE id = $1", [id]);
  return rows[0] ? mapProject(rows[0]) : null;
}

export async function createProject(
  p: Pick<Project, "name" | "path" | "url" | "stack" | "authorized"> &
    Pick<Partial<Project>, "github_repo" | "github_private">,
): Promise<Project> {
  const db = await getDb();
  const t = now();
  const row: Project = { id: uid("prj_"), created_at: t, updated_at: t, tags: [], ...p };
  await db.execute(
    `INSERT INTO projects (id,name,path,url,stack,authorized,created_at,updated_at,github_repo,github_private)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      row.id,
      row.name,
      row.path ?? null,
      row.url ?? null,
      JSON.stringify(row.stack),
      b(row.authorized),
      t,
      t,
      row.github_repo ?? null,
      row.github_private == null ? null : b(row.github_private),
    ],
  );
  return row;
}

/**
 * Bring each cloned project's visibility in line with what GitHub just listed.
 * Only rows whose answer changed are written, so a listing that changed nothing
 * costs no writes. Returns how many rows moved.
 */
export async function syncGithubVisibility(repos: { fullName: string; private: boolean }[]): Promise<number> {
  const db = await getDb();
  let changed = 0;
  for (const r of repos) {
    const res = await db.execute(
      `UPDATE projects SET github_private=$2
       WHERE github_repo=$1 AND (github_private IS NULL OR github_private<>$2)`,
      [r.fullName, b(r.private)],
    );
    changed += res.rowsAffected;
  }
  return changed;
}

export async function updateProject(id: string, patch: Partial<Project>): Promise<void> {
  const [db, cur] = await Promise.all([getDb(), getProject(id)]);
  if (!cur) return;
  const next = { ...cur, ...patch, updated_at: now() };
  await db.execute(
    `UPDATE projects SET name=$2,path=$3,url=$4,stack=$5,authorized=$6,updated_at=$7,commit_style=$8,commit_prompt=$9
     WHERE id=$1`,
    [
      id,
      next.name,
      next.path ?? null,
      next.url ?? null,
      JSON.stringify(next.stack),
      b(next.authorized),
      next.updated_at,
      next.commit_style ?? null,
      next.commit_prompt ?? null,
    ],
  );
}

/** Retire a project: it leaves the working views, but its runs, findings and edits stay for Stats and Audit. */
export async function deleteProject(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE projects SET deleted_at=$2, updated_at=$2 WHERE id=$1", [id, now()]);
}

/**
 * Reset the checks: Findings starts empty again. Only moves a marker, so Audit
 * keeps every run and Stats keeps the whole evolution.
 */
export async function clearProjectChecks(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE projects SET cleared_at=$2, updated_at=$2 WHERE id=$1", [id, now()]);
}

const SHIP_PROMPT = [
  "The user explicitly authorizes this commit.",
  "Stage ALL changes in the project (git add -A) and create ONE git commit.",
  "Commit message MUST be gitmoji + Conventional Commits, subject line ONLY, in English",
  '(e.g. "✨ feat(auth): add login" or "🐛 fix: correct token expiry").',
  "Infer the type, optional scope and summary from the actual diff.",
].join(" ");

/** SHA-256 of the ship prompt earlier versions seeded: replaced only while the user left it untouched. */
const OLD_SHIP_PROMPT_SHA256 = "e4c0954560a98396ad5163b0e4a512aba405ca3387e6651c26af4e878b3724e5";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Built-ins that were dropped: their seeded rows are deleted and their tombstones forgotten. */
const RETIRED_BUILTINS = ["sane-stack"];

/**
 * Every built-in, shared by seeding and restoring. The scanners from migrations
 * 001/002 are repeated here because a restore cannot re-run a migration.
 */
const BUILTINS: { id: string; sql: string; args: unknown[] }[] = [
  {
    id: "react-doctor",
    sql: `INSERT OR IGNORE INTO tools (id,name,source,kind,scope,stack,cmd,adapter,builtin,enabled,notes,created_at,updated_at)
      VALUES ('react-doctor','React Doctor','tool','npx','local','["react"]','npx -y react-doctor@latest --json','react-doctor',1,1,$1,$2,$2)`,
    args: ["React anti-patterns, perf, a11y, security (SAST). Runs in project folder."],
  },
  {
    id: "unlighthouse",
    sql: `INSERT OR IGNORE INTO tools (id,name,source,kind,scope,stack,cmd,adapter,builtin,enabled,notes,created_at,updated_at)
      VALUES ('unlighthouse','Unlighthouse','tool','npx','url','[]','npx -y @unlighthouse/cli ci --site {url} --reporter jsonExpanded --output-path .unlighthouse','unlighthouse',1,1,$1,$2,$2)`,
    args: ["Whole-site Lighthouse: perf / SEO / a11y. Needs a reachable URL."],
  },
  {
    id: "strix",
    sql: `INSERT OR IGNORE INTO tools (id,name,source,kind,scope,stack,cmd,adapter,builtin,enabled,notes,created_at,updated_at)
      VALUES ('strix','Strix','tool','cli','url','[]','strix -n --scan-mode {depth} --target {url}','strix',1,1,$1,$2,$2)`,
    args: [
      "AI pentest agent (non-interactive). Scan depth is set in Settings. Runs in-app; findings feed the fix loop. Needs strix + docker + LLM key. Use a frontier model to avoid loops/hangs.",
    ],
  },
  {
    id: "sonarqube",
    sql: `INSERT OR IGNORE INTO tools (id,name,source,kind,scope,stack,cmd,adapter,builtin,enabled,notes,created_at,updated_at)
      VALUES ('sonarqube','SonarQube','tool','docker','local','[]',
        'docker run --rm --network sechub-sonar -e SONAR_HOST_URL=<sonar> -e SONAR_TOKEN=*** -v "{path}:/usr/src" sonarsource/sonar-scanner-cli -Dsonar.projectKey=sechub-<project>',
        'sonarqube',1,1,$1,$2,$2)`,
    args: [
      "Bugs, code smells, vulnerabilities and security hotspots across 21 languages. Assay runs the SonarQube Community Build container for you (Docker required).",
    ],
  },
  {
    id: "eslint",
    sql: `INSERT OR IGNORE INTO tools (id,name,source,kind,scope,stack,cmd,adapter,builtin,enabled,notes,created_at,updated_at)
      VALUES ('eslint','ESLint','tool','cli','local','["node","typescript","react"]','eslint {path} --format json','eslint',1,1,$1,$2,$2)`,
    args: [
      "JavaScript / TypeScript lint with Assay's own ESLint install — the project's config is never read or written. Pick the rule groups with Configure.",
    ],
  },
  {
    id: "ruff",
    sql: `INSERT OR IGNORE INTO tools (id,name,source,kind,scope,stack,cmd,adapter,builtin,enabled,notes,created_at,updated_at)
      VALUES ('ruff','Ruff','tool','cli','local','["python"]','ruff check {path} --output-format json','ruff',1,1,$1,$2,$2)`,
    args: [
      "Python lint (Ruff): pyflakes, pycodestyle, bugbear, the Pylint checks and bandit security rules. No Python install needed — Assay fetches the binary.",
    ],
  },
  {
    id: "gitleaks",
    sql: `INSERT OR IGNORE INTO tools (id,name,source,kind,scope,stack,cmd,adapter,builtin,enabled,notes,created_at,updated_at)
      VALUES ('gitleaks','Gitleaks','tool','cli','local','[]','gitleaks detect --no-git --redact','gitleaks',1,1,$1,$2,$2)`,
    args: [
      "Hardcoded secrets: API keys, tokens, private keys. Runs redacted — Assay records the rule and the location, never the secret.",
    ],
  },
  {
    id: "osv-scanner",
    sql: `INSERT OR IGNORE INTO tools (id,name,source,kind,scope,stack,cmd,adapter,builtin,enabled,notes,created_at,updated_at)
      VALUES ('osv-scanner','OSV Scanner','tool','cli','local','[]','osv-scanner --format json --recursive {path}','osv-scanner',1,1,$1,$2,$2)`,
    args: [
      "Known vulnerabilities in your dependencies (npm, pip, cargo, go, maven…) from the OSV database. Needs the osv-scanner binary on PATH.",
    ],
  },
  {
    id: "semgrep",
    sql: `INSERT OR IGNORE INTO tools (id,name,source,kind,scope,stack,cmd,adapter,builtin,enabled,notes,created_at,updated_at)
      VALUES ('semgrep','Semgrep','tool','cli','local','[]','semgrep scan --json --quiet','semgrep',1,1,$1,$2,$2)`,
    args: [
      "Multi-language static analysis. Pick the rule packs with Configure; they are fetched by semgrep itself.",
    ],
  },
  {
    id: "graphify",
    sql: `INSERT OR IGNORE INTO tools (id,name,source,kind,scope,stack,cmd,adapter,builtin,enabled,notes,created_at,updated_at)
      VALUES ('graphify','Graphify','tool','cli','local','[]','graphify extract {path} --code-only','graphify',1,1,$1,$2,$2)`,
    args: [
      "Knowledge graph of the project (graphify-out/): nodes, edges and a report an agent can query instead of reading the whole repo. Build it once, then Update after changes. Code-only by default — local AST, no API key, no network, nothing to confirm mid-run.",
    ],
  },
  {
    id: "ship",
    sql: `INSERT OR IGNORE INTO tools (id,name,source,kind,scope,stack,cmd,adapter,prompt,builtin,enabled,notes,created_at,updated_at)
      VALUES ('ship','Ship','command','cli-agent','local','[]','','generic',$1,1,1,$2,$3,$3)`,
    args: [SHIP_PROMPT, "Stage changes and create a gitmoji Conventional Commit. Optionally push."],
  },
];

/** Ids of built-ins the user deleted, which seeding must not bring back. */
export async function deletedBuiltins(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ id: string }[]>("SELECT id FROM deleted_builtins");
  // a retired built-in can never be restored, so it is not counted as deleted either
  const known = new Set(BUILTINS.map((b) => b.id));
  return rows.map((r) => r.id).filter((id) => known.has(id));
}

/** Seed built-in tools (idempotent). Runs on init instead of a migration. */
export async function seedBuiltins(): Promise<void> {
  const db = await getDb();
  const t = now();
  const gone = new Set(await deletedBuiltins());
  for (const b of BUILTINS) {
    if (gone.has(b.id)) continue;
    await db.execute(b.sql, [...b.args, t]);
  }
  // user copies (builtin=0) of a retired built-in stay; only the seeded row goes
  for (const id of RETIRED_BUILTINS) {
    await db.execute("DELETE FROM tools WHERE id=$1 AND builtin=1", [id]);
    await db.execute("DELETE FROM deleted_builtins WHERE id=$1", [id]);
  }
  // INSERT OR IGNORE never refreshes the ship prompt; an edited one is left alone
  const ship = await db.select<{ prompt: string | null }[]>("SELECT prompt FROM tools WHERE id='ship'");
  const shipPrompt = ship[0]?.prompt;
  if (shipPrompt && (await sha256Hex(shipPrompt)) === OLD_SHIP_PROMPT_SHA256) {
    await db.execute("UPDATE tools SET prompt=$1, updated_at=$2 WHERE id='ship'", [SHIP_PROMPT, t]);
  }
  // move strix rows from the old interactive default to the in-app command; user edits are kept
  await db.execute(
    `UPDATE tools SET cmd='strix -n --scan-mode {depth} --target {url}',
       notes='AI pentest agent (non-interactive). Scan depth is set in Settings. Runs in-app; findings feed the fix loop. Needs strix + docker + LLM key. Use a frontier model to avoid loops/hangs.'
     WHERE id='strix' AND cmd NOT LIKE '%{depth}%'`,
  );
}

/* ------------------------------------ tags ---------------------------------- */
export async function listTags(): Promise<Tag[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>("SELECT * FROM tags ORDER BY name COLLATE NOCASE ASC");
  return rows.map(mapTag);
}

export async function createTag(name: string, color: TagColor): Promise<Tag> {
  const db = await getDb();
  const t = now();
  const row: Tag = { id: uid("tag_"), name, color, created_at: t, updated_at: t };
  await db.execute(
    "INSERT INTO tags (id,name,color,created_at,updated_at) VALUES ($1,$2,$3,$4,$4)",
    [row.id, row.name, row.color, t],
  );
  return row;
}

export async function updateTag(id: string, patch: { name?: string; color?: TagColor }): Promise<void> {
  const db = await getDb();
  const rows = await db.select<Row[]>("SELECT * FROM tags WHERE id=$1", [id]);
  if (!rows[0]) return;
  const cur = mapTag(rows[0]);
  await db.execute("UPDATE tags SET name=$2, color=$3, updated_at=$4 WHERE id=$1", [
    id,
    patch.name ?? cur.name,
    patch.color ?? cur.color,
    now(),
  ]);
}

/**
 * Delete a tag and its assignments; projects are untouched. Join rows are removed
 * explicitly because SQLite only enforces foreign keys when asked to.
 */
export async function deleteTag(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM project_tags WHERE tag_id=$1", [id]);
  await db.execute("DELETE FROM tags WHERE id=$1", [id]);
}

/** Replace a project's tags with exactly this set. */
export async function setProjectTags(projectId: string, tagIds: string[]): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM project_tags WHERE project_id=$1", [projectId]);
  for (const tagId of tagIds) {
    await db.execute(
      "INSERT OR IGNORE INTO project_tags (project_id, tag_id) VALUES ($1,$2)",
      [projectId, tagId],
    );
  }
}

/* ----------------------------------- tools ---------------------------------- */
export async function listTools(): Promise<Tool[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>("SELECT * FROM tools ORDER BY builtin DESC, name ASC");
  return rows.map(mapTool);
}

export async function createTool(
  t: Partial<Tool> & Pick<Tool, "name" | "kind" | "scope">,
): Promise<Tool> {
  const db = await getDb();
  const ts = now();
  const row: Tool = {
    id: t.id ?? uid("tool_"),
    name: t.name,
    source: t.source ?? "tool",
    kind: t.kind,
    scope: t.scope,
    stack: t.stack ?? [],
    cmd: t.cmd ?? "",
    adapter: t.adapter ?? "generic",
    prompt: t.prompt ?? null,
    config: t.config ?? null,
    builtin: false,
    enabled: t.enabled ?? true,
    notes: t.notes ?? null,
    created_at: ts,
    updated_at: ts,
  };
  await db.execute(
    `INSERT INTO tools (id,name,source,kind,scope,stack,cmd,adapter,prompt,config,builtin,enabled,notes,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [row.id, row.name, row.source, row.kind, row.scope, JSON.stringify(row.stack), row.cmd, row.adapter, row.prompt, row.config ? JSON.stringify(row.config) : null, b(row.builtin), b(row.enabled), row.notes, ts, ts],
  );
  return row;
}

export async function updateTool(id: string, patch: Partial<Tool>): Promise<void> {
  const db = await getDb();
  const rows = await db.select<Row[]>("SELECT * FROM tools WHERE id=$1", [id]);
  if (!rows[0]) return;
  const next = { ...mapTool(rows[0]), ...patch, updated_at: now() };
  await db.execute(
    `UPDATE tools SET name=$2,source=$3,kind=$4,scope=$5,stack=$6,cmd=$7,adapter=$8,prompt=$9,config=$10,enabled=$11,notes=$12,updated_at=$13 WHERE id=$1`,
    [id, next.name, next.source, next.kind, next.scope, JSON.stringify(next.stack), next.cmd, next.adapter, next.prompt ?? null, next.config ? JSON.stringify(next.config) : null, b(next.enabled), next.notes ?? null, next.updated_at],
  );
}

/**
 * Removes a tool from Assay; nothing on disk is touched. Deleting a built-in
 * leaves a tombstone so seeding does not resurrect it (see `restoreBuiltins`).
 */
export async function deleteTool(id: string): Promise<void> {
  const db = await getDb();
  const rows = await db.select<{ builtin: number }[]>("SELECT builtin FROM tools WHERE id=$1", [id]);
  const wasBuiltin = !!rows[0]?.builtin;
  await db.execute("DELETE FROM tools WHERE id=$1", [id]);
  if (wasBuiltin) {
    await db.execute("INSERT OR REPLACE INTO deleted_builtins (id,deleted_at) VALUES ($1,$2)", [id, now()]);
  }
}

/** Clears every tombstone and re-seeds. Returns how many built-ins came back. */
export async function restoreBuiltins(): Promise<number> {
  const [db, gone] = await Promise.all([getDb(), deletedBuiltins()]);
  if (!gone.length) return 0;
  await db.execute("DELETE FROM deleted_builtins");
  await seedBuiltins();
  return gone.length;
}

/* ----------------------------------- runs ----------------------------------- */
export async function createRun(r: Omit<Run, "log" | "status"> & Partial<Pick<Run, "log" | "status">>): Promise<Run> {
  const db = await getDb();
  const row: Run = { log: "", status: "running", ...r } as Run;
  await db.execute(
    `INSERT INTO runs (id,project_id,tool_id,tool_name,kind,provider,cmd,status,log,started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [row.id, row.project_id, row.tool_id ?? null, row.tool_name, row.kind, row.provider ?? null, row.cmd, row.status, row.log, row.started_at],
  );
  return row;
}

export async function finishRun(
  id: string,
  patch: Partial<Pick<Run, "status" | "exit_code" | "log" | "summary" | "finished_at" | "duration_ms">>,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE runs SET status=COALESCE($2,status), exit_code=$3, log=COALESCE($4,log),
       summary=COALESCE($5,summary), finished_at=$6, duration_ms=$7 WHERE id=$1`,
    [id, patch.status ?? null, patch.exit_code ?? null, patch.log ?? null, patch.summary ?? null, patch.finished_at ?? null, patch.duration_ms ?? null],
  );
}

export async function appendRunLog(id: string, log: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE runs SET log=$2 WHERE id=$1", [id, log]);
}

/** Mark any run still 'running' as cancelled — its process died on reload/exit. */
export async function markInterruptedRuns(): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE runs SET status='cancelled', finished_at=$1, summary=COALESCE(summary,'interrupted') WHERE status='running'",
    [now()],
  );
}

export async function listRuns(projectId?: string, limit = 200): Promise<Run[]> {
  const db = await getDb();
  const rows = projectId
    ? await db.select<Run[]>("SELECT * FROM runs WHERE project_id=$1 ORDER BY started_at DESC LIMIT $2", [projectId, limit])
    : await db.select<Run[]>("SELECT * FROM runs ORDER BY started_at DESC LIMIT $1", [limit]);
  return rows;
}

export async function getRun(id: string): Promise<Run | null> {
  const db = await getDb();
  const rows = await db.select<Run[]>("SELECT * FROM runs WHERE id=$1", [id]);
  return rows[0] ?? null;
}

/* --------------------------------- findings --------------------------------- */
const oneLine = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();

/**
 * The single gate every finding passes before it is stored. The message is
 * mandatory (falls back to the category, else the finding is dropped), the path
 * is slash-separated, and a line is kept only when positive and attached to a file.
 */
function normalizeFinding(f: RawFinding): RawFinding | null {
  const category = oneLine(f.category) || undefined;
  const message = (oneLine(f.message) || category || "").slice(0, 2000);
  if (!message) return null;
  const file = oneLine(f.file).replace(/\\/g, "/").replace(/^\.\//, "") || undefined;
  const rawLine = typeof f.line === "number" && Number.isFinite(f.line) ? Math.floor(f.line) : 0;
  return {
    ...f,
    category,
    message,
    file,
    // a line without a file points nowhere
    line: file && rawLine > 0 ? rawLine : undefined,
  };
}

interface Decision {
  status: FindingStatus;
  reason: string | null;
  at: number | null;
}

/** The triage decisions already recorded for this project, by fingerprint. */
async function decisionsFor(projectId: string): Promise<Map<string, Decision>> {
  const db = await getDb();
  const rows = await db.select<
    { fingerprint: string; status: FindingStatus; status_reason: string | null; status_at: number | null }[]
  >(
    `SELECT fingerprint, status, status_reason, status_at FROM findings
      WHERE project_id=$1 AND status!='open' AND fingerprint IS NOT NULL
      ORDER BY status_at ASC`,
    [projectId],
  );
  const map = new Map<string, Decision>();
  for (const r of rows) {
    map.set(String(r.fingerprint), {
      status: r.status,
      reason: r.status_reason ?? null,
      at: r.status_at ?? null,
    });
  }
  return map;
}

/**
 * Inserts the findings that pass `normalizeFinding`, carrying over whatever the
 * user already decided about the same problem in an earlier scan. Returns how
 * many were stored.
 */
export async function insertFindings(
  runId: string,
  projectId: string,
  toolId: string | null,
  items: RawFinding[],
): Promise<number> {
  const db = await getDb();
  const t = now();
  const rows = items.map(normalizeFinding).filter((f): f is RawFinding => f !== null);
  if (rows.length !== items.length) {
    console.warn(`[assay] dropped ${items.length - rows.length} empty finding(s) from ${toolId ?? "run"} ${runId}`);
  }
  const decided = await decisionsFor(projectId);
  for (const f of rows) {
    const fingerprint = fingerprintOf(toolId, f);
    const prior = decided.get(fingerprint);
    await db.execute(
      `INSERT INTO findings (id,run_id,project_id,tool_id,severity,category,file,line,message,raw,fixed,status,status_reason,status_at,fingerprint,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13,$14,$15)`,
      [
        uid("f_"),
        runId,
        projectId,
        toolId,
        f.severity,
        f.category ?? null,
        f.file ?? null,
        f.line ?? null,
        f.message,
        f.raw != null ? JSON.stringify(f.raw) : null,
        prior?.status ?? "open",
        prior?.reason ?? null,
        prior?.at ?? null,
        fingerprint,
        t,
      ],
    );
  }
  return rows.length;
}

/** Record a decision about a finding, for every copy of it in this project, past snapshots included. */
export async function setFindingStatus(
  projectId: string,
  fingerprint: string,
  status: FindingStatus,
  reason: string | null,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE findings SET status=$3, status_reason=$4, status_at=$5
      WHERE project_id=$1 AND fingerprint=$2`,
    [projectId, fingerprint, status, status === "open" ? null : reason, status === "open" ? null : now()],
  );
}

/** What changed between the two most recent scans of each tool. */
export interface ScanDelta {
  added: Finding[];
  resolved: Finding[];
  kept: number;
}

/** One tool's two most recent runs, compared by fingerprint. */
function diffRuns(
  now_: Record<string, unknown>[],
  before: Record<string, unknown>[],
): ScanDelta {
  const keyOf = (f: Record<string, unknown>) => String(f.fingerprint ?? f.message);
  const beforeKeys = new Set(before.map(keyOf));
  const nowKeys = new Set(now_.map(keyOf));
  const added: Finding[] = [];
  const resolved: Finding[] = [];
  let kept = 0;
  for (const f of now_) {
    if (beforeKeys.has(keyOf(f))) kept += 1;
    else added.push(mapFinding(f));
  }
  for (const f of before) {
    if (!nowKeys.has(keyOf(f))) resolved.push(mapFinding(f));
  }
  return { added, resolved, kept };
}

/**
 * New, gone and unchanged since the previous scan, per tool and by fingerprint:
 * a tool that didn't run again can't make its findings look resolved.
 */
export async function scanDelta(projectId: string): Promise<ScanDelta> {
  const db = await getDb();
  const runs = await db.select<{ id: string; tool_id: string | null; started_at: number }[]>(
    `SELECT id, tool_id, started_at FROM runs
      WHERE project_id=$1 AND kind='scan' AND status!='cancelled'
        AND started_at > IFNULL((SELECT cleared_at FROM projects WHERE id=$1), 0)
      ORDER BY started_at DESC`,
    [projectId],
  );
  const latest = new Map<string, string>();
  const previous = new Map<string, string>();
  for (const r of runs) {
    const key = String(r.tool_id ?? "");
    if (!latest.has(key)) latest.set(key, r.id);
    else if (!previous.has(key)) previous.set(key, r.id);
  }
  // only tools that ran twice can say anything about what changed
  const pairs = [...latest.entries()].filter(([tool]) => previous.has(tool));
  const added: Finding[] = [];
  const resolved: Finding[] = [];
  let kept = 0;

  for (const [tool, latestRun] of pairs) {
    const previousRun = previous.get(tool)!;
    const [now_, before] = await Promise.all([
      db.select<Row[]>("SELECT * FROM findings WHERE run_id=$1", [latestRun]),
      db.select<Row[]>("SELECT * FROM findings WHERE run_id=$1", [previousRun]),
    ]);
    const diff = diffRuns(now_, before);
    added.push(...diff.added);
    resolved.push(...diff.resolved);
    kept += diff.kept;
  }
  return { added, resolved, kept };
}

/** Delete runs (and their findings and edits) older than `days`. Only ever run on request. */
export async function purgeHistory(days: number): Promise<number> {
  const db = await getDb();
  const cutoff = now() - days * 24 * 60 * 60 * 1000;

  // keep the newest scan of each tool: it is what Findings shows right now
  const keep = await db.select<{ id: string }[]>(
    `SELECT r.id FROM runs r
       JOIN (SELECT project_id, IFNULL(tool_id,'') AS tid, MAX(started_at) AS mx
               FROM runs WHERE kind='scan' AND status!='cancelled'
              GROUP BY project_id, IFNULL(tool_id,'')) g
         ON g.project_id = r.project_id AND g.tid = IFNULL(r.tool_id,'') AND g.mx = r.started_at`,
  );
  const keepIds = keep.map((r) => r.id);
  const ph = keepIds.map((_, i) => `$${i + 2}`).join(",");
  const guard = keepIds.length ? ` AND id NOT IN (${ph})` : "";
  const args = [cutoff, ...keepIds];

  const doomed = await db.select<{ id: string }[]>(
    `SELECT id FROM runs WHERE started_at < $1${guard}`,
    args,
  );
  if (!doomed.length) return 0;
  const inDoomed = `(SELECT id FROM runs WHERE started_at < $1${guard})`;
  await db.execute(`DELETE FROM findings WHERE run_id IN ${inDoomed}`, args);
  await db.execute(`DELETE FROM edits WHERE run_id IN ${inDoomed}`, args);
  await db.execute(`DELETE FROM runs WHERE started_at < $1${guard}`, args);
  return doomed.length;
}

export async function listFindings(opts: {
  projectId?: string;
  runId?: string;
  toolId?: string;
  severity?: Severity;
}): Promise<Finding[]> {
  const db = await getDb();
  const where: string[] = [];
  const args: string[] = [];
  if (opts.projectId) { args.push(opts.projectId); where.push(`project_id=$${args.length}`); }
  if (opts.runId) { args.push(opts.runId); where.push(`run_id=$${args.length}`); }
  if (opts.toolId) { args.push(opts.toolId); where.push(`tool_id=$${args.length}`); }
  if (opts.severity) { args.push(opts.severity); where.push(`severity=$${args.length}`); }
  const sql = `SELECT * FROM findings ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC`;
  const rows = await db.select<Row[]>(sql, args);
  return rows.map(mapFinding);
}

/** The most recent scan run per tool for a project (each is a snapshot). */
export async function latestScanRuns(projectId: string): Promise<Run[]> {
  const db = await getDb();
  const rows = await db.select<Run[]>(
    `SELECT r.* FROM runs r
     JOIN (SELECT tool_id, MAX(started_at) AS mx FROM runs
           WHERE project_id=$1 AND kind='scan' AND status!='cancelled'
             AND started_at > IFNULL((SELECT cleared_at FROM projects WHERE id=$1), 0)
           GROUP BY tool_id) g
       ON IFNULL(r.tool_id,'')=IFNULL(g.tool_id,'') AND r.started_at=g.mx
     WHERE r.project_id=$1 AND r.kind='scan'`,
    [projectId],
  );
  return rows;
}

/** Current findings = those from the latest scan snapshot of each tool. */
export async function currentFindings(projectId: string): Promise<Finding[]> {
  const runs = await latestScanRuns(projectId);
  const ids = runs.map((r) => r.id);
  if (!ids.length) return [];
  const db = await getDb();
  const ph = ids.map((_, i) => `$${i + 1}`).join(",");
  const rows = await db.select<Row[]>(
    `SELECT * FROM findings WHERE run_id IN (${ph}) ORDER BY created_at DESC`,
    ids,
  );
  return rows.map(mapFinding);
}

/** `currentFindings` for every project at once (counting `findings` raw would sum every snapshot). */
export async function currentFindingsAll(): Promise<Finding[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>(
    `SELECT f.* FROM findings f
     JOIN runs r ON r.id = f.run_id
     JOIN (SELECT r2.project_id, IFNULL(r2.tool_id,'') AS tid, MAX(r2.started_at) AS mx
             FROM runs r2
             JOIN projects p ON p.id = r2.project_id
            WHERE r2.kind='scan' AND r2.status!='cancelled'
              AND r2.started_at > IFNULL(p.cleared_at, 0)
            GROUP BY r2.project_id, IFNULL(r2.tool_id,'')) g
       ON g.project_id = r.project_id
      AND g.tid = IFNULL(r.tool_id,'')
      AND g.mx = r.started_at`,
  );
  return rows.map(mapFinding);
}

export interface RunStat {
  run_id: string;
  project_id: string;
  tool_id: string | null;
  tool_name: string;
  kind: string;
  status: string;
  started_at: number;
  duration_ms: number | null;
  findings: number;
  critical: number;
  high: number;
  edits: number;
}

/**
 * One row per run with its finding and edit counts, for the Stats view.
 * Aggregated in SQL so the app never has to pull every finding into memory.
 */
export async function runStats(): Promise<RunStat[]> {
  const db = await getDb();
  const rows = await db.select<RunStat[]>(
    `SELECT r.id AS run_id, r.project_id, r.tool_id, r.tool_name, r.kind, r.status,
            r.started_at, r.duration_ms,
            (SELECT COUNT(*) FROM findings f WHERE f.run_id = r.id) AS findings,
            (SELECT COUNT(*) FROM findings f WHERE f.run_id = r.id AND f.severity='critical') AS critical,
            (SELECT COUNT(*) FROM findings f WHERE f.run_id = r.id AND f.severity='high') AS high,
            (SELECT COUNT(*) FROM edits e WHERE e.run_id = r.id) AS edits
       FROM runs r
      ORDER BY r.started_at ASC`,
  );
  return rows;
}

/** Scan-run history for a project (snapshots over time). */
export async function listScanRuns(projectId: string, limit = 30): Promise<Run[]> {
  const db = await getDb();
  const rows = await db.select<Run[]>(
    "SELECT * FROM runs WHERE project_id=$1 AND kind='scan' ORDER BY started_at DESC LIMIT $2",
    [projectId, limit],
  );
  return rows;
}

/* ----------------------------------- edits ---------------------------------- */
export async function insertEdit(e: Omit<Edit, "id" | "created_at">): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO edits (id,run_id,project_id,file,diff,added,removed,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uid("e_"), e.run_id, e.project_id, e.file, e.diff, e.added, e.removed, now()],
  );
}

export async function listEdits(runId: string): Promise<Edit[]> {
  const db = await getDb();
  const rows = await db.select<Edit[]>("SELECT * FROM edits WHERE run_id=$1 ORDER BY created_at ASC", [runId]);
  return rows;
}

/* --------------------------------- settings --------------------------------- */
export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>("SELECT value FROM settings WHERE key=$1", [key]);
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2",
    [key, value],
  );
}

/* ----------------------------- project commands ----------------------------- */
/** A starred script or a command the user wrote, for Workspace's Scripts menu. */
export interface ProjectCommand {
  id: string;
  project_id: string;
  label: string;
  command: string;
  /** Written by hand, as opposed to a detected script kept only for its star. */
  custom: boolean;
  starred: boolean;
  created_at: number;
}

export async function listProjectCommands(projectId: string): Promise<ProjectCommand[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>(
    "SELECT * FROM project_commands WHERE project_id=$1 ORDER BY created_at",
    [projectId],
  );
  return rows.map((r) => ({ ...r, custom: !!r.custom, starred: !!r.starred }) as unknown as ProjectCommand);
}

/**
 * Star or unstar a line. A detected script that loses its star loses its row
 * too, since the star was all it held; a hand-written command keeps its row.
 */
export async function setCommandStar(projectId: string, label: string, command: string, starred: boolean): Promise<void> {
  const db = await getDb();
  if (starred) {
    await db.execute(
      `INSERT INTO project_commands (id,project_id,label,command,custom,starred,created_at)
       VALUES ($1,$2,$3,$4,0,1,$5)
       ON CONFLICT(project_id, command) DO UPDATE SET starred=1`,
      [uid("cmd_"), projectId, label, command, now()],
    );
    return;
  }
  await db.execute("DELETE FROM project_commands WHERE project_id=$1 AND command=$2 AND custom=0", [projectId, command]);
  await db.execute("UPDATE project_commands SET starred=0 WHERE project_id=$1 AND command=$2", [projectId, command]);
}

/** Add a hand-written command. Adding a line the project already has updates its label. */
export async function addProjectCommand(projectId: string, label: string, command: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO project_commands (id,project_id,label,command,custom,starred,created_at)
     VALUES ($1,$2,$3,$4,1,0,$5)
     ON CONFLICT(project_id, command) DO UPDATE SET label=$3, custom=1`,
    [uid("cmd_"), projectId, label, command, now()],
  );
}

export async function deleteProjectCommand(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM project_commands WHERE id=$1", [id]);
}

/* ---------------------------------- ports ----------------------------------- */
/** Ports added by hand to a project's Ports panel, lowest first. Detected ones are never stored. */
export async function listProjectPorts(projectId: string): Promise<number[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>("SELECT port FROM project_ports WHERE project_id=$1 ORDER BY port", [projectId]);
  return rows.map((r) => Number(r.port));
}

export async function addProjectPort(projectId: string, port: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO project_ports (project_id,port,created_at) VALUES ($1,$2,$3) ON CONFLICT(project_id, port) DO NOTHING",
    [projectId, port, now()],
  );
}

export async function deleteProjectPort(projectId: string, port: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM project_ports WHERE project_id=$1 AND port=$2", [projectId, port]);
}

/* ---------------------------------- deploy ---------------------------------- */
function mapServer(r: Row): DeployServer {
  return {
    ...r,
    port: Number(r.port),
    key_path: r.key_path ? String(r.key_path) : null,
    host_key: r.host_key ? String(r.host_key) : null,
    excludes: jarr(r.excludes),
    is_default: !!r.is_default,
    auto_upload: !!r.auto_upload,
    last_deploy_at: r.last_deploy_at == null ? null : Number(r.last_deploy_at),
  } as unknown as DeployServer;
}

/** A project's servers, the default first. */
export async function listDeployServers(projectId: string): Promise<DeployServer[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>(
    "SELECT * FROM deploy_servers WHERE project_id=$1 ORDER BY is_default DESC, created_at",
    [projectId],
  );
  return rows.map(mapServer);
}

/** Every server with auto-upload on, across projects: the ones whose folders are watched. */
export async function listAutoDeployServers(): Promise<DeployServer[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>(
    `SELECT s.* FROM deploy_servers s JOIN projects p ON p.id = s.project_id
     WHERE s.auto_upload=1 AND p.deleted_at IS NULL`,
  );
  return rows.map(mapServer);
}

/**
 * Insert or update a server. The first server of a project becomes its default;
 * making one the default takes it from the others.
 */
export async function saveDeployServer(s: DeployServer): Promise<void> {
  const db = await getDb();
  const others = await db.select<Row[]>("SELECT id FROM deploy_servers WHERE project_id=$1 AND id<>$2", [
    s.project_id,
    s.id,
  ]);
  const isDefault = s.is_default || others.length === 0;
  await db.execute(
    `INSERT INTO deploy_servers (id,project_id,name,protocol,host,port,username,auth,key_path,remote_path,local_dir,
       excludes,host_key,is_default,auto_upload,last_deploy_at,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT(id) DO UPDATE SET name=$3, protocol=$4, host=$5, port=$6, username=$7, auth=$8, key_path=$9,
       remote_path=$10, local_dir=$11, excludes=$12, host_key=$13, is_default=$14, auto_upload=$15`,
    [
      s.id,
      s.project_id,
      s.name,
      s.protocol,
      s.host,
      s.port,
      s.username,
      s.auth,
      s.key_path,
      s.remote_path,
      s.local_dir,
      JSON.stringify(s.excludes),
      s.host_key,
      b(isDefault),
      b(s.auto_upload),
      s.last_deploy_at,
      s.created_at,
    ],
  );
  if (isDefault) {
    await db.execute("UPDATE deploy_servers SET is_default=0 WHERE project_id=$1 AND id<>$2", [s.project_id, s.id]);
  }
}

export async function setDefaultDeployServer(projectId: string, id: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE deploy_servers SET is_default=(id=$2) WHERE project_id=$1", [projectId, id]);
}

export async function setDeployAutoUpload(id: string, on: boolean): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE deploy_servers SET auto_upload=$2 WHERE id=$1", [id, b(on)]);
}

/** Forget a server and its manifest. When it was the default, the oldest one left takes over. */
export async function deleteDeployServer(id: string): Promise<void> {
  const db = await getDb();
  const rows = await db.select<Row[]>("SELECT project_id, is_default FROM deploy_servers WHERE id=$1", [id]);
  await db.execute("DELETE FROM deploy_files WHERE server_id=$1", [id]);
  await db.execute("DELETE FROM deploy_servers WHERE id=$1", [id]);
  const gone = rows[0];
  if (gone?.is_default) {
    await db.execute(
      `UPDATE deploy_servers SET is_default=1 WHERE id=(
         SELECT id FROM deploy_servers WHERE project_id=$1 ORDER BY created_at LIMIT 1)`,
      [gone.project_id],
    );
  }
}

/** One file as the server last received it. */
export interface DeployedFile {
  path: string;
  size: number;
  mtime: number;
  hash: string;
}

export async function deployManifest(serverId: string): Promise<DeployedFile[]> {
  const db = await getDb();
  const rows = await db.select<Row[]>("SELECT path,size,mtime,hash FROM deploy_files WHERE server_id=$1", [serverId]);
  return rows.map((r) => ({ path: String(r.path), size: Number(r.size), mtime: Number(r.mtime), hash: String(r.hash) }));
}

/** Rows per statement: a first baseline is thousands of files, one round trip each would crawl. */
const MANIFEST_BATCH = 200;

/** Record what the server now holds: `files` as uploaded (or unchanged), `removed` as gone from it. */
export async function updateDeployManifest(
  serverId: string,
  files: DeployedFile[],
  removed: string[],
  deployedAt: number | null,
): Promise<void> {
  const db = await getDb();
  for (let i = 0; i < files.length; i += MANIFEST_BATCH) {
    const chunk = files.slice(i, i + MANIFEST_BATCH);
    const values = chunk.map((_, j) => `($1,$${j * 4 + 2},$${j * 4 + 3},$${j * 4 + 4},$${j * 4 + 5})`).join(",");
    await db.execute(
      `INSERT INTO deploy_files (server_id,path,size,mtime,hash) VALUES ${values}
       ON CONFLICT(server_id,path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, hash=excluded.hash`,
      [serverId, ...chunk.flatMap((f) => [f.path, f.size, f.mtime, f.hash])],
    );
  }
  for (let i = 0; i < removed.length; i += MANIFEST_BATCH) {
    const chunk = removed.slice(i, i + MANIFEST_BATCH);
    const marks = chunk.map((_, j) => `$${j + 2}`).join(",");
    await db.execute(`DELETE FROM deploy_files WHERE server_id=$1 AND path IN (${marks})`, [serverId, ...chunk]);
  }
  if (deployedAt !== null) {
    await db.execute("UPDATE deploy_servers SET last_deploy_at=$2 WHERE id=$1", [serverId, deployedAt]);
  }
}
