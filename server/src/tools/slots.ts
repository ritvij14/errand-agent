import type { Clock } from "../shared/clock.js";
import type { Db } from "../shared/db.js";

// Slot math (2.3, 2.5.4): 1-hour slots, 8:00–20:00 IST, ~4 free slots per provider
// per day, calculated from the seed for any date — holds and bookings are subtracted
// from the database, never stored as slots.
const SLOT_FIRST_HOUR = 8;
const SLOT_LAST_START_HOUR = 19; // a 1-hour slot starting 19:00 ends at 20:00
const IST_OFFSET = "+05:30";

// The 14 IST dates the agent may book: today (IST) through day 13.
export const slotWindow = (clock: Clock): string[] => {
  const msPerDay = 24 * 60 * 60 * 1000;
  const todayIst = istDateKey(clock.now());
  return [...Array(14).keys()].map((i) => istDateKey(new Date(dateKeyToMs(todayIst) + i * msPerDay)));
};

const dateKeyToMs = (key: string): number => Date.parse(`${key}T00:00:00+05:30`);

export const istDateKey = (d: Date): string => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(d)
    .split("-");
  return `${parts[0]}-${parts[1]}-${parts[2]}`;
};

export const slotStarts = (hour: number, dateKey: string): string =>
  `${dateKey}T${String(hour).padStart(2, "0")}:00:00${IST_OFFSET}`;

// The candidate hours a provider *could* offer on a date, from the seed: distinct
// hours in start range. ~4 per day for a typical provider.
export const seededHours = (seed: string, providerId: string, dateKey: string, target = 4): number[] => {
  const hours: number[] = [];
  for (let attempt = 0; hours.length < target && attempt < 40; attempt++) {
    const draw = randomHour(seed, providerId, dateKey, attempt);
    if (!hours.includes(draw)) hours.push(draw);
  }
  return hours.sort((a, b) => a - b);
};

const randomHour = (seed: string, providerId: string, dateKey: string, attempt: number): number => {
  const span = SLOT_LAST_START_HOUR - SLOT_FIRST_HOUR + 1;
  // hash without importing the agent-side draw (keeps slot calc pure over the seed label)
  let h = 2166136261;
  const label = `${seed}|slots|${providerId}|${dateKey}|${attempt}`;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return SLOT_FIRST_HOUR + (Math.abs(h) % span);
};

export type FreeSlotsOpts = { seed: string; clock: Clock };

// The provider's free slots between `from` and `to` (IST date keys, inclusive):
// seeded hours minus past (by the clock), minus bookings, minus unexpired holds —
// except `holderId`'s own holds, which never block that user's re-hold.
export const freeSlots = (
  db: Db,
  opts: FreeSlotsOpts,
  providerId: string,
  from: string,
  to: string,
  holderId?: string,
): string[] => {
  const days = slotWindow(opts.clock).filter((d) => d >= from && d <= to);
  const out: string[] = [];
  const nowMs = opts.clock.now().getTime();
  const bookedStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM mock_booking WHERE provider_id = ? AND slot = ? AND status = 'booked'`,
  );
  const heldStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM mock_hold WHERE provider_id = ? AND slot = ? AND expires_at > ? AND user_id IS NOT ?`,
  );
  for (const day of days) {
    for (const hour of seededHours(opts.seed, providerId, day)) {
      const slot = slotStarts(hour, day);
      if (Date.parse(slot) <= nowMs) continue;
      if ((bookedStmt.get(providerId, slot) as { c: number }).c > 0) continue;
      if ((heldStmt.get(providerId, slot, nowMs, holderId ?? null) as { c: number }).c > 0) continue;
      out.push(slot);
    }
  }
  return out;
};