// POST /api/quickmatch — a one-slot matchmaking queue.
// Body: { action: "join" | "heartbeat" | "cancel", room, id?, token? }
//
// Flow: a player first opens their own room, then calls "join" with that room code.
//  * If someone else is waiting, their ticket is consumed and we reply { role: "join", room: <theirs> }.
//  * Otherwise our ticket is stored (short TTL) and we reply { role: "host", room: <ours> };
//    the host sends "heartbeat" every few seconds to keep the ticket alive until a rival arrives.
import { allow, bearer, clientIp, fail, parseBody } from "./_lib/http.js";
import { GUEST_ID_RE, K, getRedis, rateLimit, sessionUser } from "./_lib/redis.js";

const ROOM_RE = /^[A-Z0-9]{4,8}$/;
const TICKET_TTL = 20; // seconds; hosts heartbeat every ~8s

// Atomically take someone else's ticket, or post ours. Ticket format: "<id>|<room>".
const JOIN_LUA = `
local cur = redis.call("GET", KEYS[1])
if cur then
  local sep = string.find(cur, "|", 1, true)
  if sep and string.sub(cur, 1, sep - 1) ~= ARGV[1] then
    redis.call("DEL", KEYS[1])
    return {"join", string.sub(cur, sep + 1)}
  end
end
redis.call("SET", KEYS[1], ARGV[1] .. "|" .. ARGV[2], "EX", tonumber(ARGV[3]))
return {"host", ARGV[2]}`;

// Refresh or remove our ticket only if it is still ours.
const HEARTBEAT_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2])) return 1 end
return 0`;
const CANCEL_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("DEL", KEYS[1]) return 1 end
return 0`;

export default async function handler(req, res) {
  if (!allow(req, res, ["POST"])) return;
  res.setHeader("Cache-Control", "no-store");
  const b = parseBody(req);
  try {
    const room = String(b.room || "").toUpperCase();
    if (!ROOM_RE.test(room)) return fail(res, 400, "Bad room");
    const token = bearer(req, b);
    const id = token ? await sessionUser(token) : (GUEST_ID_RE.test(String(b.id || "")) ? String(b.id) : null);
    if (!id) return fail(res, 401, "Session expired. Sign in again.");

    const r = getRedis();
    const ticket = `${id}|${room}`;
    switch (String(b.action || "")) {
      case "join": {
        if (!(await rateLimit("qm", clientIp(req), 30, 60))) return fail(res, 429, "Slow down, captain.");
        const [role, matchedRoom] = await r.eval(JOIN_LUA, [K.queue], [id, room, String(TICKET_TTL)]);
        return res.status(200).json({ role, room: matchedRoom });
      }
      case "heartbeat": {
        const alive = await r.eval(HEARTBEAT_LUA, [K.queue], [ticket, String(TICKET_TTL)]);
        return res.status(200).json({ waiting: Number(alive) === 1 });
      }
      case "cancel": {
        await r.eval(CANCEL_LUA, [K.queue], [ticket]);
        return res.status(200).json({ ok: true });
      }
      default:
        return fail(res, 400, "Unknown action");
    }
  } catch (e) {
    console.error("quickmatch error", e);
    return fail(res, 500, "Matchmaking unavailable.");
  }
}
