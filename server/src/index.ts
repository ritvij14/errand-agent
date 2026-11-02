import { openDatabase, runMigrations } from "./shared/db.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createApp } from "./app.js";

const here = dirname(fileURLToPath(import.meta.url));
const db = openDatabase(join(here, "../../server/data/errand.db"));
runMigrations(db, join(here, "../../server/migrations"));

const port = Number(process.env.PORT ?? 3001);
createApp().listen(port, () => {
  console.log(`server listening on http://localhost:${port}`);
});
