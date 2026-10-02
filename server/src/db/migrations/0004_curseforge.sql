-- CurseForge modpacks (source = 'curseforge'): their CurseForge project/file
-- ids, and — while an install is blocked on mods whose authors disallow
-- automated downloads (status = 'awaiting_files') — the list of those files
-- as JSON. SQLite can't change a CHECK constraint in place, so the table is
-- rebuilt; runMigrations disables foreign keys around this so instance_access
-- rows aren't cascade-deleted when the old table is dropped.
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
  status TEXT NOT NULL CHECK (status IN ('creating', 'awaiting_files', 'installing', 'running', 'stopped', 'error', 'deleting')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  image TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'ftb' CHECK (source IN ('ftb', 'import', 'curseforge')),
  server_env TEXT,
  cf_mod_id INTEGER,
  cf_file_id INTEGER,
  missing_files TEXT
);

INSERT INTO instance_new (
  id, name, subdomain, ftb_modpack_id, ftb_version_id, ftb_pack_name, memory_mb,
  container_id, container_name, volume_name, rcon_password, status, last_error,
  created_at, updated_at, image, source, server_env
)
SELECT
  id, name, subdomain, ftb_modpack_id, ftb_version_id, ftb_pack_name, memory_mb,
  container_id, container_name, volume_name, rcon_password, status, last_error,
  created_at, updated_at, image, source, server_env
FROM instance;

DROP TABLE instance;
ALTER TABLE instance_new RENAME TO instance;
