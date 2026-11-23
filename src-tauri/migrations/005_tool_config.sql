-- Per-tool options as JSON: which rule groups are enabled and any extra plugin
-- the user added. Tools without options leave it NULL.
ALTER TABLE tools ADD COLUMN config TEXT;
