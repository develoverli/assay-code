-- Which GitHub repository a project was cloned from, as `owner/name`.
--
-- Set by "Clone from GitHub" and by nothing else: a folder the user added by
-- hand is not claimed even when its origin points at GitHub, because the link is
-- a fact about how the project entered Assay, not a guess about its remote. The
-- clone dialog reads it to mark a repository as already here, so the same one is
-- not cloned twice into two projects.
ALTER TABLE projects ADD COLUMN github_repo TEXT;
