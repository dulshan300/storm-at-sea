// Exposes the *public* Pusher key + cluster to the browser (never the secret).
export default function handler(req, res) {
  const { PUSHER_KEY, PUSHER_CLUSTER } = process.env;
  if (!PUSHER_KEY || !PUSHER_CLUSTER) {
    return res.status(500).json({ error: "Server is missing PUSHER_KEY / PUSHER_CLUSTER" });
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ key: PUSHER_KEY, cluster: PUSHER_CLUSTER });
}
