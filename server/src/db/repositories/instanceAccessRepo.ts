import { db } from "../client.js";

export type InstanceRole = "admin" | "operator";

export interface InstanceAccessRow {
  user_id: string;
  instance_id: string;
  role: InstanceRole;
  granted_at: string;
}

const ROLE_RANK: Record<InstanceRole, number> = { operator: 1, admin: 2 };

export function roleSatisfies(actual: InstanceRole, required: InstanceRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export const instanceAccessRepo = {
  grant(userId: string, instanceId: string, role: InstanceRole): void {
    db.prepare(
      `INSERT INTO instance_access (user_id, instance_id, role, granted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, instance_id) DO UPDATE SET role = excluded.role`
    ).run(userId, instanceId, role, new Date().toISOString());
  },

  revoke(userId: string, instanceId: string): void {
    db.prepare(
      "DELETE FROM instance_access WHERE user_id = ? AND instance_id = ?"
    ).run(userId, instanceId);
  },

  get(userId: string, instanceId: string): InstanceAccessRow | undefined {
    return db
      .prepare(
        "SELECT * FROM instance_access WHERE user_id = ? AND instance_id = ?"
      )
      .get(userId, instanceId) as InstanceAccessRow | undefined;
  },

  listForUser(userId: string): InstanceAccessRow[] {
    return db
      .prepare("SELECT * FROM instance_access WHERE user_id = ?")
      .all(userId) as InstanceAccessRow[];
  },

  listForInstance(instanceId: string): InstanceAccessRow[] {
    return db
      .prepare("SELECT * FROM instance_access WHERE instance_id = ?")
      .all(instanceId) as InstanceAccessRow[];
  },
};
