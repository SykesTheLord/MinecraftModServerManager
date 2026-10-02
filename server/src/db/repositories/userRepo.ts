import { db } from "../client.js";

export type GlobalRole = "superadmin" | "user";

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  global_role: GlobalRole;
  created_at: string;
  updated_at: string;
}

export const userRepo = {
  findByUsername(username: string): UserRow | undefined {
    return db
      .prepare("SELECT * FROM user WHERE username = ?")
      .get(username) as UserRow | undefined;
  },

  findById(id: string): UserRow | undefined {
    return db.prepare("SELECT * FROM user WHERE id = ?").get(id) as
      | UserRow
      | undefined;
  },

  list(): UserRow[] {
    return db.prepare("SELECT * FROM user ORDER BY username").all() as UserRow[];
  },

  count(): number {
    const row = db.prepare("SELECT COUNT(*) as n FROM user").get() as {
      n: number;
    };
    return row.n;
  },

  create(user: {
    id: string;
    username: string;
    passwordHash: string;
    globalRole: GlobalRole;
  }): void {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO user (id, username, password_hash, global_role, created_at, updated_at)
       VALUES (@id, @username, @passwordHash, @globalRole, @now, @now)`
    ).run({ ...user, now });
  },

  updatePasswordHash(id: string, passwordHash: string): void {
    db.prepare(
      "UPDATE user SET password_hash = ?, updated_at = ? WHERE id = ?"
    ).run(passwordHash, new Date().toISOString(), id);
  },

  setGlobalRole(id: string, globalRole: GlobalRole): void {
    db.prepare("UPDATE user SET global_role = ?, updated_at = ? WHERE id = ?").run(globalRole, new Date().toISOString(), id);
  },

  delete(id: string): void {
    db.prepare("DELETE FROM user WHERE id = ?").run(id);
  },
};
