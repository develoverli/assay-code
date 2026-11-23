-- Tags the user invents, so a long list of projects can be read at a glance.
--
-- A table rather than a JSON column on projects: a tag is renamed, recoloured
-- and deleted as one thing, and a JSON array would mean rewriting every project
-- row to change one word. The join table is the assignment, and deleting a tag
-- only removes the label — the project it was on is untouched.
CREATE TABLE IF NOT EXISTS tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT 'violet',  -- a name from TAG_COLORS, never a hex
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Two tags called "frontend" and "Frontend" are the same tag to a human reading
-- the list, so the database refuses the second one.
CREATE UNIQUE INDEX IF NOT EXISTS tags_name_unique ON tags (lower(name));

CREATE TABLE IF NOT EXISTS project_tags (
  project_id TEXT NOT NULL,
  tag_id     TEXT NOT NULL,
  PRIMARY KEY (project_id, tag_id)
);

CREATE INDEX IF NOT EXISTS project_tags_tag ON project_tags (tag_id);
