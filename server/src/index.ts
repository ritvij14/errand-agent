import { openDatabase, runMigrations } from "./shared/db.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClock } from "./shared/clock.js";
import { seedMockWorld } from "./tools/mock-world.js";
import { createApp } from "./app.js";

const here = dirname(fileURLToPath(import.meta.url));
const db = openDatabase(join(here, "../../server/data/errand.db"));
runMigrations(db, join(here, "../../server/migrations"));
if ((db.prepare("SELECT COUNT(*) AS c FROM mock_provider").get() as { c: number }).c === 0) {
  seedMockWorld(db, { seed: process.env.MOCK_SEED ?? "errand-agent-v1", clock: createClock() });
}

const port = Number(process.env.PORT ?? 3001);
createApp().listen(port, () => {
  console.log(`server listening on http://localhost:${port}`);
});
