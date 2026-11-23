-- sechub initial schema

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  path        TEXT,
  url         TEXT,
  stack       TEXT NOT NULL DEFAULT '[]',   -- JSON array
  authorized  INTEGER NOT NULL DEFAULT 0,   -- ethical scan consent for URL targets
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Tools AND skills share this registry. source discriminates them.
CREATE TABLE IF NOT EXISTS tools (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  source    TEXT NOT NULL DEFAULT 'tool',  -- 'tool' | 'skill'
  kind      TEXT NOT NULL,                 -- 'npx' | 'docker' | 'cli' | 'cli-agent'
  scope     TEXT NOT NULL,                 -- 'local' | 'url'
  stack     TEXT NOT NULL DEFAULT '[]',    -- JSON array; [] = any
  cmd       TEXT NOT NULL DEFAULT '',      -- template with {path} {url}
  adapter   TEXT NOT NULL DEFAULT 'generic',
  prompt    TEXT,                          -- for skills (cli-agent instruction)
  builtin   INTEGER NOT NULL DEFAULT 0,
  enabled   INTEGER NOT NULL DEFAULT 1,
  notes     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  tool_id     TEXT,
  tool_name   TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'scan',  -- 'scan' | 'fix'
  provider    TEXT,                          -- 'claude' | 'opencode' | 'openai' (fix runs)
  cmd         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running',-- running | success | error | cancelled
  exit_code   INTEGER,
  log         TEXT NOT NULL DEFAULT '',
  summary     TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS findings (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  tool_id     TEXT,
  severity    TEXT NOT NULL DEFAULT 'info',  -- critical|high|medium|low|info
  category    TEXT,
  file        TEXT,
  line        INTEGER,
  message     TEXT NOT NULL,
  raw         TEXT,
  fixed       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS edits (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  file        TEXT NOT NULL,
  diff        TEXT NOT NULL DEFAULT '',
  added       INTEGER NOT NULL DEFAULT 0,
  removed     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id);
CREATE INDEX IF NOT EXISTS idx_findings_project ON findings(project_id, severity);
CREATE INDEX IF NOT EXISTS idx_edits_run ON edits(run_id);

-- Built-in tool manifests (Phase 1: react-doctor end-to-end; others best-effort).
INSERT OR IGNORE INTO tools (id,name,source,kind,scope,stack,cmd,adapter,builtin,enabled,notes,created_at,updated_at) VALUES
 ('react-doctor','React Doctor','tool','npx','local','["react"]','npx -y react-doctor@latest --json','react-doctor',1,1,'React anti-patterns, perf, a11y, security (SAST). Runs in project folder.',0,0),
 ('unlighthouse','Unlighthouse','tool','npx','url','[]','npx -y @unlighthouse/cli ci --site {url} --reporter jsonExpanded --output-path .unlighthouse','unlighthouse',1,1,'Whole-site Lighthouse: perf / SEO / a11y. Needs a reachable URL.',0,0),
 ('strix','Strix','tool','cli','url','[]','strix --target {url}','strix',1,1,'AI pentest agent against an authorized target. Requires strix + docker installed.',0,0);
