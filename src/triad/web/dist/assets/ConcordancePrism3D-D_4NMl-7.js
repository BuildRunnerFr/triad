import{a as R,j as M}from"./vendor-motion-CG_XcREl.js";import{W as ht,S as rt,e as yt,P as wt,H as gt,f as bt,d as Ze,C as j,i as ne,V as G,k as qe,h as F,m as xt,o as ve,D as kt,g as Rt,R as Ue,z as Je,M as ae,a as St,A as Ke,G as Qe,x as st,u as Et}from"./vendor-three-CrGRK8Px.js";const ge=4,he=ge*Math.sqrt(3)/2,k={dit:new G(-ge/2,0,-he/3),ecrit:new G(ge/2,0,-he/3),reel:new G(0,0,2*he/3)},L=[{key:"dit-ecrit",a:"dit",b:"ecrit",seed:3.1},{key:"ecrit-reel",a:"ecrit",b:"reel",seed:11.7},{key:"dit-reel",a:"dit",b:"reel",seed:23.9}],et={critique:.17,haute:.135,moyenne:.105,faible:.082},ye=.62,tt=26,ot=st.degToRad(50);function it(i){const n=((i==null?void 0:i.contradiction)||"").toLowerCase(),m=n.includes("dit"),p=n.includes("écrit"),v=n.includes("réel"),y=m&&p&&v;return{"dit-ecrit":y||m&&p&&!v,"dit-reel":y||m&&v&&!p,"ecrit-reel":y||p&&v&&!m}}function Mt(i){const n={dit:i.dit?1:.42,ecrit:i.ecrit?1:.42,reel:i.reel?1:.42},m=it(i);for(const p of L)m[p.key]&&(n[p.a]*=.4,n[p.b]*=.4);return n}function Tt(i){let n=2166136261;for(let m=0;m<i.length;m++)n^=i.charCodeAt(m),n=Math.imul(n,16777619);return(n>>>0)/4294967295}function At(i){const n=new Map;for(const v of i){const y=Mt(v),S=y.dit+y.ecrit+y.reel,T=new G().addScaledVector(k.dit,y.dit/S).addScaledVector(k.ecrit,y.ecrit/S).addScaledVector(k.reel,y.reel/S).multiplyScalar(.84);n.set(v.id,T)}const m=new Map;for(const v of i){const y=n.get(v.id),S=`${y.x.toFixed(2)}:${y.z.toFixed(2)}`,T=m.get(S)??[];T.push(v.id),m.set(S,T)}const p=new Map;for(const v of m.values()){v.sort();const y=v.length,S=Tt(v[0])*Math.PI*2;v.forEach((T,N)=>{const D=n.get(T).clone();if(y>1){const O=.24*Math.sqrt(N+.6),_=S+N*2.39996;D.x+=Math.cos(_)*O,D.z+=Math.sin(_)*O}p.set(T,D)})}return p}function Gt(i,n){const m=i.trim()||n,p=m.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i);if(p)return{color:new j().setRGB(+p[1]/255,+p[2]/255,+p[3]/255,rt),alpha:p[4]!==void 0?+p[4]:1};const v=new j;try{v.setStyle(m.startsWith("#")?m.slice(0,7):n)}catch{v.setStyle(n)}return{color:v,alpha:1}}function nt(){const i=getComputedStyle(document.documentElement),n=(m,p)=>Gt(i.getPropertyValue(m),p);return{dit:n("--dit","#2350B8"),ecrit:n("--ecrit","#7A3A9E"),reel:n("--reel","#286E0A"),rupture:n("--rupture","#B32F16"),ink:n("--text-primary","#141A16"),inkSoft:n("--text-secondary","#46504A"),hairline:n("--border-strong","rgba(20,26,22,0.24)"),paper:n("--bg-canvas","#F2F3EF"),surface:n("--bg-surface","#FBFBF8"),dark:document.documentElement.getAttribute("data-theme")==="dark"}}const ct=`
  float hash1(float n) { return fract(sin(n) * 43758.5453123); }
  // Bruit de valeur à interpolation linéaire : une polyligne brisée, pas une onde.
  float jag(float x) {
    float i = floor(x);
    return mix(hash1(i), hash1(i + 1.0), fract(x));
  }
`,Pt=`
  ${ct}
  attribute float aT;
  attribute float aSide;
  uniform vec3 uA;
  uniform vec3 uB;
  uniform vec3 uPerp;
  uniform float uBroken;
  uniform float uTime;
  uniform float uSeed;
  varying float vT;
  varying float vSide;
  void main() {
    float t = aT;
    vec3 p = mix(uA, uB, t);
    float env = smoothstep(0.04, 0.16, t) * smoothstep(0.96, 0.84, t);
    float cells = 15.0;
    float crack = jag(t * cells + uSeed) - 0.5;
    // tressaillement : petite onde brisée qui glisse le long de la fissure
    float tremor = (jag(t * cells * 2.3 + uSeed * 1.7 + uTime * 2.2) - 0.5) * 0.3;
    float off = uBroken * env * (crack + tremor) * 0.2;
    float w = mix(0.016, 0.046, uBroken);
    p += uPerp * (off + aSide * w * 0.5);
    p.y += 0.004 + uBroken * 0.004;
    vT = t;
    vSide = aSide;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`,Bt=`
  ${ct}
  uniform vec3 uHealthy;
  uniform vec3 uRupture;
  uniform float uHealthyAlpha;
  uniform float uBroken;
  uniform float uSeed;
  uniform float uDim;
  varying float vT;
  varying float vSide;
  void main() {
    float cells = 15.0;
    float cell = floor(vT * cells);
    float f = fract(vT * cells);
    float env = step(0.12, vT) * step(vT, 0.88);
    // éclats : certaines cellules s'interrompent, la ligne est cassée
    float gap = step(0.58, hash1(cell * 7.13 + uSeed)) * step(0.7, f) * step(f, 0.92);
    if (gap * env * step(0.5, uBroken) > 0.5) discard;
    vec3 col = mix(uHealthy, uRupture, uBroken);
    float a = mix(uHealthyAlpha, 1.0, uBroken) * uDim;
    float soft = 1.0 - smoothstep(0.55, 1.0, abs(vSide));
    gl_FragColor = vec4(col, a * mix(0.6, 1.0, soft));
    #include <colorspace_fragment>
  }
`,Ct=`
  varying vec2 vXZ;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vXZ = wp.xz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`,Dt=`
  uniform vec2 uD;
  uniform vec2 uE;
  uniform vec2 uR;
  uniform vec3 uPaper;
  uniform vec3 uDit;
  uniform vec3 uEcrit;
  uniform vec3 uReel;
  uniform float uTint;
  varying vec2 vXZ;
  vec3 bary(vec2 p) {
    vec2 v0 = uE - uD, v1 = uR - uD, v2 = p - uD;
    float d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1);
    float d20 = dot(v2, v0), d21 = dot(v2, v1);
    float den = d00 * d11 - d01 * d01;
    float v = (d11 * d20 - d01 * d21) / den;
    float w = (d00 * d21 - d01 * d20) / den;
    return vec3(1.0 - v - w, v, w);
  }
  void main() {
    vec3 b = bary(vXZ);
    float m = min(b.x, min(b.y, b.z));
    float aa = fwidth(m) * 1.5;
    float inside = smoothstep(-aa, aa, m);
    vec3 bc = clamp(b, 0.0, 1.0);
    vec3 tint = (bc.x * uDit + bc.y * uEcrit + bc.z * uReel) / max(bc.x + bc.y + bc.z, 1e-3);
    // iso-lignes barycentriques à un tiers : la trame de la feuille
    float iso = 0.0;
    for (int i = 0; i < 3; i++) {
      float c = b[i];
      float d = abs(c - 0.3333);
      float fw = fwidth(c);
      iso = max(iso, 1.0 - smoothstep(0.0, fw * 1.2, d));
    }
    vec3 col = mix(uPaper, tint, uTint * inside);
    col = mix(col, tint, iso * inside * 0.16);
    float r = length(vXZ - vec2(0.0, 0.25));
    float alpha = 1.0 - smoothstep(2.9, 4.2, r);
    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }
`,at=[{key:"dit",label:"Dit"},{key:"ecrit",label:"Écrit"},{key:"reel",label:"Réel"}];function we(i,n){return i.statut==="non_conforme"?n.rupture.color:i.statut==="conforme"?n.reel.color:n.inkSoft.color}const jt=({findings:i,activeId:n,mode:m,onSelect:p,onFallback:v})=>{const y=R.useRef(null),S=R.useRef(null),T=R.useRef({dit:null,ecrit:null,reel:null}),N=R.useRef(null),D=R.useRef(null),O=R.useRef(i),_=R.useRef(p),re=R.useRef(v),[J,lt]=R.useState(null);O.current=i,_.current=p,re.current=v,R.useEffect(()=>{var $e,Ye;const a=y.current,f=S.current;if(!a||!f)return;let b;try{b=new ht({canvas:f,antialias:!0,alpha:!0,powerPreference:"low-power"})}catch{re.current();return}b.setPixelRatio(Math.min(window.devicePixelRatio||1,2)),b.setClearColor(0,0),b.outputColorSpace=rt;const r=($e=window.matchMedia)==null?void 0:$e.call(window,"(prefers-reduced-motion: reduce)");let w=!!(r!=null&&r.matches);const h=new yt,d=new wt(tt,1,.5,60),g=nt(),P=new gt(16777215,g.paper.color,2.1),B=new bt(16777215,1.5);B.position.set(-3,6,4),h.add(P,B);const E=new Ze({vertexShader:Ct,fragmentShader:Dt,transparent:!0,depthWrite:!1,uniforms:{uD:{value:new ne(k.dit.x,k.dit.z)},uE:{value:new ne(k.ecrit.x,k.ecrit.z)},uR:{value:new ne(k.reel.x,k.reel.z)},uPaper:{value:new j},uDit:{value:new j},uEcrit:{value:new j},uReel:{value:new j},uTint:{value:.07}}}),K=new qe(10,10),I=new F(K,E);I.rotation.x=-Math.PI/2,I.renderOrder=-2,h.add(I);const C=120,A=new xt;{const e=new Float32Array((C+1)*2*3),t=new Float32Array((C+1)*2),c=new Float32Array((C+1)*2),l=[];for(let u=0;u<=C;u++){const s=u/C;if(t[u*2]=s,t[u*2+1]=s,c[u*2]=-1,c[u*2+1]=1,u<C){const x=u*2;l.push(x,x+1,x+2,x+1,x+3,x+2)}}A.setAttribute("position",new ve(e,3)),A.setAttribute("aT",new ve(t,1)),A.setAttribute("aSide",new ve(c,1)),A.setIndex(l)}const dt=new G(0,1,0),V={};for(const e of L){const t=k[e.a],c=k[e.b],l=new G().subVectors(c,t).cross(dt).normalize(),u=new Ze({vertexShader:Pt,fragmentShader:Bt,transparent:!0,depthWrite:!1,side:kt,uniforms:{uA:{value:t.clone()},uB:{value:c.clone()},uPerp:{value:l},uBroken:{value:0},uTime:{value:0},uSeed:{value:e.seed},uHealthy:{value:new j},uRupture:{value:new j},uHealthyAlpha:{value:.5},uDim:{value:1}}}),s=new F(A,u);s.frustumCulled=!1,s.renderOrder=-1,h.add(s),V[e.key]=u}const se=new Rt(.075,.075,ye,24,1);se.translate(0,ye/2,0);const ie=new Ue(.16,.19,48);ie.rotateX(-Math.PI/2);const Q={},ce=[];for(const e of["dit","ecrit","reel"]){const t=new Je({color:g[e].color});Q[e]=t;const c=new F(se,t);c.position.copy(k[e]),h.add(c);const l=new ae({color:g[e].color,transparent:!0,opacity:.85,depthWrite:!1});ce.push(l);const u=new F(ie,l);u.position.copy(k[e]).setY(.006),h.add(u)}const ee=document.createElement("canvas");ee.width=ee.height=64;const te=ee.getContext("2d");if(te){const e=te.createRadialGradient(32,32,0,32,32,32);e.addColorStop(0,"rgba(0,0,0,0.55)"),e.addColorStop(.5,"rgba(0,0,0,0.18)"),e.addColorStop(1,"rgba(0,0,0,0)"),te.fillStyle=e,te.fillRect(0,0,64,64)}const be=new St(ee),le=new qe(1,1);le.rotateX(-Math.PI/2);const xe=new Ke(1,32,20),ke=new Ke(1,8,6),Re=new ae({visible:!1}),Se=new Qe;h.add(Se);const ue=new Ue(1,1.16,64);ue.rotateX(-Math.PI/2);const H=new ae({color:g.ink.color,transparent:!0,opacity:0,depthWrite:!1}),X=new F(ue,H);X.renderOrder=1,h.add(X);const Ee=new Et,Me=new ne,de=new G;let W=1,oe=1,pe=!0,fe=document.visibilityState!=="hidden",z=0,$=!1,me=performance.now(),Te=0;const o={renderer:b,scene:h,camera:d,beads:new Map,beadRoot:Se,sphereGeo:xe,shadowGeo:le,hitGeo:ke,shadowTex:be,hitMat:Re,edgeMats:V,edgeTargets:{"dit-ecrit":0,"ecrit-reel":0,"dit-reel":0},paperMat:E,pillarMats:Q,ring:X,ringMat:H,hemi:P,sun:B,palette:g,lookTarget:new G(0,0,.45),lookGoal:new G(0,0,.45),dist:12,activeId:null,hoverId:null,snap:!0,invalidate:()=>{}};D.current=o;const Ae=()=>{const e=nt();o.palette=e,E.uniforms.uPaper.value.copy(e.surface.color),E.uniforms.uDit.value.copy(e.dit.color),E.uniforms.uEcrit.value.copy(e.ecrit.color),E.uniforms.uReel.value.copy(e.reel.color),E.uniforms.uTint.value=e.dark?.06:.07,P.groundColor.copy(e.paper.color),P.intensity=e.dark?1.6:2.1,B.intensity=e.dark?1.1:1.5,["dit","ecrit","reel"].forEach((t,c)=>{Q[t].color.copy(e[t].color),ce[c].color.copy(e[t].color)});for(const t of L)V[t.key].uniforms.uRupture.value.copy(e.rupture.color);H.color.copy(e.ink.color);for(const t of o.beads.values())t.mat.color.copy(we(t.finding,e)),t.shadowMat.opacity=e.dark?.7:.45;pt(),o.invalidate()},pt=()=>{const e=o.palette,t=O.current.find(l=>l.id===o.activeId),c=(t==null?void 0:t.statut)==="conforme";for(const l of L){const u=V[l.key].uniforms;u.uHealthy.value.copy(c?e.reel.color:e.ink.color),u.uHealthyAlpha.value=c?.75:Math.max(.32,e.hairline.alpha*1.6)}},Ge=()=>{const e=a.getBoundingClientRect();W=Math.max(1,Math.round(e.width)),oe=Math.max(1,Math.round(e.height)),b.setSize(W,oe,!1),d.aspect=W/oe;const t=Math.tan(st.degToRad(tt/2)),c=2.75,l=2.45;o.dist=Math.max(l/t,c/(t*d.aspect)),d.updateProjectionMatrix(),o.invalidate()},ft=()=>{d.position.set(o.lookTarget.x,o.lookTarget.y+Math.sin(ot)*o.dist,o.lookTarget.z+Math.cos(ot)*o.dist),d.lookAt(o.lookTarget)},Pe=e=>(de.copy(e).project(d),{x:(de.x*.5+.5)*W,y:(-de.y*.5+.5)*oe}),mt=()=>{for(const{key:t}of at){const c=T.current[t];if(!c)continue;const l=k[t].clone().setY(ye+.22),u=Pe(l);c.style.transform=`translate3d(${u.x.toFixed(1)}px, ${u.y.toFixed(1)}px, 0) translate(-50%, -100%)`}const e=N.current;if(e){const t=o.hoverId?o.beads.get(o.hoverId):void 0;if(t){const c=Pe(t.group.position.clone().setY(t.radius*2+.05)),l=Math.min(Math.max(c.x,70),W-70);e.style.transform=`translate3d(${l.toFixed(1)}px, ${c.y.toFixed(1)}px, 0) translate(-50%, calc(-100% - 6px))`}}},Y=(e,t)=>o.snap?1:1-Math.exp(-e*t),Be=e=>{let t=!1;const c=Y(7,e);o.lookTarget.lerp(o.lookGoal,Y(3.2,e)),o.lookTarget.distanceToSquared(o.lookGoal)>1e-6&&(t=!0),ft();for(const s of o.beads.values()){const x=o.activeId===null||s.id===o.activeId?1:s.id===o.hoverId?.85:.4;s.group.position.lerp(s.target,c),s.opacity+=(x-s.opacity)*Y(9,e),s.mat.opacity=s.opacity,s.mat.transparent=s.opacity<.99,s.mat.depthWrite=s.opacity>.99,s.shadowMat.opacity=(o.palette.dark?.7:.45)*s.opacity,(s.group.position.distanceToSquared(s.target)>1e-6||Math.abs(x-s.opacity)>.001)&&(t=!0)}const l=o.activeId?o.beads.get(o.activeId):void 0,u=l?1:0;if(H.opacity+=(u-H.opacity)*Y(8,e),l){X.position.set(l.group.position.x,.008,l.group.position.z);const s=l.radius+.075;X.scale.setScalar(s)}for(const s of L){const x=V[s.key].uniforms;x.uBroken.value+=(o.edgeTargets[s.key]-x.uBroken.value)*Y(5,e),x.uTime.value=w?0:Te,Math.abs(o.edgeTargets[s.key]-x.uBroken.value)>.001&&(t=!0)}return t},Ce=()=>{mt(),b.render(h,d)},vt=()=>L.some(e=>o.edgeTargets[e.key]>.5),De=()=>{z=0;const e=performance.now(),t=Math.min(.05,(e-me)/1e3);me=e,Te+=t;const c=Be(t);o.snap=!1,Ce(),$&&(c||vt())?z=requestAnimationFrame(De):$=!1},Z=()=>{if(!(!pe||!fe)){if(w){o.snap=!0,Be(0),o.snap=!1,Ce();return}$||($=!0,me=performance.now(),z=requestAnimationFrame(De))}};o.invalidate=Z;const q=()=>{z&&cancelAnimationFrame(z),z=0,$=!1};Ae(),Ge();const Fe=new ResizeObserver(Ge);Fe.observe(a);const Le=new IntersectionObserver(e=>{pe=e.some(t=>t.isIntersecting),pe?Z():q()},{threshold:0});Le.observe(a);const je=()=>{fe=document.visibilityState!=="hidden",fe?Z():q()};document.addEventListener("visibilitychange",je);const Ie=new MutationObserver(Ae);Ie.observe(document.documentElement,{attributes:!0,attributeFilter:["data-theme","class"]});const Ve=e=>{w=e.matches,q(),Z()};(Ye=r==null?void 0:r.addEventListener)==null||Ye.call(r,"change",Ve);const He=e=>{var u;const t=f.getBoundingClientRect();Me.set((e.clientX-t.left)/t.width*2-1,-((e.clientY-t.top)/t.height)*2+1),Ee.setFromCamera(Me,d);const l=(u=Ee.intersectObjects([...o.beads.values()].map(s=>s.hit),!1)[0])==null?void 0:u.object.userData.id;return l?o.beads.get(l):void 0},ze=e=>{const t=(e==null?void 0:e.id)??null;t!==o.hoverId&&(o.hoverId=t,f.style.cursor=t?"pointer":"default",lt(e?e.finding:null),Z())},Ne=e=>{e.pointerType!=="touch"&&ze(He(e))},Oe=()=>ze(void 0);let U=null;const _e=e=>{U={x:e.clientX,y:e.clientY}},Xe=e=>{if(!U)return;const t=Math.hypot(e.clientX-U.x,e.clientY-U.y);if(U=null,t>8)return;const c=He(e);c&&_.current(c.finding)};f.addEventListener("pointermove",Ne),f.addEventListener("pointerleave",Oe),f.addEventListener("pointerdown",_e),f.addEventListener("pointerup",Xe);const We=e=>{e.preventDefault(),q(),re.current()};return f.addEventListener("webglcontextlost",We),()=>{var e;q(),Fe.disconnect(),Le.disconnect(),Ie.disconnect(),document.removeEventListener("visibilitychange",je),(e=r==null?void 0:r.removeEventListener)==null||e.call(r,"change",Ve),f.removeEventListener("pointermove",Ne),f.removeEventListener("pointerleave",Oe),f.removeEventListener("pointerdown",_e),f.removeEventListener("pointerup",Xe),f.removeEventListener("webglcontextlost",We);for(const t of o.beads.values())t.mat.dispose(),t.shadowMat.dispose();o.beads.clear(),[K,A,se,ie,le,xe,ke,ue].forEach(t=>t.dispose()),[E,...Object.values(V),...Object.values(Q),...ce,Re,H].forEach(t=>t.dispose()),be.dispose(),b.dispose(),D.current=null}},[]),R.useEffect(()=>{const a=D.current;if(!a)return;const f=At(i),b=new Set(i.map(r=>r.id));for(const[r,w]of a.beads)b.has(r)||(a.beadRoot.remove(w.group),w.mat.dispose(),w.shadowMat.dispose(),a.beads.delete(r));for(const r of i){const w=f.get(r.id),h=et[r.gravite]??et.moyenne;let d=a.beads.get(r.id);if(!d){const B=new Qe,E=new Je({color:we(r,a.palette)}),K=new F(a.sphereGeo,E),I=new ae({map:a.shadowTex,transparent:!0,depthWrite:!1,opacity:.45,color:0}),C=new F(a.shadowGeo,I);C.position.y=.003;const A=new F(a.hitGeo,a.hitMat);A.userData.id=r.id,B.add(K,C,A),B.position.copy(w),a.beadRoot.add(B),d={id:r.id,finding:r,group:B,mat:E,shadowMat:I,hit:A,target:w.clone(),radius:h,opacity:1},a.beads.set(r.id,d)}d.finding=r,d.target.copy(w),d.radius=h,d.target.y=0;const g=d.group.children[0];g.scale.setScalar(h),g.position.y=h,d.group.children[1].scale.setScalar(h*3.2);const P=Math.max(h*1.5,.2);d.hit.scale.setScalar(P),d.hit.position.y=h,d.mat.color.copy(we(r,a.palette))}a.invalidate()},[i]),R.useEffect(()=>{const a=D.current;if(!a)return;a.activeId=n;const f=i.find(g=>g.id===n)??null,b=it(f);for(const g of L)a.edgeTargets[g.key]=b[g.key]?1:0;const r=(f==null?void 0:f.statut)==="conforme",w=a.palette;for(const g of L){const P=a.edgeMats[g.key].uniforms;P.uHealthy.value.copy(r?w.reel.color:w.ink.color),P.uHealthyAlpha.value=r?.75:Math.max(.32,w.hairline.alpha*1.6)}const h=n?a.beads.get(n):void 0,d=new G(0,0,.45);h&&d.lerp(h.target,.14),a.lookGoal.copy(d),a.invalidate()},[n,i]);const ut={dit:m==="AVANT"?"N/A":"Entretien",ecrit:"PSSI / PV",reel:"Cloud GCP"};return M.jsxs("div",{ref:y,className:"relative w-full h-[260px] sm:h-[300px] overflow-hidden select-none",children:[M.jsx("canvas",{ref:S,"aria-hidden":"true",className:"absolute inset-0 w-full h-full block touch-manipulation"}),M.jsxs("div",{"aria-hidden":"true",className:"pointer-events-none absolute inset-0",children:[at.map(({key:a,label:f})=>M.jsxs("div",{ref:b=>{T.current[a]=b},className:"absolute left-0 top-0 text-center leading-tight whitespace-nowrap pb-1",style:{willChange:"transform"},children:[M.jsx("div",{className:"text-xs font-semibold",style:{color:`var(--${a})`},children:f}),M.jsx("div",{className:"text-[11px] text-sub",children:ut[a]})]},a)),M.jsx("div",{ref:N,className:`absolute left-0 top-0 max-w-[200px] rounded-md border border-strong bg-[var(--bg-elevated)] px-2 py-1 shadow-[var(--shadow-panel)] transition-opacity duration-150 ${J?"opacity-100":"opacity-0"}`,children:J&&M.jsxs(M.Fragment,{children:[M.jsx("span",{className:"font-mono text-[11px] font-semibold text-sub mr-1.5",children:J.id}),M.jsx("span",{className:"text-xs text-main",children:J.theme})]})})]})]})};export{it as brokenEdges,jt as default};
