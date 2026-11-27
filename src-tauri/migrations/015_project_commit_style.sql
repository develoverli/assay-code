-- How Write with AI shapes a project's commit subjects.
--
-- commit_style: 'auto' (or NULL, every project from before) follows the repository
-- — release-please's files at the root mean type first (`feat: ✨ …`), otherwise
-- gitmoji first (`✨ feat: …`). 'gitmoji', 'release-please' and 'custom' force one.
-- commit_prompt: the instructions a 'custom' project sends instead of a shared
-- template; the diff is appended after it, never written into it.
ALTER TABLE projects ADD COLUMN commit_style TEXT;
ALTER TABLE projects ADD COLUMN commit_prompt TEXT;
