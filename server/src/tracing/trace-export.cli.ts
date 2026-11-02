import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { openDatabase } from "../shared/db.js";
import { exportTrace, writeTraceFile } from "./export.js";

// Deliverable 5 (2.5.9): `npm run trace:export -- <run id>` writes traces/<run id>.json
// from the app's own database.
const here = fileURLToPath(new URL("../..", import.meta.url)); // server/
const runId = process.argv[2];
if (!runId) {
  console.error("usage: npm run trace:export -- <run id>");
  process.exit(1);
}
const db = openDatabase(join(here, "data", "errand.db"));
const exported = exportTrace(db, runId);
if (!exported) {
  console.error(`no run ${runId}`);
  process.exit(1);
}
const path = writeTraceFile(join(here, "..", "traces"), runId, exported);
console.log(`wrote ${path} (${exported.events.length} events)`);
