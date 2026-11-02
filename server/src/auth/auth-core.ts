import { randomBytes, createHash, timingSafeEqual, argon2Sync } from "node:crypto";
import type { Db } from "../shared/db.js";
import type { Clock } from "../shared/clock.js";
import { DEMO_USERS } from "../shared/demo-users.js";

// Auth sessions after the Lucia / Pilcrow guide (§ 2.5.1, ADR-005): token
// `<id>.<secret>`, only the SHA-256 of the secret stored, 10-day sliding expiry.

const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 10 * DAY_MS;
const BUMP_THRESHOLD_MS = 60 * 60 * 1000;

const READABLE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"; // 80-bit id in a readable alphabet

const randomTokenPart = (bits: number): string => {
  const length = Math.ceil(bits / Math.log2(READABLE_ALPHABET.length));
  const bytes = randomBytes(length);
  return [...bytes].map((b) => READABLE_ALPHABET[b % READABLE_ALPHABET.length]).join("");
};

// ——— passwords (Argon2id, § 2.5.1: 19 MiB, 3 passes, parallelism 1) ———

const ARGON = { parallelism: 1, memory: 19 * 1024, passes: 3, tagLength: 32 } as const;

export type PasswordCheck = { ok: true } | { ok: false; reason: string };

export const checkPasswordRules = (password: string): PasswordCheck => {
  if (typeof password !== "string" || password.length < 8 || password.length > 64) {
    return { ok: false, reason: "must be 8–64 characters" };
  }
  if (password !== password.trim()) return { ok: false, reason: "no leading or trailing spaces" };
  if (/[^\x20-\x7e]/.test(password)) return { ok: false, reason: "printable characters only" };
  return { ok: true };
};

// Stored format `argon2id$m=19456$t=3$p=1$<nonce b64url>$<tag b64url>` — the
// parameters travel with the hash because Node's crypto.argon2 has no verify API.
export const hashPassword = (password: string): string => {
  const nonce = randomBytes(16);
  const tag = argonParams(password, nonce, ARGON.tagLength);
  return ["argon2id", `m=${ARGON.memory}`, `t=${ARGON.passes}`, `p=${ARGON.parallelism}`, nonce.toString("base64url"), tag.toString("base64url")].join("$");
};

const argonParams = (message: string, nonce: Buffer, tagLength: number): Buffer =>
  argon2Sync("argon2id", { message, nonce, parallelism: ARGON.parallelism, tagLength, memory: ARGON.memory, passes: ARGON.passes });

const TAG_BYTES = 32;

export const verifyPassword = (stored: string, attempt: string): boolean => {
  const [alg, , , , nonceB64, tagB64] = stored.split("$");
  if (alg !== "argon2id") return false;
  try {
    const candidate = argonParams(attempt, Buffer.from(nonceB64!, "base64url"), TAG_BYTES);
    const storedTag = Buffer.from(tagB64!, "base64url");
    return candidate.length === storedTag.length && timingSafeEqual(candidate, storedTag);
  } catch {
    return false;
  }
};

// ——— sessions ———

export type Session = { id: string; userId: string };

export const createSession = (db: Db, clock: Clock, userId: string): string => {
  const id = randomTokenPart(80);
  const secret = randomBytes(32);
  db.prepare(`INSERT INTO auth_session (id, user_id, secret_hash, last_verified_at, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    userId,
    createHash("sha256").update(secret).digest(),
    clock.now().getTime(),
    clock.now().getTime(),
  );
  return `${id}.${secret.toString("base64url")}`;
};

// Verify a token: existing row, unexpired, secret hash equal (constant time).
// Sliding: bumps last_verified_at at most once an hour. Returns the session or null.
export const verifySession = (db: Db, clock: Clock, token: string | undefined): Session | null => {
  if (!token || !token.includes(".")) return null;
  const sep = token.indexOf(".");
  const id = token.slice(0, sep);
  const secretB64 = token.slice(sep + 1);
  if (!id || !secretB64) return null;
  const row = db
    .prepare(`SELECT user_id, secret_hash, last_verified_at FROM auth_session WHERE id = ?`)
    .get(id) as { user_id: string; secret_hash: Buffer; last_verified_at: number } | undefined;
  if (!row) return null;
  const nowMs = clock.now().getTime();
  if (row.last_verified_at < nowMs - SESSION_TTL_MS) return null;
  const presented = createHash("sha256").update(Buffer.from(secretB64, "base64url")).digest();
  if (presented.length !== row.secret_hash.length || !timingSafeEqual(presented, Buffer.from(row.secret_hash))) return null;
  if (nowMs - row.last_verified_at > BUMP_THRESHOLD_MS) {
    db.prepare(`UPDATE auth_session SET last_verified_at = ? WHERE id = ?`).run(nowMs, id);
  }
  return { id, userId: row.user_id };
};

export const deleteSession = (db: Db, token: string | undefined): void => {
  if (!token) return;
  db.prepare(`DELETE FROM auth_session WHERE id = ?`).run(token.split(".")[0]!);
};

// ——— brute-force limit (§ 2.5.1): 5 tokens per username, 1 refilled per minute ———

const buckets = new Map<string, { tokens: number; lastRefill: number }>();
const RATE_MAX = 5;
const REFILL_PER_MIN = 1;

export const allowSignInAttempt = (clock: Clock, username: string): boolean => {
  const nowMs = clock.now().getTime();
  const bucket = buckets.get(username) ?? { tokens: RATE_MAX, lastRefill: nowMs };
  const refilled = Math.min(RATE_MAX, bucket.tokens + ((nowMs - bucket.lastRefill) / 60_000) * REFILL_PER_MIN);
  bucket.tokens = refilled;
  bucket.lastRefill = nowMs;
  if (bucket.tokens < 1) {
    buckets.set(username, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(username, bucket);
  return true;
};

// ——— demo users (2.3): seeded at server start; the mock world books for these ids. ———

export const seedDemoUsers = (db: Db, nowMs: number): void => {
  const insert = db.prepare(`INSERT OR IGNORE INTO user (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)`);
  for (const u of DEMO_USERS) {
    insert.run(u.id, u.username, hashPassword(u.password), nowMs);
  }
};