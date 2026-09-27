import { db } from "../client.js";

export const settingsRepo = {
  get(key: string): string | undefined {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  },

  set(key: string, value: string): void {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, value, new Date().toISOString());
  },
};
