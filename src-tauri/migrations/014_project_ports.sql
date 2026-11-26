-- Ports the user added by hand to a project's Ports panel: something that runs
-- outside Assay's terminals (a container, another editor) and that they want to
-- share from here. Detected ports are never stored; they are read from the OS
-- every time. Storing a port never opens a tunnel by itself.
CREATE TABLE IF NOT EXISTS project_ports (
  project_id TEXT NOT NULL,
  port INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, port)
);
