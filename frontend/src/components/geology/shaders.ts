/**
 * Shaders de la coupe géologique « Carottage ».
 * Rendu planche gravée : papier + litages à l'encre, faces ombrées à plat
 * (aucune lumière, aucun reflet), couleurs lues des variables CSS.
 */

const NOISE = /* glsl */ `
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * vnoise(p);
      p = p * 2.03 + vec2(1.7, 9.2);
      a *= 0.5;
    }
    return v;
  }
`;

export const STRATUM_VERTEX = /* glsl */ `
  varying vec3 vPos;
  varying vec3 vNormal;
  void main() {
    // Position de la géométrie (non décalée) : les litages suivent le bloc faillé.
    vPos = position;
    vNormal = normal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * uKind : 0 = Dit (sédiment fin, laminations serrées),
 *         1 = Écrit (bancs moyens, litage oblique discret),
 *         2 = Réel (roche-mère : bancs épais, grains, diaclases).
 */
export const STRATUM_FRAGMENT = /* glsl */ `
  uniform vec3 uPaper;
  uniform vec3 uTint;
  uniform vec3 uInk;
  uniform float uKind;
  uniform float uTintMix;
  uniform float uDark;
  varying vec3 vPos;
  varying vec3 vNormal;
  ${NOISE}

  float inkLine(float f, float width) {
    float d = min(fract(f), 1.0 - fract(f));
    float aa = fwidth(f) * 1.1;
    return 1.0 - smoothstep(width, width + aa, d);
  }

  void main() {
    vec3 n = normalize(vNormal);
    vec3 p = vPos;
    vec3 base = mix(uPaper, uTint, uTintMix);
    float ink = 0.0;
    float tone = 0.0;

    if (n.y > 0.5) {
      // Face supérieure : vue en plan, marbrure légère, aucune lamination.
      float m = fbm(p.xz * 0.9 + uKind * 3.1);
      tone = (m - 0.5) * 0.10;
      float contour = inkLine(m * 9.0, 0.012);
      ink = contour * 0.22;
    } else {
      // Faces de coupe : laminations gauchies par un fbm (lit naturel).
      vec2 h = (abs(n.z) > 0.5) ? vec2(p.x, p.z) : vec2(p.z, p.x);
      float warp = fbm(vec2(h.x * 0.32, p.y * 0.6 + uKind * 7.0));
      float freq = uKind < 0.5 ? 34.0 : (uKind < 1.5 ? 15.0 : 6.5);
      float amp = uKind < 0.5 ? 1.6 : (uKind < 1.5 ? 2.2 : 2.8);
      float f = p.y * freq + warp * amp + h.x * (uKind > 0.5 && uKind < 1.5 ? 0.18 : 0.0);
      float bed = vnoise(vec2(floor(f) * 3.7, 0.5));
      tone = (bed - 0.5) * (uKind < 0.5 ? 0.06 : 0.11);
      float w = uKind < 0.5 ? 0.035 : (uKind < 1.5 ? 0.03 : 0.022);
      // Les traits s'interrompent par endroits, comme une gravure.
      float gate = smoothstep(0.28, 0.52, fbm(vec2(h.x * 1.4, f * 0.35)));
      ink = inkLine(f, w) * gate * (uKind < 0.5 ? 0.38 : 0.5);

      if (uKind > 1.5) {
        // Roche-mère : grains et diaclases verticales.
        float g = vnoise(vec2(h.x, p.y) * 46.0);
        ink = max(ink, step(0.86, g) * 0.42);
        float joint = inkLine(h.x * 0.9 + fbm(vec2(p.y * 2.0, h.x)) * 0.6, 0.01);
        ink = max(ink, joint * 0.45 * step(0.5, vnoise(vec2(floor(h.x * 0.9 + 0.5) * 5.0, floor(f * 0.25)))));
      } else if (uKind < 0.5) {
        float g = vnoise(vec2(h.x, p.y) * 80.0);
        ink = max(ink, step(0.93, g) * 0.22);
      }
    }

    // Ombrage à plat par orientation de face (lumière de planche, en haut à gauche).
    float shade = n.y > 0.5 ? 1.0 : (abs(n.z) > 0.5 ? 0.93 : 0.84);
    if (n.y < -0.5) shade = 0.75;
    if (uDark > 0.5) shade = n.y > 0.5 ? 1.0 : (abs(n.z) > 0.5 ? 0.86 : 0.74);

    vec3 col = base * (1.0 + tone) * shade;
    col = mix(col, uInk, clamp(ink, 0.0, 1.0) * (uDark > 0.5 ? 0.55 : 0.62));
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Hachures : strate lacunaire (preuve absente) ou brèche de faille. */
export const HATCH_FRAGMENT = /* glsl */ `
  uniform vec3 uBg;
  uniform vec3 uLine;
  uniform float uDensity;
  uniform float uStrength;
  varying vec3 vPos;
  varying vec3 vNormal;

  void main() {
    vec3 n = normalize(vNormal);
    vec3 p = vPos;
    vec2 h = n.y > 0.5 ? p.xz : (abs(n.z) > 0.5 ? p.xy : p.zy);
    float f = (h.x + h.y) * uDensity;
    float d = min(fract(f), 1.0 - fract(f));
    float aa = fwidth(f) * 1.1;
    float line = 1.0 - smoothstep(0.08, 0.08 + aa, d);
    float shade = n.y > 0.5 ? 1.0 : (abs(n.z) > 0.5 ? 0.95 : 0.88);
    vec3 col = mix(uBg * shade, uLine, line * uStrength);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;
