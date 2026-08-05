import argon2 from 'argon2';

/**
 * Argon2id password hashing.
 *
 * argon2id (not argon2i or argon2d) is the variant the RFC recommends for
 * password storage: it resists both side-channel and GPU-cracking attacks,
 * where the other two each only resist one.
 *
 * The parameters are argon2's own defaults, which track current OWASP
 * guidance. They are deliberately not tuned down — hashing is *supposed* to
 * be slow, and the cost is paid once per login, not per request.
 */
const OPTIONS = { type: argon2.argon2id };

export function hashPassword(plain) {
  return argon2.hash(plain, OPTIONS);
}

export function verifyPassword(hash, plain) {
  return argon2.verify(hash, plain);
}

/**
 * A real argon2id hash of a value nobody can log in with, used to burn the
 * same CPU time on "no such user" as on "wrong password".
 *
 * Without it, a failed login for an unknown email returns almost instantly
 * while a wrong password for a *known* email takes the full hash duration —
 * a timing difference an attacker can measure to enumerate which email
 * addresses have accounts. Computed once at module load.
 */
let dummyHashPromise = null;
export function dummyVerify(plain) {
  dummyHashPromise ??= argon2.hash(
    // Not a credential — this string is never accepted anywhere, it exists
    // only so there is something well-formed to spend the CPU time on.
    'timing-equalisation-placeholder',
    OPTIONS
  );
  return dummyHashPromise
    .then((hash) => argon2.verify(hash, plain))
    .catch(() => false);
}
