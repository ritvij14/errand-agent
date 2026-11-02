import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, runMigrations, type Db } from "./db.js";

export type TestDb = { db: Db; dir: string; close: () => void };

const repoMigrationsDir = fileURLToPath(new URL("../../migrations", import.meta.url));

// A fresh database per test: new temp file, migrations applied. Never reuse a file
// across tests — isolation comes from the file, not from cleanup.
export const createTestDb = (): TestDb => {
  const dir = mkdtempSync(join(tmpdir(), "errand-test-"));
  const db = openDatabase(join(dir, "test.db"));
  runMigrations(db, repoMigrationsDir);
  return {
    db,
    dir,
    close: () => db.close(),
  };
};