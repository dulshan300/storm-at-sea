import Pusher from "pusher";

let instance = null;

export function getPusher() {
  if (instance) return instance;
  const { PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET, PUSHER_CLUSTER } = process.env;
  if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET || !PUSHER_CLUSTER) {
    throw new Error("Missing PUSHER_* environment variables");
  }
  instance = new Pusher({
    appId: PUSHER_APP_ID,
    key: PUSHER_KEY,
    secret: PUSHER_SECRET,
    cluster: PUSHER_CLUSTER,
    useTLS: true,
  });
  return instance;
}

/** Returns the number of users in a presence channel, or null if it can't be determined. */
export async function presenceCount(channel) {
  try {
    const r = await getPusher().get({ path: `/channels/${channel}/users` });
    if (r.status !== 200) return null;
    const { users = [] } = await r.json();
    return users.map((u) => u.id);
  } catch {
    return null;
  }
}
