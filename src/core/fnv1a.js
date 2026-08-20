/**
 * FNV-1a, 32-bit. A handful of lines with no dependency and good avalanche on
 * short strings — a change detector and a content address, not a security
 * primitive.
 *
 * Extracted from stateHash.js so the vehicle builder can content-address a def
 * with the same arithmetic rather than introducing a second hash. The default
 * `seed` is FNV's own offset basis, so `fnv1a(s)` is byte-identical to what
 * stateHash.js computed before this was pulled out — lockstep hashes must not
 * move because of a refactor.
 *
 * `crypto.subtle` is deliberately not used here: it is async, and both callers
 * sit in synchronous paths (a per-tick hash, and a save handler).
 */
export function fnv1a(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // 32-bit FNV prime multiply, written as shifts so it stays in int range
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

const hex8 = (n) => n.toString(16).padStart(8, '0');

/**
 * 64 bits of FNV-1a as 16 hex characters, from two passes over differently
 * prefixed input with different offset bases.
 *
 * The prefix on the second pass is what decorrelates the two halves: a
 * different seed alone still walks the identical string, so the two accumulators
 * stay in step and a one-character edit moves both by related amounts. Shifting
 * the input by one character breaks that alignment.
 *
 * Comfortably enough to content-address vehicle defs — at any plausible number
 * of authored vehicles the collision probability is negligible, and a collision
 * means two defs share an id, not that anything is exploitable.
 */
export function fnv1a64(str) {
  return hex8(fnv1a(str)) + hex8(fnv1a('\u0001' + str, 0x01000193));
}
