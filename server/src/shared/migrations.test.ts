import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDatabase, runMigrations } from "./db.js";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "errand-db-"));
  db = openDatabase(join(dir, "test.db"));
});

afterEach(() => {
  db.close();
});

function writeMigration(name: string, sql: string) {
  writeFileSync(join(dir, name), sql);
}

function migrationNames(): string[] {
  return (db.prepare("SELECT name FROM schema_migration ORDER BY name").all() as { name: string }[]).map((r) => r.name);
}

function tableNames(): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

describe("migrations", () => {
  it("applies numbered files in order and records them", () => {
    writeMigration("001_add_thing.sql", "CREATE TABLE thing (id TEXT PRIMARY KEY) STRICT;");
    writeMigration("002_add_more.sql", "CREATE TABLE more (id TEXT PRIMARY KEY) STRICT;");
    runMigrations(db, dir);
    expect(migrationNames()).toEqual(["001_add_thing.sql", "002_add_more.sql"]);
    const thingStrict = (db.prepare("PRAGMA table_info(thing)").all() as { name: string }[]).length > 0;
    expect(thingStrict).toBe(true);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='thing'").get() as { sql: string }).toMatchObject({
      sql: expect.stringContaining("STRICT"),
    });
  });

  it("applies only new files on a second run (applied ones are never re-executed)", () => {
    writeMigration("001_add_thing.sql", "CREATE TABLE thing (id TEXT PRIMARY KEY) STRICT;");
    runMigrations(db, dir);
    // Rewriting 001 with different SQL proves it is not re-run.
    writeMigration("001_add_thing.sql", "CREATE TABLE boom (id TEXT PRIMARY KEY);");
    writeMigration("002_add_more.sql", "CREATE TABLE more (id TEXT PRIMARY KEY) STRICT;");
    runMigrations(db, dir);
    expect(migrationNames()).toEqual(["001_add_thing.sql", "002_add_more.sql"]);
    expect(tableNames()).toContain("more");
    expect(tableNames()).not.toContain("boom");
  });

  it("leaves a fresh migrated database with no business tables", () => {
    runMigrations(db, dir);
    expect(tableNames().filter((n) => n !== "schema_migration")).toEqual([]);
  });
});