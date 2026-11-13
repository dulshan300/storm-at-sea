import { Redis } from "@upstash/redis";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

let instance = null;

/** Upstash client. Accepts either Upstash's own env names or the KV_* names Vercel's integration sets. */
export function getRedis() {
  if (instance) return instance;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Missing Upstash Redis environment variables");
  // Raw strings everywhere: auto-deserialization would turn a username like "007" into the number 7.
  instance = new Redis({ url, token, automaticDeserialization: false });
  return instance;
}

// ---------- keys ----------
export const K = {
  name: (lower) => `fs:name:${lower}`, // -> user id
  user: (id) => `fs:u:${id}`, // hash: profile + stats
  session: (hash) => `fs:sess:${hash}`, // -> user id
  leaderboard: "fs:lb", // zset: rating
  queue: "fs:qm", // quick-match ticket "id|room"
  match: (matchId, a, b) => `fs:match:${matchId}:${[a, b].sort().join(":")}`,
  rate: (bucket, who) => `fs:rl:${bucket}:${who}`,
};

export const ACCOUNT_ID_RE = /^u[a-z0-9]{12}$/;
export const GUEST_ID_RE = /^g[a-z0-9]{8,31}$/;
export const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
export const START_RATING = 1000;
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

export const randomId = (prefix, len) => {
  const bytes = randomBytes(len);
  return prefix + Array.from(bytes, (b) => (b % 36).toString(36)).join("");
};

/** Fixed-window rate limit. Returns true when the caller is still under the limit. */
export async function rateLimit(bucket, who, limit, windowSec) {
  const r = getRedis();
  const key = K.rate(bucket, who);
  const n = await r.incr(key);
  if (n === 1) await r.expire(key, windowSec);
  return n <= limit;
}

// ---------- passwords ----------
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || "").split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

// ---------- sessions (only a hash of the token is stored) ----------
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");

export async function createSession(userId) {
  const token = randomBytes(32).toString("base64url");
  await getRedis().set(K.session(tokenHash(token)), userId, { ex: SESSION_TTL });
  return token;
}

export async function sessionUser(token) {
  if (!token || token.length > 100) return null;
  const id = await getRedis().get(K.session(tokenHash(token)));
  return id && ACCOUNT_ID_RE.test(id) ? id : null;
}

export async function endSession(token) {
  if (token) await getRedis().del(K.session(tokenHash(token)));
}

// ---------- profiles ----------
const NUM_FIELDS = ["rating", "games", "wins", "losses", "rWins", "rLosses", "shots", "hits", "bestCombo"];

export function pairsToObject(arr) {
  const o = {};
  for (let i = 0; i + 1 < (arr || []).length; i += 2) o[arr[i]] = arr[i + 1];
  return o;
}

/** Loads a user's stored hash (or null). Numeric fields are converted; the password hash is dropped. */
export async function loadUser(id) {
  if (!ACCOUNT_ID_RE.test(id)) return null;
  const raw = pairsToObject(await getRedis().hgetall(K.user(id)));
  if (!raw.name) return null;
  const u = { id, name: raw.name, created: Number(raw.created) || 0 };
  for (const f of NUM_FIELDS) u[f] = Number(raw[f]) || 0;
  if (!u.rating) u.rating = START_RATING;
  return u;
}

/** Public profile, with the player's leaderboard rank when they have played a ranked game. */
export async function publicProfile(id) {
  const u = await loadUser(id);
  if (!u) return null;
  const rank = await getRedis().zrevrank(K.leaderboard, id);
  return { ...u, rank: rank === null ? null : rank + 1 };
}
