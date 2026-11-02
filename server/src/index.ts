import { createClock } from "./shared/clock.js";
import { scriptedModel } from "./agent/index.js";
import { createApp } from "./app.js";
import { createConversationService } from "./conversations/index.js";
import { demoForcedQueue } from "./tools/index.js";
import { APP_DB_PATH, openAppDatabase } from "./setup.js";

const clock = createClock();
const db = openAppDatabase(APP_DB_PATH, clock);
// dev/demo only (2.5.4, R12): off unless DEMO_FORCE is set
const mock = { forced: demoForcedQueue(process.env.DEMO_FORCE) };

// § 2.5.6: finish any booking a stop cut off before taking new requests
await createConversationService({ db, clock, model: scriptedModel, mock }).recoverInFlight();

const port = Number(process.env.PORT ?? 3001);
createApp({ db, clock, model: scriptedModel, mock }).listen(port, () => {
  console.log(`server listening on http://localhost:${port}`);
});
