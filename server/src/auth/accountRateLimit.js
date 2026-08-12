/**
 * A second, account-keyed throttle for login and password-reset requests,
 * alongside — not instead of — the existing per-IP `authLimit` in
 * routes/auth.js.
 *
 * Per-IP alone doesn't bound a distributed attack against one target account:
 * ten attempts a minute per IP is nothing to an attacker with ten thousand
 * IPs, all aimed at the same email. This closes that gap.
 *
 * Deliberately NOT a lockout. A counter keyed on `user_id` after a successful
 * password check would work, but a counter keyed on the *submitted* email
 * (the only thing known before the password is checked) is itself a weapon —
 * anyone who knows a victim's email can lock them out by submitting wrong
 * passwords. So this throttles (slows, with an automatic decay) rather than
 * blocks outright, and the window is loose enough that a real user mistyping
 * their own password a few times never notices it.
 *
 * In-memory, matching @fastify/rate-limit's own default store — this already
 * doesn't survive a restart or span replicas, same as the IP-based limiter it
 * sits alongside. A shared store (Redis, same as that plugin supports) is the
 * upgrade path if this ever runs on more than one instance.
 */

const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 15;

const attempts = new Map(); // normalized email -> { count, windowStart }

/**
 * Records one attempt for `email` and reports whether this request should be
 * throttled. Call once per request, before doing any real work for it.
 */
export function shouldThrottle(email) {
  const key = String(email ?? '').trim().toLowerCase();
  if (!key) return false; // malformed body — zod rejects it anyway, nothing to key on

  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    attempts.set(key, { count: 1, windowStart: now });
    return false;
  }

  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}

// Bounds the map's size against a scan of many distinct emails rather than a
// repeated hit on one — sweep expired windows periodically instead of on
// every read, so a quiet period doesn't leave stale entries around forever.
// unref() so this timer never keeps the process alive on its own.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (now - entry.windowStart >= WINDOW_MS) attempts.delete(key);
  }
}, WINDOW_MS).unref();
