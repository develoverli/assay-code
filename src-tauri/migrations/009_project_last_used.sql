-- When a project was last worked on, so the list can put it first.
--
-- updated_at says when the row was edited, which is not the same thing: renaming
-- a project you abandoned a year ago should not lift it above the one you ran a
-- scan on this morning. last_used_at moves only on real work — a run started by
-- hand, a terminal or an agent opened in Workspace — never on selecting the
-- project, and never for the scheduler's unattended scans.
--
-- Backfilled from the newest run each project has, so the order means something
-- on the first launch after the upgrade instead of falling back for everyone.
ALTER TABLE projects ADD COLUMN last_used_at INTEGER;
UPDATE projects SET last_used_at = (
  SELECT MAX(started_at) FROM runs WHERE runs.project_id = projects.id
);
