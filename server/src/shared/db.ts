import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";

export type Db = Database.Database;

// The app's database (ADR-003): one file via better-sqlite3, STRICT tables,
// timestamps in unix milliseconds, ids UUID v4. Never import this outside `shared`
// — features reach the database only through their own repository layer.
export const openDatabase = (path: string): Db => {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
};

export const runMigrations = (db: Db, migrationsDir: string): void => {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;`);
  const applied = new Set(
    (db.prepare(`SELECT name FROM schema_migration`).all() as { name: string }[]).map((r) => r.name),
  );
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql") && /^\d{3}_/.test(f))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(`${migrationsDir}/${file}`, "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare(`INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)`).run(file, Date.now());
    })();
  }
};