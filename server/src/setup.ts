import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, runMigrations, type Db } from "./shared/db.js";
import type { Clock } from "./shared/clock.js";
import { seedDemoUsers } from "./auth/index.js";
import { DEFAULT_SEED, seedMockWorld } from "./tools/index.js";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
export const APP_DB_PATH = join(serverDir, "data/errand.db");

/** Opens the app database, migrated, with the demo users and (once) the seeded mock world. */
export const openAppDatabase = (path: string, clock: Clock): Db => {
  mkdirSync(dirname(path), { recursive: true });
  const db = openDatabase(path);
  runMigrations(db, join(serverDir, "migrations"));
  seedDemoUsers(db, clock.now().getTime());
  if ((db.prepare("SELECT COUNT(*) AS c FROM mock_provider").get() as { c: number }).c === 0) {
    seedMockWorld(db, { seed: process.env.MOCK_SEED ?? DEFAULT_SEED, clock });
  }
  return db;
};

/**
 * Wipes the database and recreates the seeded world (§ 2.3 reset command).
 * @remarks Never run under a live server: it would keep writing to the deleted file.
 */
export const resetDatabase = (path: string, clock: Clock): void => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  openAppDatabase(path, clock).close();
};
