import * as THREE from 'three';
import { IS_MOBILE } from '../core/platform.js';

// Phase 3 of docs/performance-optimization-plan.md: octave counts below are
// literal integers baked into the compiled GLSL at JS build time (not
// uniforms), so branching here on IS_MOBILE produces a genuinely shorter
// shader per platform — the compiler dead-code-eliminates the unrolled loop
// iterations tg_fbm's `if (i >= octaves) break;` guard would otherwise skip
// at runtime.
const DETAIL_OCTAVES = IS_MOBILE ? 2 : 4;
const MACRO_OCTAVES = IS_MOBILE ? 2 : 3;
const STRATA_OCTAVES = IS_MOBILE ? 2 : 3;

/**
 * Terrain material built by *extending* MeshStandardMaterial rather than writing
 * a ShaderMaterial from scratch.
 *
 * The whole point: by injecting into Three's own shader chunks with
 * onBeforeCompile, the terrain still gets real PBR lighting, cascaded shadow
 * receiving, fog, tone mapping and colour-space handling for free. A bespoke
 * ShaderMaterial would mean reimplementing all of that by hand.
 *
 * Vertex stage   — displaces a flat grid by the heightmap texture and derives
 *                  the surface normal analytically from the same texture.
 * Fragment stage — height/slope splatting between sand, grass, rock and snow,
 *                  with procedural detail noise so there are no image assets.
 */

const GLSL_NOISE = /* glsl */ `
  // Cheap hash-based value noise. Not simplex, but this is close-up surface
  // detail only, and the fbm below hides the grid.
  float tg_hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float tg_valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = tg_hash(i);
    float b = tg_hash(i + vec2(1.0, 0.0));
    float c = tg_hash(i + vec2(0.0, 1.0));
    float d = tg_hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
  }

  float tg_fbm(vec2 p, int octaves) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 6; i++) {
      if (i >= octaves) break;
      sum += amp * tg_valueNoise(p);
      p *= 2.03;
      amp *= 0.5;
    }
    return sum;
  }
`;

/** Uniform block shared by the terrain material and its custom depth material. */
export function createTerrainUniforms(heightmap) {
  const p = heightmap.params;
  return {
    uHeightmap: { value: heightmap.texture },
    uMapSize: { value: p.size },
    uAmplitude: { value: p.amplitude },
    uTexel: { value: 1 / p.resolution },
    uSeaLevel: { value: p.seaLevel },

    uSandBand: { value: 0.035 },
    uSnowLine: { value: 0.62 },
    uSnowBlend: { value: 0.12 },
    uRockSlope: { value: 0.45 },
    uRockBlend: { value: 0.22 },

    uColorSand: { value: new THREE.Color('#c2b283') },
    uColorGrass: { value: new THREE.Color('#4f6b34') },
    uColorGrassDry: { value: new THREE.Color('#7c8a45') },
    uColorRock: { value: new THREE.Color('#6b6560') },
    uColorSnow: { value: new THREE.Color('#eef3f7') },

    uDetail: { value: 0.55 },
    uMacro: { value: 0.35 },

    // Buildability overlay — the seed of the RTS placement grid.
    uOverlay: { value: 0 },
    uOverlayMaxSlope: { value: 0.35 },
    uOverlayColor: { value: new THREE.Color('#2fd6a0') },

    // Construction pad. One pad is all Stage 1 can have, so plain uniforms
    // rather than a mask texture — the terraform's pad registry keeps what a
    // move to a mask would need.
    uPadCenter: { value: new THREE.Vector2(0, 0) },
    uPadRadius: { value: 0 }, // 0 = no pad
    uPadBlend: { value: 18 },
    uPadProgress: { value: 0 },
    uPadColor: { value: new THREE.Color('#7a828a') },

    // Tire tracks. Sits before the fog block below (world detail, not an
    // overlay) — see trackMask.js. The mask texture is assigned by World once
    // it owns one, same as the fog mask.
    uTrackMask: { value: null },
    uTrackTint: { value: new THREE.Color('#241f1a') },

    // Fog of war. The mask texture is assigned by World once it owns one.
    uFogMask: { value: null },
    uFogEnabled: { value: 1 },
    uFogDarken: { value: 0.3 },
    uFogDesat: { value: 0.8 },
    uFogTint: { value: new THREE.Color('#39435a') },
  };
}

// Displacement + analytic normals. Shared so the shadow pass deforms the terrain
// exactly the same way the colour pass does — otherwise self-shadowing is cast
// from a flat plane and the whole scene lights wrong.
const VERTEX_COMMON = /* glsl */ `
  uniform sampler2D uHeightmap;
  uniform float uMapSize;
  uniform float uAmplitude;
  uniform float uTexel;

  float tg_sampleH(vec2 worldXZ) {
    vec2 uv = worldXZ / uMapSize + 0.5;
    return texture2D(uHeightmap, clamp(uv, 0.0, 1.0)).r;
  }
`;

// Computes height and normal at the vertex. Declared as a function so both the
// normal hook and the position hook can use it, and so the depth shader — which
// has no <beginnormal_vertex> chunk at all — can call it from just one place.
const VERTEX_DISPLACE = /* glsl */ `
  vec2 tg_worldXZ = (modelMatrix * vec4(position, 1.0)).xz;
  float tg_hN = tg_sampleH(tg_worldXZ);

  float tg_step = uMapSize * uTexel;
  float tg_hL = tg_sampleH(tg_worldXZ - vec2(tg_step, 0.0));
  float tg_hR = tg_sampleH(tg_worldXZ + vec2(tg_step, 0.0));
  float tg_hD = tg_sampleH(tg_worldXZ - vec2(0.0, tg_step));
  float tg_hU = tg_sampleH(tg_worldXZ + vec2(0.0, tg_step));

  vec3 tg_normal = normalize(vec3(
    (tg_hL - tg_hR) * uAmplitude,
    2.0 * tg_step,
    (tg_hD - tg_hU) * uAmplitude
  ));
`;

const VERTEX_APPLY = /* glsl */ `
  transformed.y += tg_hN * uAmplitude;
  // Skirt vertices drop below the surface to plug cracks between LOD levels.
  transformed.y -= aSkirt * uAmplitude * 0.12;
`;

/**
 * @param {boolean} withNormals  true for the lit material (which has a
 *   <beginnormal_vertex> chunk), false for the depth material (which does not).
 */
function injectVertex(shader, withNormals) {
  const varyings = withNormals
    ? `varying vec3 vWorldPos;\nvarying float vHeightN;\nvarying float vSlope;`
    : '';
  const writeVaryings = withNormals
    ? `vHeightN = tg_hN;
       vSlope = 1.0 - clamp(tg_normal.y, 0.0, 1.0);
       vWorldPos = vec3(tg_worldXZ.x, tg_hN * uAmplitude, tg_worldXZ.y);`
    : '';

  shader.vertexShader = shader.vertexShader.replace(
    '#include <common>',
    `#include <common>\nattribute float aSkirt;\n${varyings}\n${VERTEX_COMMON}`
  );

  if (withNormals) {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>\n${VERTEX_DISPLACE}\n${writeVaryings}\n  objectNormal = tg_normal;`
      )
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_APPLY}`);
  } else {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n${VERTEX_DISPLACE}\n${VERTEX_APPLY}`
    );
  }
}

export function createTerrainMaterial(heightmap, uniforms = createTerrainUniforms(heightmap)) {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1.0,
    metalness: 0.0,
    dithering: true,
  });

  material.userData.uniforms = uniforms;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    injectVertex(shader, true);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform float uSeaLevel;
        uniform float uSandBand;
        uniform float uSnowLine;
        uniform float uSnowBlend;
        uniform float uRockSlope;
        uniform float uRockBlend;
        uniform vec3 uColorSand;
        uniform vec3 uColorGrass;
        uniform vec3 uColorGrassDry;
        uniform vec3 uColorRock;
        uniform vec3 uColorSnow;
        uniform float uDetail;
        uniform float uMacro;
        uniform float uOverlay;
        uniform float uOverlayMaxSlope;
        uniform vec3 uOverlayColor;
        // uMapSize is declared in VERTEX_COMMON for the vertex stage; the
        // fragment stage is a separate compilation unit and needs its own.
        uniform float uMapSize;
        uniform vec2 uPadCenter;
        uniform float uPadRadius;
        uniform float uPadBlend;
        uniform float uPadProgress;
        uniform vec3 uPadColor;
        uniform sampler2D uTrackMask;
        uniform vec3 uTrackTint;
        uniform sampler2D uFogMask;
        uniform float uFogEnabled;
        uniform float uFogDarken;
        uniform float uFogDesat;
        uniform vec3 uFogTint;
        varying vec3 vWorldPos;
        varying float vHeightN;
        varying float vSlope;
        ${GLSL_NOISE}`
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        {
          // Fine grain, close up. Two scales so it holds together at any zoom.
          float detail = tg_fbm(vWorldPos.xz * 0.35, ${DETAIL_OCTAVES}) * uDetail;
          float macro  = tg_fbm(vWorldPos.xz * 0.012, ${MACRO_OCTAVES}) * uMacro;

          // Grass varies between lush and dry across the map so large flat
          // areas don't read as a single flat colour.
          vec3 grass = mix(uColorGrass, uColorGrassDry, clamp(macro * 1.5 + 0.5, 0.0, 1.0));

          // Rock gets its own stratified banding from the vertical coordinate.
          float strata = tg_fbm(vec2(vWorldPos.y * 0.6, vWorldPos.x * 0.05), ${STRATA_OCTAVES});
          vec3 rock = uColorRock * (0.82 + 0.28 * (strata + detail * 0.5));

          // 1. beach band just above the waterline
          float beach = 1.0 - smoothstep(uSeaLevel, uSeaLevel + uSandBand, vHeightN + detail * 0.01);
          vec3 col = mix(grass, uColorSand, beach);

          // 2. rock takes over on steep ground
          float rockMask = smoothstep(
            uRockSlope - uRockBlend,
            uRockSlope + uRockBlend,
            vSlope + detail * 0.06
          );
          col = mix(col, rock, rockMask);

          // 3. snow above the snow line, but it can't cling to cliffs
          float snowMask = smoothstep(
            uSnowLine - uSnowBlend,
            uSnowLine + uSnowBlend,
            vHeightN + detail * 0.02
          );
          snowMask *= 1.0 - smoothstep(0.45, 0.75, vSlope);
          col = mix(col, uColorSnow, snowMask);

          col *= 0.92 + 0.16 * (detail * 0.5 + 0.5);

          // Buildable-ground overlay for the future placement grid.
          if (uOverlay > 0.5) {
            float buildable = step(vSlope, uOverlayMaxSlope) * step(uSeaLevel + 0.005, vHeightN);
            vec2 g = abs(fract(vWorldPos.xz / 8.0) - 0.5);
            float grid = 1.0 - smoothstep(0.44, 0.5, max(g.x, g.y));
            col = mix(col, uOverlayColor, buildable * (0.18 + 0.35 * (1.0 - grid)));
          }

          // Construction pad: poured surface over the flattened disc. Sits
          // before the fog block so an unexplored pad is fogged like any other
          // ground — it is world geometry, not an overlay.
          if (uPadRadius > 0.0) {
            float padD = distance(vWorldPos.xz, uPadCenter);
            float padMask = (1.0 - smoothstep(uPadRadius, uPadRadius + uPadBlend, padD)) * uPadProgress;
            // Same 8-unit grid idiom as the buildability overlay, so the pad
            // reads as the same construction language.
            vec2 pg = abs(fract(vWorldPos.xz / 8.0) - 0.5);
            float pgrid = 1.0 - smoothstep(0.44, 0.5, max(pg.x, pg.y));
            vec3 padCol = uPadColor * (0.92 + 0.16 * detail);
            col = mix(col, mix(padCol * 0.78, padCol, pgrid), padMask * 0.94);
          }

          // Tire tracks: world detail like the pad above, so it sits before
          // the fog block — an unexplored track should still be dimmed by fog
          // like anything else, not painted on top of it.
          float trackMark = texture2D(uTrackMask, vWorldPos.xz / uMapSize + 0.5).r;
          if (trackMark > 0.0) {
            // 0.6 measured (GPU pixel readback) as too weak to read on screen
            // for anything short of a fully-saturated (1.0) texel — a scout's
            // real intensity only shifted the rendered pixel by ~3%. 0.85
            // keeps the mark legible without fully overriding the terrain's
            // own detail/noise at low intensity.
            col = mix(col, uTrackTint, trackMark * 0.85);
          }

          // Fog of war. Applied to the albedo rather than to the final lit
          // colour, so unexplored ground keeps its normals, shadows and tone
          // mapping and only loses its colour — ridges stay legible, which is
          // what makes unexplored ground worth driving into. It also means a
          // headlight beam still lights fogged terrain dimly: that is the
          // reveal cue, not a leak.
          if (uFogEnabled > 0.5) {
            vec2 fogUv = clamp(vWorldPos.xz / uMapSize + 0.5, 0.0, 1.0);
            float seen = texture2D(uFogMask, fogUv).r;
            float unseen = 1.0 - smoothstep(0.25, 0.6, seen);
            float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
            vec3 neutral = mix(vec3(lum), uFogTint * (lum * 2.0), 0.5);
            col = mix(col, mix(col, neutral, uFogDesat) * uFogDarken, unseen);
          }

          diffuseColor.rgb *= col;
        }`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
        {
          float snowWet = smoothstep(uSnowLine, uSnowLine + uSnowBlend, vHeightN);
          float wetSand = 1.0 - smoothstep(uSeaLevel, uSeaLevel + uSandBand * 0.6, vHeightN);
          roughnessFactor = mix(roughnessFactor, 0.62, snowWet);
          roughnessFactor = mix(roughnessFactor, 0.35, wetSand);
        }`
      );

    material.userData.shader = shader;
  };

  // Force a distinct program from any other MeshStandardMaterial in the scene.
  material.customProgramCacheKey = () => 'terrain-splat-v3';

  return material;
}

/**
 * Depth material for the shadow pass, using the identical displacement.
 * Without this the sun would cast shadows from a flat plane.
 */
export function createTerrainDepthMaterial(uniforms) {
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });

  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    injectVertex(shader, false);
  };

  depth.customProgramCacheKey = () => 'terrain-depth-v1';
  return depth;
}
