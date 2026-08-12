/**
 * Bearer tokens (session tokens, password-reset tokens): generated here,
 * stored only as a hash.
 *
 * The raw token is 256 bits from Node's CSRNG — more entropy than the uuid v4
 * tokens this replaces (~122 bits) — encoded as base64url so it drops
 * straight into a cookie or a URL query string with no escaping. Only its
 * SHA-256 hash is ever written to the database: a token this random has
 * nothing for a slow, salted KDF (argon2/bcrypt) to defend against that a
 * fast hash doesn't already defend against, and a fast hash keeps every
 * session lookup a single indexed equality check. The point of hashing at all
 * is that a database read (a leaked backup, a misconfigured replica, an
 * unrelated SQL injection) should not hand over a usable bearer token.
 */

import { randomBytes, createHash } from 'node:crypto';

const TOKEN_BYTES = 32;

/** A fresh random token, and the hash of it that gets stored. */
export function newToken() {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest();
}

// base64url of 32 bytes is always 43 characters, no padding. Reject anything
// else before it reaches a hash+query — malformed input should fail on shape,
// not on a database round-trip.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function isWellFormedToken(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}
