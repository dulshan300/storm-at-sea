// POST /api/account  { action: "register" | "login" | "logout" | "me", name?, password? }
// Auth for "me"/"logout": `Authorization: Bearer <token>`.
import { allow, bearer, clientIp, fail, parseBody } from "./_lib/http.js";
import {
  K, START_RATING, USERNAME_RE, createSession, endSession, getRedis, hashPassword,
  publicProfile, randomId, rateLimit, sessionUser, verifyPassword,
} from "./_lib/redis.js";

const DUMMY_HASH = `${"00".repeat(16)}:${"00".repeat(64)}`; // same scrypt cost as a real hash

export default async function handler(req, res) {
  if (!allow(req, res, ["POST"])) return;
  res.setHeader("Cache-Control", "no-store");
  const body = parseBody(req);
  const action = String(body.action || "");
  try {
    if (action === "register") return await register(req, res, body);
    if (action === "login") return await login(req, res, body);
    if (action === "me") return await me(req, res, body);
    if (action === "logout") {
      await endSession(bearer(req, body));
      return res.status(200).json({ ok: true });
    }
    return fail(res, 400, "Unknown action");
  } catch (e) {
    console.error("account error", e);
    return fail(res, 500, "Server error. Try again shortly.");
  }
}

function readCredentials(body) {
  const name = String(body.name || "").trim();
  const password = String(body.password || "");
  if (!USERNAME_RE.test(name)) return { error: "Names are 3–16 letters, numbers or underscores." };
  if (password.length < 6 || password.length > 72) return { error: "Passwords are 6–72 characters." };
  return { name, password };
}

async function register(req, res, body) {
  const c = readCredentials(body);
  if (c.error) return fail(res, 400, c.error);
  if (!(await rateLimit("reg", clientIp(req), 5, 3600))) return fail(res, 429, "Too many new accounts. Try again later.");

  const r = getRedis();
  const id = randomId("u", 12);
  const claimed = await r.set(K.name(c.name.toLowerCase()), id, { nx: true });
  if (!claimed) return fail(res, 409, "That name is already taken.");

  await r.hset(K.user(id), {
    name: c.name,
    pw: await hashPassword(c.password),
    created: Date.now(),
    rating: START_RATING,
    games: 0, wins: 0, losses: 0, rWins: 0, rLosses: 0, shots: 0, hits: 0, bestCombo: 0,
  });
  const token = await createSession(id);
  res.status(201).json({ token, profile: await publicProfile(id) });
}

async function login(req, res, body) {
  const c = readCredentials(body);
  if (c.error) return fail(res, 401, "Wrong name or password.");
  const lower = c.name.toLowerCase();
  if (!(await rateLimit("login", `${clientIp(req)}:${lower}`, 10, 600))) {
    return fail(res, 429, "Too many attempts. Wait a few minutes.");
  }

  const r = getRedis();
  const id = await r.get(K.name(lower));
  const stored = id ? await r.hget(K.user(id), "pw") : null;
  // Still run scrypt for unknown names so response timing doesn't reveal which names exist.
  const ok = await verifyPassword(c.password, stored || DUMMY_HASH);
  if (!id || !stored || !ok) return fail(res, 401, "Wrong name or password.");

  const token = await createSession(id);
  res.status(200).json({ token, profile: await publicProfile(id) });
}

async function me(req, res, body) {
  const id = await sessionUser(bearer(req, body));
  const profile = id && (await publicProfile(id));
  if (!profile) return fail(res, 401, "Session expired. Sign in again.");
  res.status(200).json({ profile });
}
