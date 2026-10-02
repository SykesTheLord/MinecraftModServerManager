-- Modpack update tracking (FTB and CurseForge servers; see instances/packUpdates.ts).
--   auto_update: 'off' (never check), 'notify' (check and show), 'auto' (also
--   apply same-Minecraft-version release updates when the server is empty).
--   pack_version_name: the installed version's display name.
--   available_version_*: the newest update found by the last check, if any.
--   update_result: outcome of the last update attempt, for the UI.
ALTER TABLE instance ADD COLUMN auto_update TEXT NOT NULL DEFAULT 'notify' CHECK (auto_update IN ('off', 'notify', 'auto'));
ALTER TABLE instance ADD COLUMN pack_version_name TEXT;
ALTER TABLE instance ADD COLUMN available_version_id INTEGER;
ALTER TABLE instance ADD COLUMN available_version_name TEXT;
ALTER TABLE instance ADD COLUMN update_checked_at TEXT;
ALTER TABLE instance ADD COLUMN update_result TEXT;
