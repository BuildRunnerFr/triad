import{a as m,j as o}from"./vendor-motion-CG_XcREl.js";import{p as at}from"./gsap-Ce-hMFSv.js";import{W as it,e as ct,P as lt,d as Ge,C as X,L as ut,M as he,v as dt,G as Ke,g as Oe,R as pt,h as q,m as mt,V as xe,n as ft,r as ve,w as He,E as We,O as ht,x as xt,y as vt,i as gt,u as bt}from"./vendor-three-CrGRK8Px.js";import{g as ie}from"./vendor-gsap-Cofp9nqB.js";import{X as yt,I as wt}from"./vendor-ui-CQn-UeWc.js";const jt=`
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
`,Ve=`
  varying vec3 vPos;
  varying vec3 vNormal;
  void main() {
    // Position de la géométrie (non décalée) : les litages suivent le bloc faillé.
    vPos = position;
    vNormal = normal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`,Et=`
  uniform vec3 uPaper;
  uniform vec3 uTint;
  uniform vec3 uInk;
  uniform float uKind;
  uniform float uTintMix;
  uniform float uDark;
  varying vec3 vPos;
  varying vec3 vNormal;
  ${jt}

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
`,kt=`
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
`,be=["reel","ecrit","dit"],Je={dit:"Dit",ecrit:"Écrit",reel:"Réel"},Nt={dit:"entretiens",ecrit:"documents",reel:"configuration"},F=.72,qe=1.55,Ye=.7,K=2.6,Mt={critique:.46,haute:.34,moyenne:.22,faible:.14};function ye(r){return-1.5*F+r*F}function ce(r){if(!r)return[];const a=r.normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase(),i=[];return a.includes("dit")&&i.push("dit"),a.includes("ecrit")&&i.push("ecrit"),a.includes("reel")&&i.push("reel"),i.length===2?i:[]}function Qe(r,a){var i,l,v,p;return a==="dit"?!!((i=r.dit)!=null&&i.extrait):a==="ecrit"?!!((l=r.ecrit)!=null&&l.extrait):!!((v=r.reel)!=null&&v.constat||(p=r.reel)!=null&&p.ressource)}function Lt(r){const i=Math.max(1,r.length)*qe+2*Ye,l=-i/2,v=r.map((p,z)=>{const g=l+Ye+(z+.5)*qe,A=ce(p.contradiction),S=A.length?Mt[p.gravite]??.2:0,L=[0,0,0];if(A.length){const f=A.map(y=>be.indexOf(y)).sort(),w=f[0],j=f[1];for(let y=0;y<3;y++)y>=j?L[y]=S/2:y<=w&&(L[y]=-S/2)}const I=[];for(let f=0;f<2;f++){const w=ye(f)+F+L[f],j=ye(f+1)+L[f+1];j-w>.001&&I.push([w,j])}const $=be.map(f=>Qe(p,f));return{finding:p,x:g,rejet:S,shifts:L,present:$,gaps:I,pair:A}});return{length:i,x0:l,columns:v}}function O(r,a,i){const l=r.getPropertyValue(a).trim(),v=new X;return v.setStyle(/^#[0-9a-f]{3,8}$/i.test(l)?l.slice(0,7):i),v}function Ue(){const r=document.documentElement,a=r.getAttribute("data-theme")==="dark",i=getComputedStyle(r),l=O(i,a?"--bg-elevated":"--bg-surface",a?"#1A231E":"#FBFBF8"),v=O(i,"--text-primary",a?"#EEF2EE":"#141A16"),p=O(i,"--text-secondary",a?"#A9B5AD":"#46504A"),z=O(i,a?"--bg-surface":"--bg-canvas",a?"#121915":"#F2F3EF");return{dark:a,paper:l,ink:v,inkSoft:p,dit:O(i,"--dit","#2350B8"),ecrit:O(i,"--ecrit","#7A3A9E"),reel:O(i,"--reel","#286E0A"),rupture:O(i,"--rupture","#B32F16"),hatchBg:z}}const Xe={light:[.36,.36,.4],dark:[.26,.2,.15]};function Rt(r,a){const i=new it({antialias:!0,alpha:!0});i.setPixelRatio(Math.min(window.devicePixelRatio||1,2)),i.setClearColor(0,0);const l=i.domElement;l.setAttribute("aria-hidden","true"),l.style.display="block",l.style.width="100%",l.style.height="100%",l.style.touchAction="pan-y",r.appendChild(l);const v=new ct,p=new lt(26,1,.1,200),z=Lt(a.findings);let g=Ue();const A=be.map((e,n)=>new Ge({vertexShader:Ve,fragmentShader:Et,uniforms:{uPaper:{value:new X},uTint:{value:new X},uInk:{value:new X},uKind:{value:[2,1,0][n]},uTintMix:{value:.2},uDark:{value:0}}})),S=(e,n)=>new Ge({vertexShader:Ve,fragmentShader:kt,uniforms:{uBg:{value:new X},uLine:{value:new X},uDensity:{value:e},uStrength:{value:n}}}),L=S(9,.5),I=S(14,.85),$=new ut({transparent:!0,opacity:.42}),f=new he,w=new he,j=new he,y=new dt({dashSize:.07,gapSize:.06,transparent:!0,opacity:.7}),H=new he({transparent:!0,opacity:0,depthWrite:!1,colorWrite:!1}),le=()=>{const e=g.dark?Xe.dark:Xe.light,n=[g.reel,g.ecrit,g.dit];A.forEach((s,c)=>{s.uniforms.uPaper.value.copy(g.paper),s.uniforms.uTint.value.copy(n[c]),s.uniforms.uInk.value.copy(g.ink),s.uniforms.uTintMix.value=e[2-c],s.uniforms.uDark.value=g.dark?1:0}),L.uniforms.uBg.value.copy(g.hatchBg),L.uniforms.uLine.value.copy(g.inkSoft),I.uniforms.uBg.value.copy(g.hatchBg),I.uniforms.uLine.value.copy(g.rupture),$.color.copy(g.ink),f.color.copy(g.rupture),w.color.copy(g.inkSoft),j.color.copy(g.ink),y.color.copy(g.ink)};le();const W=[],T=e=>(W.push(e),e),_=new Ke;v.add(_);const Z=(e,n,s,c,b,E,x=!0)=>{const N=T(new ve(n-e,c-s,K));N.translate((e+n)/2,(s+c)/2,0);const ze=new q(N,E);if(ze.position.y=b,_.add(ze),x){const $e=new He(T(new We(N)),$);$e.position.y=b,_.add($e)}},{columns:d,x0:B,length:Y}=z,G=e=>e/2;for(let e=0;e<3;e++){const n=ye(e),s=n+F,c=[],b=x=>{const N=c[c.length-1];N&&Math.abs(N.shift-x.shift)<1e-6&&N.present===x.present?N.b=x.b:c.push({...x})},E=d.length>1?d[1].x-d[0].x:Y-1.4;b({a:B,b:d.length?d[0].x-G(E):B+Y,shift:0,present:!0}),d.forEach(x=>b({a:x.x-G(E),b:x.x+G(E),shift:x.shifts[e],present:x.present[e]})),d.length&&b({a:d[d.length-1].x+G(E),b:B+Y,shift:0,present:!0}),c.forEach(x=>Z(x.a,x.b,n,s,x.shift,x.present?A[e]:L))}const J=d.length>1?d[1].x-d[0].x:1.55,D=(e,n,s)=>{const b=new q(T(new ve(.024,s-n,.01)),f);b.position.set(e,(n+s)/2,K/2+.006),_.add(b)},Q=(e,n)=>{const s=new q(T(new ve(.024,.01,K)),f);s.position.set(e,n+.006,0),_.add(s)};d.forEach(e=>{if(!e.pair.length)return;const n=e.x-J/2,s=e.x+J/2;e.gaps.forEach(([E,x])=>Z(n,s,E,x,0,I,!1));const c=-1.5*F-e.rejet/2,b=1.5*F+e.rejet/2;D(n,c,b),D(s,c,b),Q(n,1.5*F+Math.max(0,e.shifts[2])),Q(s,1.5*F+Math.max(0,e.shifts[2]))});const V=e=>1.5*F+e.shifts[2],ee=.55,t=K/2-.42,u=T(new Oe(.035,.035,1,12)),h=T(new pt(.07,.11,32));h.rotateX(-Math.PI/2);const P=new Map,ue=[];d.forEach(e=>{const n=V(e)+ee,s=-1.5*F+e.shifts[0]+.05,c=new q(u,w);c.scale.y=n-s,c.position.set(e.x,(n+s)/2,t),_.add(c);const b=new q(h,w);b.position.set(e.x,V(e)+.004,t),_.add(b);const E=T(new mt().setFromPoints([new xe(e.x,s,K/2+.008),new xe(e.x,V(e),K/2+.008)])),x=new ft(E,y);x.computeLineDistances(),_.add(x);const N=new q(T(new ve(.62,n-s+.2,K+.1)),H);N.position.set(e.x,(n+s)/2,0),N.userData.id=e.finding.id,_.add(N),ue.push(N),P.set(e.finding.id,{rod:c,collar:b,col:e})});const k=new Ke;k.visible=!1,v.add(k);const te=be.map((e,n)=>{const s=T(new Oe(.17,.17,F*.98,36));return s.translate(0,ye(n)+F/2,0),s}).map((e,n)=>{const s=new q(e,A[n]),c=new He(T(new We(e,30)),$);return s.add(c),k.add(s),s}),de=new xe(0,.15,0),we=-.42,et=1.08;let U=20;const R=new ht(p,l);R.enablePan=!1,R.enableDamping=!1,R.rotateSpeed=.5,R.zoomSpeed=.6,R.minAzimuthAngle=we-.5,R.maxAzimuthAngle=we+.5,R.minPolarAngle=.72,R.maxPolarAngle=1.32,R.target.copy(de);const Ne=()=>{const e=Math.max(1,r.clientWidth),n=Math.max(1,r.clientHeight);i.setSize(e,n,!1),p.aspect=e/n;const s=xt.degToRad(p.fov),c=2*Math.atan(Math.tan(s/2)*p.aspect),b=(Y*.5+.9)/Math.tan(c/2),E=4.4/Math.tan(s/2),x=U;if(U=Math.max(b,E)*1.16,R.minDistance=U*.62,R.maxDistance=U*1.25,Me){const N=p.position.clone().sub(de).multiplyScalar(U/x);p.position.copy(de).add(N)}else{const N=new vt(U,et,we);p.position.setFromSpherical(N).add(de),Me=!0}p.updateProjectionMatrix(),R.update()};let Me=!1,ne=0,je=!0,pe=!0,Ee=!1;const tt=()=>{ne=0,!Ee&&(i.render(v,p),pe=!1,a.onFrame())},C=()=>{if(!Ee){if(!je||document.hidden){pe=!0;return}ne||(ne=requestAnimationFrame(tt))}};R.addEventListener("change",C);const Le=new IntersectionObserver(e=>{je=e.some(n=>n.isIntersecting),je&&pe&&C()});Le.observe(r);const Re=()=>{!document.hidden&&pe&&C()};document.addEventListener("visibilitychange",Re);const Ae=new ResizeObserver(()=>{Ne(),C()});Ae.observe(r),Ne();const Se=new bt,Pe=new gt,Ce=(e,n)=>{const s=l.getBoundingClientRect();Pe.set((e-s.left)/s.width*2-1,-((n-s.top)/s.height)*2+1),Se.setFromCamera(Pe,p);const c=Se.intersectObjects(ue,!1);return c.length?c[0].object.userData.id:null};let oe=null,se=0,me=null,fe=null;const Te=e=>{me=e,!se&&(se=requestAnimationFrame(()=>{if(se=0,!me||fe)return;const n=Ce(me.clientX,me.clientY);n!==oe&&a.onHover(n),l.style.cursor=n?"pointer":"grab"}))},Fe=()=>{oe&&a.onHover(null),l.style.cursor=""},_e=e=>{fe={x:e.clientX,y:e.clientY}},Be=e=>{const n=fe;fe=null,!(!n||Math.hypot(e.clientX-n.x,e.clientY-n.y)>5)&&a.onPick(Ce(e.clientX,e.clientY))};l.addEventListener("pointermove",Te),l.addEventListener("pointerleave",Fe),l.addEventListener("pointerdown",_e),l.addEventListener("pointerup",Be);const ke=e=>{oe=e,P.forEach((n,s)=>{const c=s===e||s===re;n.rod.material=c?j:w,n.collar.material=c?j:w,n.rod.scale.x=n.rod.scale.z=c?1.7:1}),C()};let re=null,M=null;const De=K/2+.3,nt=e=>{k.position.set(e.x,0,De),te.forEach((n,s)=>{n.position.y=e.shifts[s],n.material=e.present[s]?A[s]:L})},Ie=e=>1.5*F+e.rejet+1.15,ot=(e,n)=>{const s=P.get(e);if(!s)return;M==null||M.kill(),re=e;const c=s.col;if(nt(c),k.visible=!0,ke(oe),a.reducedMotion){k.position.y=Ie(c),te.forEach((b,E)=>b.position.y=c.shifts[E]+(E-1)*.1),C(),n();return}k.position.y=0,M=ie.timeline({onUpdate:C,onComplete:C}),M.to(k.position,{y:Ie(c),duration:.75,ease:"expo.out"},0),te.forEach((b,E)=>{M.to(b.position,{y:c.shifts[E]+(E-1)*.1,duration:.5,ease:"power3.out"},.18)}),M.call(n,void 0,.38)},st=()=>{if(!re)return;const e=P.get(re);if(re=null,ke(oe),M==null||M.kill(),!e||a.reducedMotion){k.visible=!1,C();return}const n=e.col;M=ie.timeline({onUpdate:C,onComplete:()=>{k.visible=!1,C()}}),te.forEach((s,c)=>M.to(s.position,{y:n.shifts[c],duration:.22,ease:"power2.in"},0)),M.to(k.position,{y:0,duration:.42,ease:"power2.in"},0)},ae=new xe,rt=(e,n)=>{const s=P.get(e);if(!s)return null;const c=s.col;return n==="tip"?ae.set(c.x,V(c)+ee+.1,t):ae.set(c.x,k.position.y+.4,De),ae.project(p),{x:(ae.x*.5+.5)*r.clientWidth,y:(-ae.y*.5+.5)*r.clientHeight}};return C(),{setTheme:()=>{g=Ue(),le(),C()},setHover:ke,extract:ot,retract:st,project:rt,dispose:()=>{Ee=!0,ne&&cancelAnimationFrame(ne),se&&cancelAnimationFrame(se),M==null||M.kill(),ie.killTweensOf(k.position),te.forEach(e=>ie.killTweensOf(e.position)),Le.disconnect(),Ae.disconnect(),document.removeEventListener("visibilitychange",Re),l.removeEventListener("pointermove",Te),l.removeEventListener("pointerleave",Fe),l.removeEventListener("pointerdown",_e),l.removeEventListener("pointerup",Be),R.removeEventListener("change",C),R.dispose(),W.forEach(e=>e.dispose()),[...A,L,I,$,f,w,j,y,H].forEach(e=>e.dispose()),i.dispose(),i.forceContextLoss(),l.remove()}}}function At(){try{const r=document.createElement("canvas");return!!(r.getContext("webgl2")||r.getContext("webgl"))}catch{return!1}}const St={conforme:"Conforme",partiel:"Partiel",non_conforme:"Non conforme",a_confirmer:"À confirmer"},Pt={critique:"critique",haute:"haute",moyenne:"moyenne",faible:"faible"},Ct={dit:"var(--dit)",ecrit:"var(--ecrit)",reel:"var(--reel)"};function Ze(r){const a=ce(r.contradiction),i=["dit","ecrit","reel"].filter(v=>!Qe(r,v)),l=[a.length?`faille ${r.contradiction}`:"couches continues"];return i.length&&l.push(`lacune ${i.map(v=>Je[v]).join(", ")}`),l.join(" · ")}const ge=({color:r,hatch:a})=>o.jsx("span",{"aria-hidden":"true",className:"inline-block w-4 h-2.5 rounded-[2px] border border-[var(--border-strong)]",style:a?{backgroundImage:`repeating-linear-gradient(135deg, ${r} 0 1px, transparent 1px 4px)`}:{background:`color-mix(in oklab, ${r} 30%, var(--bg-surface))`}}),Tt=({layer:r,finding:a})=>{let i="",l="";r==="dit"&&a.dit?(i=a.dit.source,l=a.dit.extrait):r==="ecrit"&&a.ecrit?(i=[a.ecrit.source,a.ecrit.section].filter(Boolean).join(" · "),l=a.ecrit.extrait):r==="reel"&&a.reel&&(i=a.reel.ressource,l=a.reel.constat);const p=ce(a.contradiction).includes(r);return o.jsxs("div",{className:"py-2.5 border-t border-hairline first:border-t-0",children:[o.jsxs("div",{className:"flex items-baseline justify-between gap-2",children:[o.jsxs("span",{className:"text-xs font-bold",style:{color:Ct[r]},children:[Je[r],o.jsxs("span",{className:"font-medium text-dim",children:[" · ",Nt[r]]})]}),p&&o.jsx("span",{className:"text-[11px] font-semibold text-[var(--rupture)]",children:"en faille"})]}),l?o.jsxs(o.Fragment,{children:[o.jsxs("p",{className:"mt-1 text-[13px] leading-snug text-main line-clamp-4",children:["« ",l," »"]}),i&&o.jsx("p",{className:`mt-1 text-[11px] text-dim truncate ${r==="reel"?"font-mono":""}`,title:i,children:i})]}):o.jsx("p",{className:"mt-1 text-[13px] text-dim italic",children:"Strate lacunaire : aucune preuve recueillie."})]})},$t=({findings:r,mode:a,theme:i,onInspectFinding:l})=>{const v=m.useRef(null),p=m.useRef(null),z=m.useRef(null),g=m.useRef(null),A=m.useRef(new Map),S=m.useRef(null),[L]=m.useState(()=>typeof document<"u"?At():!1),[I,$]=m.useState(!1),[f,w]=m.useState(null),[j,y]=m.useState(null),[H,le]=m.useState("right"),W=m.useMemo(()=>at(),[]),T=m.useRef(null);T.current=f;const _=m.useRef(null);_.current=j;const Z=m.useMemo(()=>new Map(r.map(t=>[t.id,t])),[r]),d=j?Z.get(j)??null:null,B=f?Z.get(f)??null:null,Y=r.map(t=>`${t.id}:${t.contradiction}:${t.gravite}`).join("|")+a,G=m.useCallback(()=>{const t=S.current;if(!t)return;A.current.forEach((P,ue)=>{const k=t.project(ue,"tip");k&&(P.style.transform=`translate(${k.x}px, ${k.y}px) translate(-50%, -100%)`)});const u=g.current,h=T.current;if(u&&h){const P=t.project(h,"tip");P&&(u.style.transform=`translate(${P.x}px, ${P.y-26}px) translate(-50%, -100%)`)}},[]),J=m.useCallback(t=>{const u=S.current,h=p.current;if(u&&h){const P=u.project(t,"core");le(P&&P.x>h.clientWidth*.55?"left":"right")}y(t)},[]),D=m.useCallback(t=>{const u=S.current;if(!t||t===_.current){u==null||u.retract(),y(null);return}u?(y(null),u.extract(t,()=>J(t))):y(t)},[J]),Q=m.useRef(D);Q.current=D,m.useEffect(()=>{const t=p.current;if(!t||!L)return;let u=null;try{u=Rt(t,{findings:r,reducedMotion:W,onHover:h=>w(h),onPick:h=>{h?Q.current(h):(u==null||u.retract(),y(null))},onFrame:()=>G()})}catch{$(!0);return}return S.current=u,()=>{S.current=null,u==null||u.dispose(),y(null),w(null)}},[Y,L,W]),m.useEffect(()=>{var t;(t=S.current)==null||t.setTheme()},[i]),m.useEffect(()=>{var t;(t=S.current)==null||t.setHover(f),G()},[f,G]),m.useLayoutEffect(()=>{const t=z.current;if(!t||!d||W)return;const u=H==="right"?"inset(0 100% 0 0)":"inset(0 0 0 100%)",h=ie.fromTo(t,{clipPath:u,x:H==="right"?-12:12},{clipPath:"inset(0 0% 0 0%)",x:0,duration:.42,ease:"expo.out",clearProps:"clipPath,transform"});return()=>{h.kill()}},[d,H,W]),m.useEffect(()=>{if(!j)return;const t=h=>{h.key==="Escape"&&D(null)},u=h=>{v.current&&!v.current.contains(h.target)&&D(null)};return window.addEventListener("keydown",t),document.addEventListener("pointerdown",u),()=>{window.removeEventListener("keydown",t),document.removeEventListener("pointerdown",u)}},[j,D]);const V=L&&!I,ee=r.filter(t=>ce(t.contradiction).length).length;return o.jsxs("div",{ref:v,className:"space-y-3",children:[o.jsxs("div",{className:"flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-1",children:[o.jsxs("h3",{className:"text-sm font-bold text-main",children:["Coupe des constats",o.jsxs("span",{className:"font-medium text-dim",children:[" ","· ",r.length," forages, ",ee," faille",ee>1?"s":""," · phase"," ",a==="AVANT"?"avant":"après"]})]}),o.jsxs("ul",{className:"flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-sub","aria-label":"Légende",children:[o.jsxs("li",{className:"inline-flex items-center gap-1.5",children:[o.jsx(ge,{color:"var(--dit)"}),"Dit · entretiens"]}),o.jsxs("li",{className:"inline-flex items-center gap-1.5",children:[o.jsx(ge,{color:"var(--ecrit)"}),"Écrit · documents"]}),o.jsxs("li",{className:"inline-flex items-center gap-1.5",children:[o.jsx(ge,{color:"var(--reel)"}),"Réel · configuration"]}),o.jsxs("li",{className:"inline-flex items-center gap-1.5",children:[o.jsx("span",{"aria-hidden":"true",className:"inline-block w-4 h-0 border-t-2 border-[var(--rupture)]"}),"faille = contradiction"]}),o.jsxs("li",{className:"inline-flex items-center gap-1.5",children:[o.jsx(ge,{color:"var(--text-secondary)",hatch:!0}),"lacune = preuve absente"]})]})]}),o.jsxs("div",{className:"relative",children:[V?o.jsxs("div",{ref:p,className:"relative h-[300px] sm:h-[440px] lg:h-[500px] rounded-xl overflow-hidden border border-hairline",style:{background:"var(--bg-canvas)"},children:[o.jsxs("div",{"aria-hidden":"true",className:"pointer-events-none absolute inset-0",children:[r.map(t=>o.jsx("span",{ref:u=>{u?A.current.set(t.id,u):A.current.delete(t.id)},className:`absolute left-0 top-0 font-mono text-[10.5px] tabular-nums whitespace-nowrap transition-colors ${t.id===f||t.id===j?"text-main font-bold":"text-sub"}`,children:t.id},t.id)),B&&B.id!==j&&o.jsxs("div",{ref:g,className:"absolute left-0 top-0 max-w-[240px] rounded-md px-2.5 py-1.5 surface-elevated border border-hairline shadow-[0_6px_18px_-8px_rgba(0,0,0,0.35)]",children:[o.jsx("p",{className:"font-mono text-[10.5px] text-dim",children:B.id}),o.jsx("p",{className:"text-xs font-semibold text-main leading-snug",children:B.theme}),B.contradiction&&o.jsx("p",{className:"text-[11px] text-[var(--rupture)] mt-0.5",children:B.contradiction})]})]}),o.jsx("p",{className:"pointer-events-none absolute left-3 bottom-2 text-[11px] text-dim",children:"Glisser pour orienter la coupe · cliquer un forage pour extraire la carotte"})]}):o.jsx("p",{className:"rounded-xl border border-hairline px-4 py-3 text-xs text-sub",children:"Rendu 3D indisponible sur ce poste : la coupe est décrite forage par forage ci-dessous."}),d&&o.jsxs("div",{ref:z,role:"dialog","aria-label":`Carotte ${d.id}`,className:`mt-3 sm:mt-0 sm:absolute sm:top-3 sm:w-[340px] sm:max-h-[calc(100%-24px)] overflow-auto rounded-xl surface-elevated border border-hairline shadow-[0_14px_36px_-18px_rgba(0,0,0,0.45)] ${H==="right"?"sm:right-3":"sm:left-3"}`,children:[o.jsxs("div",{className:"flex items-start justify-between gap-3 px-4 pt-3.5 pb-2",children:[o.jsxs("div",{className:"min-w-0",children:[o.jsxs("p",{className:"font-mono text-[11px] text-dim",children:["Carotte ",d.id,d.lot_nis2?` · ${d.lot_nis2}`:""]}),o.jsx("h4",{className:"text-sm font-bold text-main leading-snug",children:d.theme}),o.jsxs("p",{className:"mt-0.5 text-[11px] text-sub",children:[St[d.statut]," · gravité ",Pt[d.gravite],d.contradiction?o.jsxs("span",{className:"text-[var(--rupture)] font-semibold",children:[" · ",d.contradiction]}):" · couches alignées"]})]}),o.jsx("button",{type:"button",onClick:()=>D(null),"aria-label":"Redescendre la carotte",className:"shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-lg text-dim hover:text-main hover:bg-[var(--bg-hover)] cursor-pointer",children:o.jsx(yt,{className:"w-4 h-4"})})]}),o.jsx("div",{className:"px-4",children:["dit","ecrit","reel"].map(t=>o.jsx(Tt,{layer:t,finding:d},t))}),o.jsx("div",{className:"px-4 pb-4 pt-2",children:o.jsxs("button",{type:"button",onClick:()=>l(d),className:"w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-[var(--deloitte)] hover:bg-[var(--deloitte-hover)] text-black text-xs font-extrabold transition cursor-pointer",children:["Ouvrir le constat",o.jsx(wt,{className:"w-3.5 h-3.5"})]})})]})]}),o.jsx("ul",{className:"flex flex-wrap gap-1.5","aria-label":"Forages de la coupe",children:r.map(t=>{const u=ce(t.contradiction).length>0,h=t.id===j;return o.jsx("li",{children:o.jsxs("button",{type:"button","aria-pressed":h,"aria-label":`${t.id}, ${t.theme} : ${Ze(t)}. ${h?"Redescendre":"Extraire"} la carotte`,onClick:()=>D(t.id),onPointerEnter:()=>w(t.id),onPointerLeave:()=>w(null),onFocus:()=>w(t.id),onBlur:()=>w(null),className:`inline-flex items-center gap-2 min-h-[28px] px-2.5 py-1 rounded-lg border text-xs transition cursor-pointer ${h?"border-[var(--border-strong)] bg-[var(--bg-subtle)] text-main":"border-hairline text-sub hover:text-main hover:bg-[var(--bg-hover)]"}`,children:[o.jsx("span",{className:"font-mono text-[11px] tabular-nums",children:t.id}),o.jsx("span",{className:"max-w-[180px] truncate",children:t.theme}),u&&o.jsx("span",{"aria-hidden":"true",className:"inline-block w-2.5 h-0 border-t-2 border-[var(--rupture)]"})]})},t.id)})}),!V&&o.jsx("ol",{className:"space-y-1 text-xs text-sub",children:r.map(t=>o.jsxs("li",{children:[o.jsx("span",{className:"font-mono",children:t.id})," · ",t.theme," : ",Ze(t)]},t.id))})]})};export{$t as default};
