import { db } from "../client.js";

export type InstanceStatus =
  | "creating"
  | "installing"
  | "running"
  | "stopped"
  | "error"
  | "deleting";

export interface InstanceRow {
  id: string;
  name: string;
  subdomain: string;
  ftb_modpack_id: number;
  ftb_version_id: number;
  ftb_pack_name: string;
  memory_mb: number;
  image: string;
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
  }): void {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO instance (
         id, name, subdomain, ftb_modpack_id, ftb_version_id, ftb_pack_name,
         memory_mb, image, container_id, container_name, volume_name, rcon_password,
         status, last_error, created_at, updated_at
       ) VALUES (
         @id, @name, @subdomain, @ftbModpackId, @ftbVersionId, @ftbPackName,
         @memoryMb, @image, NULL, @containerName, @volumeName, @rconPassword,
         'creating', NULL, @now, @now
       )`
    ).run({ ...instance, now });
  },

  updateStatus(id: string, status: InstanceStatus, lastError: string | null = null): void {
    db.prepare(
      "UPDATE instance SET status = ?, last_error = ?, updated_at = ? WHERE id = ?"
    ).run(status, lastError, new Date().toISOString(), id);
  },

  setContainerId(id: string, containerId: string): void {
    db.prepare(
      "UPDATE instance SET container_id = ?, updated_at = ? WHERE id = ?"
    ).run(containerId, new Date().toISOString(), id);
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
