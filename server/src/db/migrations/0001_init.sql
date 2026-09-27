CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  global_role TEXT NOT NULL CHECK (global_role IN ('superadmin', 'user')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instance (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subdomain TEXT NOT NULL UNIQUE,
  ftb_modpack_id INTEGER NOT NULL,
  ftb_version_id INTEGER NOT NULL,
  ftb_pack_name TEXT NOT NULL,
  memory_mb INTEGER NOT NULL,
  container_id TEXT,
  container_name TEXT NOT NULL,
  volume_name TEXT NOT NULL,
  rcon_password TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('creating', 'installing', 'running', 'stopped', 'error', 'deleting')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instance_access (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES instance(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, instance_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
