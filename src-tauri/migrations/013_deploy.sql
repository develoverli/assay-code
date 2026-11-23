-- Deploy: the servers a project uploads to, and what each one last received.
--
-- A project can have several servers (staging, production); one is the
-- default the Upload button uses. Passwords and key passphrases are NOT here:
-- they live in the OS keychain under the server id (src-tauri/src/deploy.rs).
--
-- host_key is the SHA256 fingerprint the user accepted on first contact; a
-- server answering with any other key is refused.
CREATE TABLE IF NOT EXISTS deploy_servers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'sftp',
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  auth TEXT NOT NULL DEFAULT 'password',
  key_path TEXT,
  remote_path TEXT NOT NULL DEFAULT '',
  local_dir TEXT NOT NULL DEFAULT '',
  excludes TEXT NOT NULL DEFAULT '[]',
  host_key TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  auto_upload INTEGER NOT NULL DEFAULT 0,
  last_deploy_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS deploy_servers_project ON deploy_servers (project_id);

-- The manifest: one row per file as of its last upload to that server. What
-- differs from the disk is what the next deploy sends.
CREATE TABLE IF NOT EXISTS deploy_files (
  server_id TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (server_id, path)
);
