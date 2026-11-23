-- Whether the GitHub repository a project was cloned from is private.
--
-- Written when the clone lands and refreshed every time Clone from GitHub lists
-- the account's repositories, since that list already carries the visibility and
-- a repository can be made public or private after it was cloned. NULL means
-- unknown — a project cloned before this column existed, until the next listing.
ALTER TABLE projects ADD COLUMN github_private INTEGER;
