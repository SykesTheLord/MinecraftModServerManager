import { db } from "../client.js";

export type InstanceStatus =
  | "creating"
  /** CurseForge install blocked on files the admin has to download by hand. */
  | "awaiting_files"
  | "installing"
  | "running"
  | "stopping"
  | "stopped"
  | "error"
  | "deleting";

export type InstanceSource = "ftb" | "import" | "curseforge";
export type AutoUpdateMode = "off" | "notify" | "auto";

export interface InstanceRow {
  id: string;
  name: string;
  subdomain: string;
  ftb_modpack_id: number;
  ftb_version_id: number;
  ftb_pack_name: string;
  memory_mb: number;
  image: string;
  source: InstanceSource;
  /** JSON object of itzg env (TYPE, VERSION, ...) — imports, and CurseForge packs once installed. */
  server_env: string | null;
  cf_mod_id: number | null;
  cf_file_id: number | null;
  /** JSON array of files a blocked CurseForge install needs (see curseforge/cfInstaller.ts). */
  missing_files: string | null;
  auto_update: AutoUpdateMode;
  pack_version_name: string | null;
  available_version_id: number | null;
  available_version_name: string | null;
  update_checked_at: string | null;
  update_result: string | null;
  update_window_start: string | null;
  update_window_end: string | null;
  update_window_tz: string | null;
  container_id: string | null;
  container_name: string;
  volume_name: string;
  rcon_password: string;
  status: InstanceStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export const instanceRepo = {
  list(): InstanceRow[] {
    return db
      .prepare("SELECT * FROM instance ORDER BY created_at")
      .all() as InstanceRow[];
  },

  findById(id: string): InstanceRow | undefined {
    return db.prepare("SELECT * FROM instance WHERE id = ?").get(id) as
      | InstanceRow
      | undefined;
  },

  findBySubdomain(subdomain: string): InstanceRow | undefined {
    return db
      .prepare("SELECT * FROM instance WHERE subdomain = ?")
      .get(subdomain) as InstanceRow | undefined;
  },

  create(instance: {
    id: string;
    name: string;
    subdomain: string;
    ftbModpackId: number;
    ftbVersionId: number;
    ftbPackName: string;
    memoryMb: number;
    image: string;
    containerName: string;
    volumeName: string;
    rconPassword: string;
    source?: InstanceSource;
    serverEnv?: Record<string, string>;
    cfModId?: number;
    cfFileId?: number;
    packVersionName?: string | null;
  }): void {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO instance (
         id, name, subdomain, ftb_modpack_id, ftb_version_id, ftb_pack_name,
         memory_mb, image, source, server_env, cf_mod_id, cf_file_id, pack_version_name, container_id, container_name,
         volume_name, rcon_password, status, last_error, created_at, updated_at
       ) VALUES (
         @id, @name, @subdomain, @ftbModpackId, @ftbVersionId, @ftbPackName,
         @memoryMb, @image, @source, @serverEnv, @cfModId, @cfFileId, @packVersionName, NULL, @containerName,
         @volumeName, @rconPassword,
         'creating', NULL, @now, @now
       )`
    ).run({
      ...instance,
      source: instance.source ?? "ftb",
      serverEnv: instance.serverEnv ? JSON.stringify(instance.serverEnv) : null,
      cfModId: instance.cfModId ?? null,
      cfFileId: instance.cfFileId ?? null,
      packVersionName: instance.packVersionName ?? null,
      now,
    });
  },

  updateStatus(id: string, status: InstanceStatus, lastError: string | null = null): void {
    db.prepare(
      "UPDATE instance SET status = ?, last_error = ?, updated_at = ? WHERE id = ?"
    ).run(status, lastError, new Date().toISOString(), id);
  },

  /** Sets the status only if it's still `expected`; false if something else changed it meanwhile. */
  setStatusIf(id: string, expected: InstanceStatus, status: InstanceStatus, lastError: string | null = null): boolean {
    return (
      db
        .prepare("UPDATE instance SET status = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = ?")
        .run(status, lastError, new Date().toISOString(), id, expected).changes > 0
    );
  },

  setContainerId(id: string, containerId: string): void {
    db.prepare(
      "UPDATE instance SET container_id = ?, updated_at = ? WHERE id = ?"
    ).run(containerId, new Date().toISOString(), id);
  },

  /** What a finished CurseForge install resolved: how to run it, on which image, and a display label. */
  setResolvedServer(id: string, fields: { serverEnv: Record<string, string>; image: string; packName: string }): void {
    db.prepare(
      "UPDATE instance SET server_env = ?, image = ?, ftb_pack_name = ?, updated_at = ? WHERE id = ?"
    ).run(JSON.stringify(fields.serverEnv), fields.image, fields.packName, new Date().toISOString(), id);
  },

  setMissingFiles(id: string, files: unknown[] | null): void {
    db.prepare("UPDATE instance SET missing_files = ?, updated_at = ? WHERE id = ?").run(
      files ? JSON.stringify(files) : null,
      new Date().toISOString(),
      id
    );
  },

  setAutoUpdate(id: string, mode: AutoUpdateMode): void {
    db.prepare("UPDATE instance SET auto_update = ?, updated_at = ? WHERE id = ?").run(mode, new Date().toISOString(), id);
  },

  setUpdateWindow(id: string, window: { start: string; end: string; timeZone: string } | null): void {
    db.prepare(
      "UPDATE instance SET update_window_start = ?, update_window_end = ?, update_window_tz = ?, updated_at = ? WHERE id = ?"
    ).run(window?.start ?? null, window?.end ?? null, window?.timeZone ?? null, new Date().toISOString(), id);
  },

  setUpdateCheck(id: string, available: { id: number; name: string } | null): void {
    db.prepare(
      "UPDATE instance SET available_version_id = ?, available_version_name = ?, update_checked_at = ? WHERE id = ?"
    ).run(available?.id ?? null, available?.name ?? null, new Date().toISOString(), id);
  },

  setUpdateResult(id: string, result: string): void {
    db.prepare("UPDATE instance SET update_result = ?, updated_at = ? WHERE id = ?").run(result, new Date().toISOString(), id);
  },

  /** Points the instance at a different version of its pack (the container is recreated separately). */
  setPackVersion(
    id: string,
    fields: { versionId: number; versionName: string; packName: string; image: string; containerId: null }
  ): void {
    db.prepare(
      `UPDATE instance SET
         ftb_version_id = CASE WHEN source = 'ftb' THEN @versionId ELSE ftb_version_id END,
         cf_file_id = CASE WHEN source = 'curseforge' THEN @versionId ELSE cf_file_id END,
         pack_version_name = @versionName, ftb_pack_name = @packName, image = @image, container_id = @containerId,
         available_version_id = NULL, available_version_name = NULL,
         -- a different version may have different updates: re-check on the next scheduler tick
         update_checked_at = NULL, updated_at = @now
       WHERE id = @id`
    ).run({ ...fields, id, now: new Date().toISOString() });
  },

  updateSubdomain(id: string, subdomain: string): void {
    db.prepare(
      "UPDATE instance SET subdomain = ?, updated_at = ? WHERE id = ?"
    ).run(subdomain, new Date().toISOString(), id);
  },

  delete(id: string): void {
    db.prepare("DELETE FROM instance WHERE id = ?").run(id);
  },
};
