import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { env } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

fs.mkdirSync(env.DATA_DIR, { recursive: true });

export const db = new Database(path.join(env.DATA_DIR, "app.sqlite3"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

/**
 * Applies pending migrations. Foreign keys are off while they run: SQLite
 * can't alter a CHECK constraint in place, so some migrations rebuild a
 * table (create new → copy → drop old → rename), and dropping a parent
 * table with foreign keys on would cascade-delete its children (e.g. every
 * instance_access grant). The pragma is a no-op inside a transaction, hence
 * set around the loop; integrity is re-checked before turning it back on.
 */
function runMigrations() {
  db.pragma("foreign_keys = OFF");
  try {
    applyPendingMigrations();
    const violations = db.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error(`Migration left ${violations.length} foreign key violation(s): ${JSON.stringify(violations)}`);
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function applyPendingMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const migrationsDir = path.join(__dirname, "migrations");
  const applied = new Set(
    db.prepare("SELECT name FROM schema_migrations").all().map((r: any) => r.name)
  );

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)"
      ).run(file, new Date().toISOString());
    })();
  }
}

runMigrations();
