import { openDatabase, runMigrations } from "./shared/db.js";
import { createClock } from "./shared/clock.js";
import { seedDemoUsers } from "./auth/index.js";
import { seedMockWorld } from "./tools/mock-world.js";
import { scriptedModel } from "./agent/index.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createApp } from "./app.js";
import { createConversationService } from "./conversations/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const db = openDatabase(join(here, "../../server/data/errand.db"));
const clock = createClock();
runMigrations(db, join(here, "../../server/migrations"));
seedDemoUsers(db, clock.now().getTime());
if ((db.prepare("SELECT COUNT(*) AS c FROM mock_provider").get() as { c: number }).c === 0) {
  seedMockWorld(db, { seed: process.env.MOCK_SEED ?? "errand-agent-v1", clock });
}

// § 2.5.6: finish any booking a stop cut off before taking new requests
await createConversationService({ db, clock, model: scriptedModel }).recoverInFlight();

const port = Number(process.env.PORT ?? 3001);
createApp({ db, clock, model: scriptedModel }).listen(port, () => {
  console.log(`server listening on http://localhost:${port}`);
});
