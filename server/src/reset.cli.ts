import { createClock } from "./shared/clock.js";
import { APP_DB_PATH, resetDatabase } from "./setup.js";

// `npm run reset`: stop the dev server first (or use `npm run verify:reset`).
resetDatabase(APP_DB_PATH, createClock());
console.log(`reset ${APP_DB_PATH}: seeded world + demo users`);
