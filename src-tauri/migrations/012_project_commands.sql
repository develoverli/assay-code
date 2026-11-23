-- The commands a project runs from Workspace's Scripts menu, beyond what Assay
-- detects on its own.
--
-- Two kinds of row share the table: a detected script the user starred (custom
-- = 0; the row exists only to hold the star, and the script itself is read
-- from the repo every time), and a command the user wrote by hand (custom = 1),
-- starred or not. The command line is the identity inside a project, so the
-- same line can be starred once and never listed twice.
CREATE TABLE IF NOT EXISTS project_commands (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  label TEXT NOT NULL,
  command TEXT NOT NULL,
  custom INTEGER NOT NULL DEFAULT 0,
  starred INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS project_commands_line ON project_commands (project_id, command);
