import type { Db } from "../shared/db.js";
import type { FreeSlotsOpts } from "./slots.js";
import { freeSlots } from "./slots.js";
import { SERVICES, AREAS, type Service, type Area } from "./mock-world.js";

// The three read tools of the brief's fixed contract (2.5.4). Each returns
// { ok: true, data } or { ok: false, error, transient }. `transient: false` here —
// a read is a real answer, safe to re-issue but never retried blindly.

export type ToolOpts = FreeSlotsOpts;

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: string; transient: false };

export type ProviderSummary = {
  id: string;
  name: string;
  price: number;
  rating: number;
  attributes: Record<string, unknown>;
  slots: string[];
};

export type DateRange = { from: string; to: string };

// search_providers(service, area, date_range): 3–8 providers for a real pair;
// providers with no free slot in the range still come back with an empty list.
// Reviews are never included (2.5.7 rule 1 — the read step can't see them).
export const searchProviders = (db: Db, opts: ToolOpts, args: { service: string; area: string } & DateRange): ToolResult<{ providers: ProviderSummary[] }> => {
  const { service, area, from, to } = args;
  if (!SERVICES.includes(service as Service)) return { ok: false, error: "unknown_service", transient: false };
  if (!AREAS.includes(area as Area)) return { ok: false, error: "unknown_area", transient: false };
  const rows = db
    .prepare(
      `SELECT DISTINCT p.id FROM mock_provider p
       JOIN mock_provider_area a ON a.provider_id = p.id
       WHERE p.service = ? AND a.area = ?`,
    )
    .all(service, area) as { id: string }[];
  const providers = rows.map((r) => {
    const p = db.prepare(`SELECT id, name, price, rating, attributes FROM mock_provider WHERE id = ?`).get(r.id) as {
      id: string;
      name: string;
      price: number;
      rating: number;
      attributes: string;
    };
    return {
      id: p.id,
      name: p.name,
      price: p.price,
      rating: p.rating,
      attributes: JSON.parse(p.attributes) as Record<string, unknown>,
      slots: freeSlots(db, opts, p.id, from, to),
    };
  });
  return { ok: true, data: { providers } };
};

// get_provider(provider_id): details + reviews (the one place free text is handed
// over — the gateway wraps it as untrusted before anything else sees it).
export const getProvider = (db: Db, opts: ToolOpts, providerId: string): ToolResult<{
  id: string;
  name: string;
  service: string;
  areas: string[];
  price: number;
  rating: number;
  attributes: Record<string, unknown>;
  reviews: { text: string }[];
}> => {
  void opts;
  const p = db.prepare(`SELECT * FROM mock_provider WHERE id = ?`).get(providerId) as
    | { id: string; name: string; service: string; price: number; rating: number; attributes: string }
    | undefined;
  if (!p) return { ok: false, error: "not_found", transient: false };
  const areas = (db.prepare(`SELECT area FROM mock_provider_area WHERE provider_id = ?`).all(providerId) as { area: string }[]).map(
    (r) => r.area,
  );
  const reviews = (db.prepare(`SELECT text FROM mock_review WHERE provider_id = ?`).all(providerId) as { text: string }[]).map(
    (r) => ({ text: r.text }),
  );
  return {
    ok: true,
    data: {
      id: p.id,
      name: p.name,
      service: p.service,
      areas,
      price: p.price,
      rating: p.rating,
      attributes: JSON.parse(p.attributes) as Record<string, unknown>,
      reviews,
    },
  };
};

// list_bookings(user_id): only the calling user's bookings (V-7). Status is derived:
// a stored 'booked' whose slot is past reads as 'completed' (schema.md). Also returns
// `price` and `area` (R4 reading) so approvals and reschedule search can use them.
export const listBookings = (db: Db, opts: ToolOpts, userId: string): ToolResult<{ bookings: BookingRecord[] }> => {
  const rows = db
    .prepare(
      `SELECT b.id, b.provider_id, p.name AS provider_name, b.service, b.area, b.slot, b.price, b.status, b.created_at
       FROM mock_booking b JOIN mock_provider p ON p.id = b.provider_id
       WHERE b.user_id = ? ORDER BY b.slot DESC`,
    )
    .all(userId) as {
    id: string;
    provider_id: string;
    provider_name: string;
    service: string;
    area: string;
    slot: string;
    price: number;
    status: string;
    created_at: number;
  }[];
  const nowMs = opts.clock.now().getTime();
  return {
    ok: true,
    data: {
      bookings: rows.map((b) => ({
        id: b.id,
        providerId: b.provider_id,
        providerName: b.provider_name,
        service: b.service,
        area: b.area,
        slot: b.slot,
        price: b.price,
        status: b.status === "booked" && Date.parse(b.slot) < nowMs ? "completed" : b.status,
        createdAt: b.created_at,
      })),
    },
  };
};

export type BookingRecord = {
  id: string;
  providerId: string;
  providerName: string;
  service: string;
  area: string;
  slot: string;
  price: number;
  status: string;
  createdAt: number;
};