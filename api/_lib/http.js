// Small request helpers shared by the API routes.

export function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { /* not JSON */ }
    return Object.fromEntries(new URLSearchParams(req.body));
  }
  return {};
}

export function bearer(req, body = {}) {
  const h = String(req.headers.authorization || "");
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  return typeof body.token === "string" ? body.token : "";
}

export function clientIp(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || String(req.headers["x-real-ip"] || "") || "unknown";
}

export function allow(req, res, methods) {
  if (methods.includes(req.method)) return true;
  res.setHeader("Allow", methods.join(", "));
  res.status(405).json({ error: "Method not allowed" });
  return false;
}

/** Sends a JSON error and returns false, so handlers can `return fail(res, 400, "...")`. */
export function fail(res, status, error) {
  res.status(status).json({ error });
  return false;
}

export const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
