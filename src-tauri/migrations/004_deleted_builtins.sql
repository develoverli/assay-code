-- Tombstones for built-in tools the user removed.
--
-- Built-ins are re-seeded on every launch, so deleting one has to be recorded
-- or it comes straight back. Settings can empty this table to restore them.
CREATE TABLE IF NOT EXISTS deleted_builtins (
  id         TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);
