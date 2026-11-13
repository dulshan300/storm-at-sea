// GET /api/leaderboard — top ranked captains (ranked = account vs account games).
// With `Authorization: Bearer <token>` the caller's own row is flagged / appended.
import { allow, bearer, fail } from "./_lib/http.js";
import { K, getRedis, publicProfile, sessionUser } from "./_lib/redis.js";

const TOP = 20;

export default async function handler(req, res) {
  if (!allow(req, res, ["GET"])) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    const r = getRedis();
    const flat = await r.zrange(K.leaderboard, 0, TOP - 1, { rev: true, withScores: true });
    const ids = [];
    for (let i = 0; i < flat.length; i += 2) ids.push(flat[i]);

    let rows = [];
    if (ids.length) {
      const p = r.pipeline();
      ids.forEach((id) => p.hmget(K.user(id), "name", "rating", "rWins", "rLosses"));
      const info = await p.exec();
      rows = ids.map((id, i) => {
        const [name, rating, w, l] = info[i] || [];
        return { id, rank: i + 1, name: name || "Unknown", rating: Number(rating) || 0, w: Number(w) || 0, l: Number(l) || 0 };
      });
    }

    const myId = await sessionUser(bearer(req));
    let me = null;
    if (myId) {
      const p = await publicProfile(myId);
      if (p) me = { rank: p.rank, name: p.name, rating: p.rating, w: p.rWins, l: p.rLosses };
    }
    // Never expose internal ids; just flag the caller's own row.
    res.status(200).json({
      top: rows.map(({ id, ...row }) => ({ ...row, you: id === myId })),
      me,
    });
  } catch (e) {
    console.error("leaderboard error", e);
    return fail(res, 500, "Leaderboard unavailable.");
  }
}
