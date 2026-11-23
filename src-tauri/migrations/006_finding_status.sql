-- A finding is a claim about the code, and the answer to it ("that's fine",
-- "that's a false positive") has to outlive the scan that produced it. The
-- fingerprint is what carries that answer to the next scan.
ALTER TABLE findings ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE findings ADD COLUMN status_reason TEXT;
ALTER TABLE findings ADD COLUMN status_at INTEGER;
ALTER TABLE findings ADD COLUMN fingerprint TEXT;

-- Findings and runs only ever grow; every read filters on these.
CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id);
CREATE INDEX IF NOT EXISTS idx_findings_project ON findings(project_id);
CREATE INDEX IF NOT EXISTS idx_findings_fingerprint ON findings(project_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, started_at);
CREATE INDEX IF NOT EXISTS idx_edits_run ON edits(run_id);
