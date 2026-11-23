-- Projects keep their history when they leave.
--
-- deleted_at: removing a project used to delete its runs, findings and edits,
--   which silently rewrote the past — the Stats trend and the Audit trail lost
--   work that really happened. Now the project is retired instead: hidden from
--   the working views, still present wherever history is shown.
--
-- cleared_at: "reset the checks" for a project. Findings and the tool cards only
--   consider scans newer than this, so the board starts empty without touching
--   Audit or the evolution in Stats.
ALTER TABLE projects ADD COLUMN deleted_at INTEGER;
ALTER TABLE projects ADD COLUMN cleared_at INTEGER;
