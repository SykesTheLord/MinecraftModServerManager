-- Adds status = 'stopping': recorded the moment a stop is requested (a
-- graceful shutdown takes seconds to a minute), so the UI can show it and a
-- manager restart mid-stop knows to finish the stop rather than treating the
-- still-running container as started outside the manager. SQLite can't
-- change a CHECK constraint in place, so the table is rebuilt (with every
-- column from 0001-0006); runMigrations disables foreign keys around this so
-- instance_access rows aren't cascade-deleted when the old table is dropped.
CREATE TABLE instance_new (
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
  status TEXT NOT NULL CHECK (status IN ('creating', 'awaiting_files', 'installing', 'running', 'stopping', 'stopped', 'error', 'deleting')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  image TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'ftb' CHECK (source IN ('ftb', 'import', 'curseforge')),
  server_env TEXT,
  cf_mod_id INTEGER,
  cf_file_id INTEGER,
  missing_files TEXT,
  auto_update TEXT NOT NULL DEFAULT 'notify' CHECK (auto_update IN ('off', 'notify', 'auto')),
  pack_version_name TEXT,
  available_version_id INTEGER,
  available_version_name TEXT,
  update_checked_at TEXT,
  update_result TEXT,
  update_window_start TEXT,
  update_window_end TEXT,
  update_window_tz TEXT
);

INSERT INTO instance_new (
  id, name, subdomain, ftb_modpack_id, ftb_version_id, ftb_pack_name, memory_mb,
  container_id, container_name, volume_name, rcon_password, status, last_error,
  created_at, updated_at, image, source, server_env, cf_mod_id, cf_file_id, missing_files,
  auto_update, pack_version_name, available_version_id, available_version_name,
  update_checked_at, update_result, update_window_start, update_window_end, update_window_tz
)
SELECT
  id, name, subdomain, ftb_modpack_id, ftb_version_id, ftb_pack_name, memory_mb,
  container_id, container_name, volume_name, rcon_password, status, last_error,
  created_at, updated_at, image, source, server_env, cf_mod_id, cf_file_id, missing_files,
  auto_update, pack_version_name, available_version_id, available_version_name,
  update_checked_at, update_result, update_window_start, update_window_end, update_window_tz
FROM instance;

DROP TABLE instance;
ALTER TABLE instance_new RENAME TO instance;
