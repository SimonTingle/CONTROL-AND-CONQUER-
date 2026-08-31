/**
 * How a session credential is read off an incoming request.
 *
 * Split out from sessions.js and ws/match.js — both of which reach the
 * database — deliberately: these are pure string parsers, and keeping them
 * importable without `pg` is what lets `npm test` cover them at all. The same
 * reasoning already forced matchRoom.js out of ws/match.js; see that file's
 * header, and tests/match-client-protocol.test.mjs, which was silently dead
 * for a while because a constant was reached through a module that needed a
 * database driver.
 *
 * The cookie remains the primary mechanism and the only one the main site
 * uses. Everything here exists for genuinely cross-site clients — the itch.io
 * build, which browsers serve inside a third-party iframe on a different
 * registrable domain. Safari's ITP blocks that cookie outright and Chrome is
 * phasing third-party cookies out the same way; `SameSite=None` is not an
 * exemption. There a session cannot ride a cookie at all, so the client holds
 * the token itself and presents it explicitly.
 */

/** The marker a cross-site WebSocket client sends ahead of its token. */
export const WS_BEARER_PROTOCOL = 'ptg-bearer';

/**
 * The session token carried as `Authorization: Bearer <token>`, or null.
 *
 * The capture is greedy so a token is returned whole. Splitting on whitespace
 * would truncate a malformed-but-recoverable value to its first word and turn
 * a parse problem into a puzzling 401.
 */
export function bearerToken(req) {
  const header = req?.headers?.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * The session token a browser WebSocket smuggled through the subprotocol list.
 *
 * The browser WebSocket API cannot set an Authorization header, and the
 * obvious alternative — a query parameter — would write a live credential into
 * every access log the upgrade passes through (Fastify logs `req.url` on every
 * request). The subprotocol list is the one client-settable handshake header
 * that is not the URL, so the token goes there as `ptg-bearer, <token>`.
 *
 * A same-site client sends no subprotocol at all and gets null, which is the
 * point: it authenticates by cookie and this must stay out of its way.
 */
export function subprotocolToken(req) {
  const header = req?.headers?.['sec-websocket-protocol'];
  if (typeof header !== 'string') return null;
  const parts = header.split(',').map((s) => s.trim());
  return parts[0] === WS_BEARER_PROTOCOL && parts[1] ? parts[1] : null;
}
