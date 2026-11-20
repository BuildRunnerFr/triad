import * as THREE from 'three';

/*
 * Matériaux shader de la topologie (aucune texture : tout est procédural).
 * Chaque fragment shader se termine par les includes tonemapping/colorspace
 * pour que les couleurs CSS (converties en linéaire par THREE.Color) sortent
 * à la même valeur que sur les matériaux intégrés.
 */

const OUTPUT = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

const WORLD_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

/* Hexagone de la plateforme : sommet orienté vers +z (convention CylinderGeometry). */
const HEX_FN = /* glsl */ `
  float hexApothemDist(vec2 p) {
    float d = -1e9;
    for (int k = 0; k < 6; k++) {
      float a = radians(30.0 + 60.0 * float(k));
      d = max(d, dot(p, vec2(sin(a), cos(a))));
    }
    return d;
  }
`;

export interface ScanUniforms {
  uScanX: { value: number };
  uScanAlpha: { value: number };
}

/** Dessus de la plateforme : papier mat, grille gravée fine, trace du balayage. */
export function createPlatformTopMaterial(opts: {
  center: THREE.Vector2;
  radius: number;
}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uPaper: { value: new THREE.Color() },
      uInk: { value: new THREE.Color() },
      uReel: { value: new THREE.Color() },
      uGridStrength: { value: 1 },
      uCenter: { value: opts.center.clone() },
      uApothem: { value: opts.radius * Math.cos(Math.PI / 6) },
      uScanX: { value: -100 },
      uScanAlpha: { value: 0 },
    },
    vertexShader: WORLD_VERTEX,
    fragmentShader: /* glsl */ `
      uniform vec3 uPaper;
      uniform vec3 uInk;
      uniform vec3 uReel;
      uniform float uGridStrength;
      uniform vec2 uCenter;
      uniform float uApothem;
      uniform float uScanX;
      uniform float uScanAlpha;
      varying vec3 vWorld;
      ${HEX_FN}

      float gridLine(vec2 p, float spacing) {
        vec2 q = p / spacing;
        vec2 g = abs(fract(q - 0.5) - 0.5);
        vec2 w = fwidth(q);
        vec2 l = 1.0 - smoothstep(vec2(0.0), w * 1.15, g);
        return max(l.x, l.y);
      }

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      void main() {
        vec2 p = vWorld.xz - uCenter;
        float d = hexApothemDist(p) - uApothem; // < 0 à l'intérieur

        float minor = gridLine(p, 0.5);
        float major = gridLine(p, 2.0);
        float inner = smoothstep(0.0, 0.55, -d);
        float engrave = (minor * 0.05 + major * 0.075) * inner * uGridStrength;

        float fw = max(fwidth(d), 1e-4);
        float edge = 1.0 - smoothstep(0.0, fw * 1.4, abs(d + 0.17));

        vec3 col = uPaper;
        // grain de papier, à peine perceptible
        col += (hash(floor(vWorld.xz * 160.0)) - 0.5) * 0.010;
        // très léger assombrissement vers les bords de la feuille
        col = mix(col, uInk, smoothstep(-1.6, 0.0, d) * 0.018);
        col = mix(col, uInk, engrave + edge * 0.20);

        // trace du balayage : fine ligne au front, voile qui s'éteint derrière
        float dx = vWorld.x - uScanX;
        float front = exp(-pow(dx / 0.03, 2.0));
        float trail = dx < 0.0 ? exp(dx / 0.85) : 0.0;
        float scan = (front * 0.78 + trail * (0.045 + (minor + major) * 0.32)) * uScanAlpha;
        scan *= smoothstep(0.0, 0.08, -d);
        col = mix(col, uReel, clamp(scan, 0.0, 1.0));

        gl_FragColor = vec4(col, 1.0);
        ${OUTPUT}
      }
    `,
  });
}

/** Rideau vertical du balayage de sonde : dégradé doux, découpé à l'hexagone. */
export function createScanPlaneMaterial(opts: {
  center: THREE.Vector2;
  radius: number;
  floorY: number;
  height: number;
}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color() },
      uAlpha: { value: 0 },
      uStrength: { value: 0.3 },
      uCenter: { value: opts.center.clone() },
      uApothem: { value: opts.radius * Math.cos(Math.PI / 6) },
      uFloorY: { value: opts.floorY },
      uHeight: { value: opts.height },
    },
    vertexShader: WORLD_VERTEX,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uAlpha;
      uniform float uStrength;
      uniform vec2 uCenter;
      uniform float uApothem;
      uniform float uFloorY;
      uniform float uHeight;
      varying vec3 vWorld;
      ${HEX_FN}

      void main() {
        vec2 p = vWorld.xz - uCenter;
        float d = hexApothemDist(p) - uApothem;
        float mask = 1.0 - smoothstep(-0.35, 0.0, d);
        float h = clamp((vWorld.y - uFloorY) / uHeight, 0.0, 1.0);
        float body = pow(1.0 - h, 2.4);
        float base = exp(-h * 38.0) * 0.9;
        float a = (body * uStrength + base * 0.5) * mask * uAlpha;
        if (a < 0.002) discard;
        gl_FragColor = vec4(uColor, a);
        ${OUTPUT}
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Onde de fuite : anneaux concentriques qui s'étendent et s'estompent au sol. */
export function createLeakWaveMaterial(seed: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color() },
      uTime: { value: 0.35 + seed },
      uOpacity: { value: 1 },
    },
    vertexShader: WORLD_VERTEX,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uOpacity;
      varying vec2 vUv;

      void main() {
        float r = length(vUv - 0.5) * 2.0;
        if (r > 1.0) discard;
        float a = 0.0;
        for (int i = 0; i < 3; i++) {
          float ph = fract(uTime * 0.32 + float(i) / 3.0);
          float rr = 0.08 + ph * 0.92;
          float w = 0.018 + ph * 0.02;
          a += exp(-pow((r - rr) / w, 2.0)) * pow(1.0 - ph, 1.6) * 0.85;
        }
        // point d'ancrage du trait vertical
        a += exp(-pow(r / 0.045, 2.0)) * 0.9;
        // halo au sol très doux
        a += (1.0 - smoothstep(0.0, 0.55, r)) * 0.06;
        a *= uOpacity;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor, clamp(a, 0.0, 1.0));
        ${OUTPUT}
      }
    `,
    transparent: true,
    depthWrite: false,
  });
}

/** Fausse ombre de contact : disque radial, sans shadow map. */
export function createContactShadowMaterial(strength: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x000000) },
      uStrength: { value: strength },
      uOpacity: { value: 1 },
    },
    vertexShader: WORLD_VERTEX,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uStrength;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float a = exp(-r * r * 3.6) * (1.0 - smoothstep(0.8, 1.0, r));
        a *= uStrength * uOpacity;
        if (a < 0.002) discard;
        gl_FragColor = vec4(uColor, a);
        ${OUTPUT}
      }
    `,
    transparent: true,
    depthWrite: false,
  });
}

/** Lien courbe (TubeGeometry) : trait fin, plein ou pointillé, extrémités adoucies. */
export function createLinkMaterial(dashed: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color() },
      uOpacity: { value: 1 },
      uDash: { value: dashed ? 1 : 0 },
      uDashCount: { value: 26 },
    },
    vertexShader: WORLD_VERTEX,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uDash;
      uniform float uDashCount;
      varying vec2 vUv;
      void main() {
        float t = vUv.x;
        float a = uOpacity;
        a *= smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.95, 1.0, t));
        if (uDash > 0.5) a *= step(fract(t * uDashCount), 0.55);
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor, a);
        ${OUTPUT}
      }
    `,
    transparent: true,
    depthWrite: false,
  });
}

/** Particules de flux : points ronds doux, couleur/alpha/taille par particule. */
export function createFlowPointsMaterial(pixelRatio: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: pixelRatio },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aAlpha;
      attribute float aSize;
      uniform float uPixelRatio;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = aColor;
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPixelRatio * (9.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = (1.0 - smoothstep(0.22, 0.5, d)) * vAlpha;
        if (a < 0.01) discard;
        gl_FragColor = vec4(vColor, a);
        ${OUTPUT}
      }
    `,
    transparent: true,
    depthWrite: false,
  });
}
