import * as THREE from 'three';

/**
 * Multiples of the map size the ocean spans. 12x a 1024 map puts the edge
 * 6144 units out, past the camera's 6000 far plane in every direction.
 */
const OCEAN_EXTENT = 12;

/**
 * Sea plane.
 *
 * Rather than a depth pre-pass, the shore blend reads the same heightmap the
 * terrain uses — the water already knows exactly how deep the ground is beneath
 * every fragment, for free. That gives shallow-to-deep colour and a soft shore
 * fade with no extra render target.
 */
export class Water {
  constructor(heightmap) {
    this.heightmap = heightmap;
    const p = heightmap.params;

    this.uniforms = {
      uTime: { value: 0 },
      uHeightmap: { value: heightmap.texture },
      uMapSize: { value: p.size },
      uAmplitude: { value: p.amplitude },
      uSeaLevel: { value: p.seaLevel },
      uShallow: { value: new THREE.Color('#3f8f96') },
      uDeep: { value: new THREE.Color('#0b2a44') },
      uWaveSpeed: { value: 0.35 },
      uWaveScale: { value: 0.06 },
      uWaveStrength: { value: 0.5 },
      uDepthFade: { value: 14.0 },
      // Shares the terrain's mask texture — assigned by World.
      uFogMask: { value: null },
      uFogEnabled: { value: 1 },
      uFogDarken: { value: 0.34 },
    };

    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.06,
      metalness: 0.1,
      transparent: true,
      depthWrite: false,
    });

    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vWorld;`)
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>\n vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
          uniform float uTime;
          uniform sampler2D uHeightmap;
          uniform float uMapSize;
          uniform float uAmplitude;
          uniform float uSeaLevel;
          uniform vec3 uShallow;
          uniform vec3 uDeep;
          uniform float uWaveSpeed;
          uniform float uWaveScale;
          uniform float uWaveStrength;
          uniform float uDepthFade;
          uniform sampler2D uFogMask;
          uniform float uFogEnabled;
          uniform float uFogDarken;
          varying vec3 vWorld;

          float w_hash(vec2 p) {
            p = fract(p * vec2(123.34, 456.21));
            p += dot(p, p + 45.32);
            return fract(p.x * p.y);
          }
          float w_noise(vec2 p) {
            vec2 i = floor(p); vec2 f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(w_hash(i), w_hash(i + vec2(1,0)), u.x),
                       mix(w_hash(i + vec2(0,1)), w_hash(i + vec2(1,1)), u.x), u.y);
          }
          // Two noise fields drifting in different directions read as moving water.
          float w_waves(vec2 p) {
            float t = uTime * uWaveSpeed;
            return w_noise(p + vec2(t, t * 0.6)) * 0.6
                 + w_noise(p * 2.1 - vec2(t * 0.8, t * 1.3)) * 0.4;
          }`
        )
        .replace(
          '#include <normal_fragment_begin>',
          /* glsl */ `#include <normal_fragment_begin>
          {
            vec2 wp = vWorld.xz * uWaveScale;
            float e = 0.35;
            float hx = w_waves(wp + vec2(e, 0.0)) - w_waves(wp - vec2(e, 0.0));
            float hz = w_waves(wp + vec2(0.0, e)) - w_waves(wp - vec2(0.0, e));
            normal = normalize(normal + vec3(-hx, 0.0, -hz) * uWaveStrength * 3.0);
          }`
        )
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
          {
            vec2 uv = clamp(vWorld.xz / uMapSize + 0.5, 0.0, 1.0);
            float groundY = texture2D(uHeightmap, uv).r * uAmplitude;
            float depth = max(0.0, vWorld.y - groundY);

            float t = clamp(depth / uDepthFade, 0.0, 1.0);
            diffuseColor.rgb *= mix(uShallow, uDeep, t);

            // Foam where the water meets the ground, wobbled by the wave field
            // so the shoreline isn't a clean contour.
            float foam = 1.0 - smoothstep(0.0, 1.6, depth - w_waves(vWorld.xz * uWaveScale * 3.0) * 0.9);

            // Fog of war, matching the terrain. Suppressing foam matters more
            // than the darkening here: an unfogged shoreline traces the whole
            // island outline and gives the map away before it is explored.
            float seen = 1.0;
            if (uFogEnabled > 0.5) {
              seen = smoothstep(0.25, 0.6, texture2D(uFogMask, uv).r);
              foam *= seen;
            }

            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.96, 0.98), foam * 0.65);
            diffuseColor.rgb *= mix(uFogDarken, 1.0, seen);

            // Fade out entirely at the waterline instead of ending on a hard edge.
            diffuseColor.a *= smoothstep(0.0, 0.6, depth) * mix(0.72, 0.94, t);
          }`
        );
    };

    this.material.customProgramCacheKey = () => 'water-v2';

    // The sea extends far past the map so its own edge is never the horizon.
    // At this size the half-extent is beyond the camera's far plane, so the
    // water is always clipped by the far plane instead of ending somewhere
    // visible — which holds up even if the player turns the fog right down.
    // Still 1x1 segments, so this costs two triangles no matter how big it is.
    const geometry = new THREE.PlaneGeometry(p.size * OCEAN_EXTENT, p.size * OCEAN_EXTENT, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'water';
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
    this.updateLevel();
  }

  updateLevel() {
    this.uniforms.uSeaLevel.value = this.heightmap.params.seaLevel;
    this.uniforms.uAmplitude.value = this.heightmap.params.amplitude;
    this.uniforms.uHeightmap.value = this.heightmap.texture;
    this.mesh.position.y = this.heightmap.seaLevelY;
  }

  update(dt) {
    this.uniforms.uTime.value += dt;
  }
}
