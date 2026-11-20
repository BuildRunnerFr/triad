import{a as v,j as te}from"./vendor-motion-CG_XcREl.js";const L=24,ie=36,fe=`
uniform vec2 u_res;
uniform float u_dpr;
uniform float u_time;
uniform vec3 u_mouse;      // xy : position en px (repère gl), z : intensité du survol 0..1
uniform vec3 u_ink;
uniform float u_inkAlpha;
uniform vec3 u_rupture;
uniform vec4 u_wells[${L}]; // xy : position uv, z : profondeur, w : critique (1/0)
uniform float u_count;

const float TAU = 6.28318530718;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = rot * p * 2.03 + 17.1;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  float aspect = u_res.x / u_res.y;
  vec2 p = (frag / u_res - 0.5) * vec2(aspect, 1.0);

  // Respiration : la dérive du bruit décrit un cercle lent (boucle parfaite, période ≥ 20 s).
  float phase = u_time * TAU / ${ie.toFixed(1)};
  vec2 drift = vec2(cos(phase), sin(phase)) * 0.22;
  float breath = 1.0 + 0.06 * sin(phase * 2.0);

  float h = fbm(p * 1.35 + drift) * 0.9;
  for (int i = 0; i < ${L}; i++) {
    if (float(i) >= u_count) break;
    vec4 w = u_wells[i];
    vec2 c = (w.xy - 0.5) * vec2(aspect, 1.0);
    float r = 0.07 + 0.11 * w.z;
    vec2 d = p - c;
    h -= w.z * 0.55 * breath * exp(-dot(d, d) / (r * r));
  }

  // Loupe de géomètre : les isolignes se resserrent autour du curseur.
  vec2 dm = (frag - u_mouse.xy) / u_res.y;
  float lens = u_mouse.z * exp(-dot(dm, dm) / 0.035);
  float levels = 11.0 * (1.0 + 0.85 * lens);

  float v = h * levels;
  float fw = max(fwidth(v), 1e-4);
  float dist = abs(fract(v - 0.5) - 0.5) / fw;   // distance à l'isoligne, en px écran
  float idx = floor(v + 0.5);
  float master = 1.0 - step(0.5, abs(mod(idx, 5.0)));
  float halfWidth = mix(0.5, 0.8, master) * u_dpr;
  float line = 1.0 - smoothstep(halfWidth - 0.5, halfWidth + 0.75, dist);
  float alpha = line * u_inkAlpha * mix(0.75, 1.25, master);

  // Fond des puits critiques : un point vermillon minuscule.
  float dotA = 0.0;
  for (int i = 0; i < ${L}; i++) {
    if (float(i) >= u_count) break;
    vec4 w = u_wells[i];
    float dpx = length(frag - w.xy * u_res);
    float rr = 1.6 * u_dpr;
    dotA = max(dotA, w.w * (1.0 - smoothstep(rr - 0.75, rr + 0.75, dpx)));
  }

  vec3 col = mix(u_ink, u_rupture, dotA);
  float a = max(alpha, dotA * 0.9);
  FRAG_OUT = vec4(col * a, a);
}
`,de="attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }",me=`#version 300 es
in vec2 a_pos; void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }`,pe=`#extension GL_OES_standard_derivatives : enable
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
#define FRAG_OUT gl_FragColor
`,he=`#version 300 es
precision highp float;
out vec4 fragColor;
#define FRAG_OUT fragColor
`;function ve(r){let i=2166136261;for(let o=0;o<r.length;o++)i^=r.charCodeAt(o),i=Math.imul(i,16777619);return i>>>0}function _e(r){let i=ve(r);const o=()=>{i=i+1831565813>>>0;let n=i;return n=Math.imul(n^n>>>15,n|1),n^=n+Math.imul(n^n>>>7,n|61),((n^n>>>14)>>>0)/4294967296};return[o(),o()]}function re(r){const i=r.match(/rgba?\(([^)]+)\)/);if(!i)return null;const o=i[1].split(/[\s,/]+/).filter(Boolean).map(Number);return o.length<3||o.some(n=>Number.isNaN(n))?null:[o[0]/255,o[1]/255,o[2]/255,o.length>3?o[3]:1]}function ne(r){r.style.color="var(--border-strong)";const i=re(getComputedStyle(r).color)??[.08,.1,.09,.24];r.style.color="var(--rupture)";const o=re(getComputedStyle(r).color)??[.7,.18,.09,1];return{ink:[i[0],i[1],i[2]],inkAlpha:Math.min(.4,Math.max(.12,i[3]*.85)),rupture:[o[0],o[1],o[2]]}}function oe(r,i,o){const n=r.createShader(i);return n?(r.shaderSource(n,o),r.compileShader(n),!r.getShaderParameter(n,r.COMPILE_STATUS)&&!r.isContextLost()?(console.warn("[TruthContourField]",r.getShaderInfoLog(n)),r.deleteShader(n),null):n):null}const xe=({wells:r,className:i,style:o})=>{const n=v.useRef(null),P=v.useRef(null),I=v.useRef(r),y=v.useRef(!0),k=v.useRef(()=>{});return v.useEffect(()=>{I.current=r,y.current=!0,k.current()},[r]),v.useEffect(()=>{const d=n.current,a=P.current;if(!d||!a)return;const T=window.matchMedia("(prefers-reduced-motion: reduce)");let h=T.matches;const O={alpha:!0,antialias:!1,depth:!1,stencil:!1,premultipliedAlpha:!0,preserveDrawingBuffer:!1,powerPreference:"low-power"};let f=null,B=!1;try{f=a.getContext("webgl2",O),B=!!f,f||(f=a.getContext("webgl",O),f&&!f.getExtension("OES_standard_derivatives")&&(f=null))}catch{f=null}if(!f){d.style.display="none";return}const e=f,_=document.createElement("span");_.style.display="none",d.appendChild(_);let g=null,x=null,F=[],c={},m=ne(_);const E=new Float32Array(L*4);let D=0;const ae=()=>{const t=I.current.slice(0,L);E.fill(0),t.forEach((s,u)=>{const[M,ce]=_e(s.id);E[u*4]=.3+M*.64,E[u*4+1]=.16+ce*.7,E[u*4+2]=Math.max(0,Math.min(1,s.depth)),E[u*4+3]=s.critical?1:0}),D=t.length,y.current=!1},W=()=>{const t=oe(e,e.VERTEX_SHADER,B?me:de),s=oe(e,e.FRAGMENT_SHADER,(B?he:pe)+fe);if(!t||!s)return!1;const u=e.createProgram();if(!u||(e.attachShader(u,t),e.attachShader(u,s),e.bindAttribLocation(u,0,"a_pos"),e.linkProgram(u),!e.getProgramParameter(u,e.LINK_STATUS)))return!1;g=u,F=[t,s],x=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,x),e.bufferData(e.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),e.STATIC_DRAW),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0),e.useProgram(u),c={};for(const M of["u_res","u_dpr","u_time","u_mouse","u_ink","u_inkAlpha","u_rupture","u_wells","u_count"])c[M]=e.getUniformLocation(u,M);return e.disable(e.DEPTH_TEST),e.clearColor(0,0,0,0),y.current=!0,!0},N=()=>{e.isContextLost()||(x&&e.deleteBuffer(x),g&&e.deleteProgram(g),F.forEach(t=>e.deleteShader(t)),x=null,g=null,F=[])};if(!W()){N(),_.remove(),d.style.display="none";return}let w=1;const U=()=>{w=Math.min(window.devicePixelRatio||1,2);const t=Math.max(1,Math.round(a.clientWidth*w)),s=Math.max(1,Math.round(a.clientHeight*w));(a.width!==t||a.height!==s)&&(a.width=t,a.height=s),p()},C=d.parentElement??d,l={x:0,y:0,target:0,value:0},H=t=>{if(t.pointerType==="touch"||h)return;const s=a.getBoundingClientRect();l.x=(t.clientX-s.left)*w,l.y=(s.bottom-t.clientY)*w,l.target=1,p()},z=()=>{l.target=0,p()};C.addEventListener("pointermove",H,{passive:!0}),C.addEventListener("pointerleave",z);let A=0,S=!0,G=performance.now(),q=0,V=0;const se=ie*.2,b=()=>{!g||e.isContextLost()||(y.current&&ae(),e.viewport(0,0,a.width,a.height),e.clear(e.COLOR_BUFFER_BIT),e.uniform2f(c.u_res,a.width,a.height),e.uniform1f(c.u_dpr,w),e.uniform1f(c.u_time,h?se:q),e.uniform3f(c.u_mouse,l.x,l.y,h?0:l.value),e.uniform3f(c.u_ink,m.ink[0],m.ink[1],m.ink[2]),e.uniform1f(c.u_inkAlpha,m.inkAlpha),e.uniform3f(c.u_rupture,m.rupture[0],m.rupture[1],m.rupture[2]),e.uniform4fv(c.u_wells,E),e.uniform1f(c.u_count,D),e.drawArrays(e.TRIANGLES,0,3))},le=t=>{A=0;const s=Math.min(.1,(t-G)/1e3);G=t,q+=s,l.value+=(l.target-l.value)*(1-Math.exp(-s*7)),(Math.abs(l.target-l.value)>.002||l.target>0||t-V>=33)&&(b(),V=t),j()},j=()=>{A||h||!S||document.hidden||(A=requestAnimationFrame(le))};function p(){if(h||!S||document.hidden){b();return}G=performance.now(),j()}k.current=p;const R=()=>{A&&cancelAnimationFrame(A),A=0},Y=new ResizeObserver(U);Y.observe(a);const $=new IntersectionObserver(t=>{var s;S=((s=t[t.length-1])==null?void 0:s.isIntersecting)??!0,S?p():R()},{rootMargin:"80px"});$.observe(d);const X=()=>{document.hidden?R():p()};document.addEventListener("visibilitychange",X);const K=()=>{h=T.matches,h?(R(),l.value=0,l.target=0,b()):p()};T.addEventListener("change",K);const ue=()=>{m=ne(_),b()},Q=new MutationObserver(ue),J=new Set([document.documentElement]);for(let t=d.parentElement;t;t=t.parentElement)t.hasAttribute("data-theme")&&J.add(t);J.forEach(t=>Q.observe(t,{attributes:!0,attributeFilter:["data-theme"]}));const Z=t=>{t.preventDefault(),R(),g=null,x=null,F=[]},ee=()=>{W()&&p()};return a.addEventListener("webglcontextlost",Z),a.addEventListener("webglcontextrestored",ee),U(),b(),()=>{var t;R(),k.current=()=>{},Y.disconnect(),$.disconnect(),Q.disconnect(),document.removeEventListener("visibilitychange",X),T.removeEventListener("change",K),C.removeEventListener("pointermove",H),C.removeEventListener("pointerleave",z),a.removeEventListener("webglcontextlost",Z),a.removeEventListener("webglcontextrestored",ee),N(),(t=e.getExtension("WEBGL_lose_context"))==null||t.loseContext(),_.remove()}},[]),te.jsx("div",{ref:n,"aria-hidden":"true",className:i,style:o,children:te.jsx("canvas",{ref:P,className:"block w-full h-full pointer-events-none"})})};export{xe as default};
