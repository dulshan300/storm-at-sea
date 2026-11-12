import { getPusher, presenceCount } from "./_lib/pusher.js";

const CHANNEL_RE = /^presence-room-[A-Z0-9]{4,8}$/;
const GUEST_ID_RE = /^g[a-z0-9]{8,31}$/;
const MAX_PLAYERS = 2;

function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return Object.fromEntries(new URLSearchParams(req.body));
  return {};
}

export function cleanName(v) {
  return String(v || "").replace(/[<>&"'`\\]/g, "").trim().slice(0, 16) || "Captain";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = parseBody(req);
  const socketId = String(body.socket_id || "");
  const channel = String(body.channel_name || "");
  const userId = String(body.user_id || "");
  const userInfo = { name: cleanName(body.name), verified: false };

  if (!socketId || !CHANNEL_RE.test(channel) || !GUEST_ID_RE.test(userId)) {
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
  if (ids && ids.length >= MAX_PLAYERS && !ids.includes(userId)) {
    return res.status(403).json({ error: "Room is full" });
  }

  res.status(200).json(pusher.authorizeChannel(socketId, channel, { user_id: userId, user_info: userInfo }));
}
