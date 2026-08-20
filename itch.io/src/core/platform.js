/**
 * Coarse desktop/mobile split for perf-only decisions —
 * docs/performance-optimization-plan.md, Phase 1 onward. Never used for
 * feature gating, only GPU-cost knobs (pixel ratio, antialiasing, shadow
 * quality, shader complexity) where getting it wrong just means a
 * touch-capable laptop renders a bit more conservatively than it strictly
 * needs to, not a broken feature.
 *
 * `(pointer: coarse)` is the media-query signal browsers use to mean "the
 * *primary* input is imprecise" (touch) — it correctly excludes touch-screen
 * laptops whose primary input is still a trackpad/mouse, which a bare
 * touch-support check (`'ontouchstart' in window`) would not: those report
 * touch support even when the user is on a mouse.
 */
export const IS_MOBILE =
  typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
