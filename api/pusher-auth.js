import { parseBody } from "./_lib/http.js";
import { getPusher, presenceCount } from "./_lib/pusher.js";
import { GUEST_ID_RE, loadUser, sessionUser } from "./_lib/redis.js";

const CHANNEL_RE = /^presence-room-[A-Z0-9]{4,8}$/;
const MAX_PLAYERS = 2;

export function cleanName(v) {
  return String(v || "").replace(/[<>&"'`\\]/g, "").trim().slice(0, 16) || "Captain";
}

/** Signed-in players join under their account id with a verified name + rating; otherwise as a guest. */
async function resolveUser(body) {
  const token = String(body.token || "");
  if (token) {
    try {
      const id = await sessionUser(token);
      const user = id && (await loadUser(id));
      if (user) return { user_id: id, user_info: { name: user.name, verified: true, rating: user.rating } };
    } catch (e) {
      console.error("session lookup failed; joining as guest", e);
    }
  }
  const guestId = String(body.user_id || "");
  if (!GUEST_ID_RE.test(guestId)) return null;
  return { user_id: guestId, user_info: { name: cleanName(body.name), verified: false } };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = parseBody(req);
  const socketId = String(body.socket_id || "");
  const channel = String(body.channel_name || "");
  const presence = await resolveUser(body);

  if (!socketId || !CHANNEL_RE.test(channel) || !presence) {
    return res.status(400).json({ error: "Invalid auth request" });
  }

  let pusher;
  try {
    pusher = getPusher();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // Enforce 2 players per room (a reconnecting player with the same id is allowed back in).
  const ids = await presenceCount(channel);
  if (ids && ids.length >= MAX_PLAYERS && !ids.includes(presence.user_id)) {
    return res.status(403).json({ error: "Room is full" });
  }

  res.status(200).json(pusher.authorizeChannel(socketId, channel, presence));
}
