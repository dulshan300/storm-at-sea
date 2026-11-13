// POST /api/match — each player reports the outcome of a finished battle.
// Body: { room, matchId, opponentId, won, shots, hits, maxCombo, id? (guest id), token? }
//
// The game is peer-to-peer, so the server can't see the shots. To keep the ladder honest-ish:
//  * both players must currently be in the room's presence channel (checked via Pusher),
//  * a match only settles once BOTH sides have reported and the reports agree (one winner),
//  * each player can report a given match once, and it settles exactly once.
// Rating (Elo) changes only when both players are signed-in accounts; career stats count every game.
import { allow, bearer, clientIp, fail, intIn, parseBody } from "./_lib/http.js";
import { presenceCount } from "./_lib/pusher.js";
import { ACCOUNT_ID_RE, GUEST_ID_RE, K, START_RATING, getRedis, pairsToObject, rateLimit, sessionUser } from "./_lib/redis.js";

const ROOM_RE = /^[A-Z0-9]{4,8}$/;
const MATCH_RE = /^[A-Z0-9]{4,8}-\d{1,5}-[a-z0-9]{6,64}$/;
const FLEET_CELLS = 17; // 5 + 4 + 3 + 3 + 2
const MATCH_TTL = 60 * 60 * 24;
const ELO_K = 32;
const MIN_RATING = 100;

export default async function handler(req, res) {
  if (!allow(req, res, ["POST"])) return;
  res.setHeader("Cache-Control", "no-store");
  const b = parseBody(req);
  try {
    if (!(await rateLimit("match", clientIp(req), 30, 60))) return fail(res, 429, "Slow down.");

    const room = String(b.room || "");
    const matchId = String(b.matchId || "");
    const opp = String(b.opponentId || "");
    if (!ROOM_RE.test(room) || !MATCH_RE.test(matchId) || !matchId.startsWith(room + "-")) return fail(res, 400, "Bad match id");
    if (!ACCOUNT_ID_RE.test(opp) && !GUEST_ID_RE.test(opp)) return fail(res, 400, "Bad opponent");

    const token = bearer(req, b);
    const me = token ? await sessionUser(token) : (GUEST_ID_RE.test(String(b.id || "")) ? String(b.id) : null);
    if (!me) return fail(res, 401, "Session expired.");
    if (me === opp) return fail(res, 400, "Bad opponent");

    const won = b.won === true;
    const { shots, hits, maxCombo } = b;
    const valid = intIn(shots, 0, 100) && intIn(hits, 0, FLEET_CELLS) && hits <= shots && intIn(maxCombo, 0, hits)
      && (won ? hits === FLEET_CELLS : hits < FLEET_CELLS);
    if (!valid) return fail(res, 400, "Implausible result");

    const members = await presenceCount("presence-room-" + room);
    if (!members) return fail(res, 503, "Couldn't verify the room. Try again.");
    if (!members.includes(me) || !members.includes(opp)) return fail(res, 403, "Both captains must be in the room.");

    const r = getRedis();
    const key = K.match(matchId, me, opp);
    const first = await r.hsetnx(key, me, [won ? 1 : 0, shots, hits, maxCombo].join("|"));
    await r.expire(key, MATCH_TTL);
    if (!first) return res.status(200).json({ status: "duplicate" });

    const reports = pairsToObject(await r.hgetall(key));
    if (!reports[me] || !reports[opp]) return res.status(200).json({ status: "pending" });

    // Both in: whoever grabs the lock settles.
    const lock = await r.set(key + ":done", "1", { nx: true, ex: MATCH_TTL });
    if (!lock) return res.status(200).json({ status: "settled" });

    const parse = (s) => { const [w, sh, h, c] = s.split("|").map(Number); return { won: w === 1, shots: sh, hits: h, combo: c }; };
    const a = parse(reports[me]), o = parse(reports[opp]);
    if (a.won === o.won) return res.status(200).json({ status: "disputed" });

    const result = await settle([{ id: me, ...a }, { id: opp, ...o }]);
    res.status(200).json({ status: "settled", ranked: result.ranked, delta: result.deltas[me] ?? 0 });
  } catch (e) {
    console.error("match error", e);
    return fail(res, 500, "Couldn't record the result.");
  }
}

async function settle(players) {
  const r = getRedis();
  // Load current account state (guests have none).
  for (const p of players) {
    p.account = false;
    if (!ACCOUNT_ID_RE.test(p.id)) continue;
    const [name, rating, best] = await r.hmget(K.user(p.id), "name", "rating", "bestCombo");
    if (!name) continue;
    p.account = true;
    p.rating = Number(rating) || START_RATING;
    p.best = Number(best) || 0;
  }

  const ranked = players.every((p) => p.account);
  const deltas = {};
  if (ranked) {
    const [w, l] = players[0].won ? players : [players[1], players[0]];
    const expected = 1 / (1 + 10 ** ((l.rating - w.rating) / 400));
    const d = Math.max(1, Math.round(ELO_K * (1 - expected)));
    deltas[w.id] = d;
    deltas[l.id] = -Math.min(d, l.rating - MIN_RATING);
  }

  if (!players.some((p) => p.account)) return { ranked, deltas };
  const tx = r.multi();
  for (const p of players) {
    if (!p.account) continue;
    const k = K.user(p.id);
    tx.hincrby(k, "games", 1);
    tx.hincrby(k, p.won ? "wins" : "losses", 1);
    tx.hincrby(k, "shots", p.shots);
    tx.hincrby(k, "hits", p.hits);
    if (p.combo > p.best) tx.hset(k, { bestCombo: p.combo });
    if (ranked) {
      const next = p.rating + deltas[p.id];
      tx.hincrby(k, p.won ? "rWins" : "rLosses", 1);
      tx.hset(k, { rating: next });
      tx.zadd(K.leaderboard, { score: next, member: p.id });
    }
  }
  await tx.exec();
  return { ranked, deltas };
}
