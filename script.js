// script.js
import { chooseModelSmart, recordVoteGlobal } from "./supabase.js";

/* ---------- tiny helpers ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchWithTimeout(url, init = {}, ms = 15000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(new Error("timeout")), ms);
  try {
    return await fetch(url, { ...init, signal: init.signal ?? ctrl.signal, cache: "no-store" });
  } finally {
    clearTimeout(id);
  }
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const idle = (timeout = 0) =>
  new Promise((r) =>
    window.requestIdleCallback ? requestIdleCallback(r, { timeout }) : setTimeout(r, Math.max(0, timeout))
  );

function el(id){ return document.getElementById(id); }

/* ---------- DOM refs ---------- */
const els = {
  prompt: el("prompt"),
  count: el("count"),
  aspect: el("aspect"),
  gen: el("generate"),
  stop: el("stop"),
  clear: el("clear"),
  status: el("status"),
  statusText: el("statusText"),
  progress: el("progress"),
  gallery: el("gallery"),
  chars: el("chars"),
  surprise: el("surprise"),
  downloadAll: el("downloadAll"),
  format: el("format"),
  multi: el("multi"),
  delimiter: el("delimiter"),
  seed: el("seed"),
  nologo: el("nologo"),
  width: el("width"),
  heightComputed: el("heightComputed"),
  lockAspect: el("lockAspect"),
  skipAbnormal: el("skipAbnormal"),
  skipCounter: el("skipCounter"),
  adaptive: el("adaptive"),
  smartRetries: el("smartRetries"),
  avoidDup: el("avoidDup"),
  uniqueRetries: el("uniqueRetries"),
  gpuInfo: el("gpuInfo"),
  gpuEnable: el("gpuEnable"),
};

const samples = [
  "A futuristic cityscape at night, neon rain, reflective streets, cinematic ultrawide, volumetric fog, highly detailed",
  "A cozy reading nook with warm lamp light, rain on the window, soft bokeh, film grain, shallow depth of field",
  "A photorealistic robot barista serving coffee, stainless steel textures, natural morning light, 50mm lens",
  "An ancient library hidden in a forest, golden hour, god rays through trees, ethereal atmosphere, high detail",
  "An isometric pixel art cyberpunk alley, vending machines, animated neon signs, rainy vibes"
];

let running = false, cancel = false, currentAbort = null;

/* ---------- UI helpers ---------- */
function setBusy(active, text = "Generating…") {
  els.status.classList.toggle("hidden", !active);
  els.statusText.textContent = text;
}
function setProgress(i, n) {
  els.progress.textContent = `${i}/${n}`;
}
function makeRipple(event, target) {
  const rect = target.getBoundingClientRect();
  const span = document.createElement("span");
  span.className = "ripple";
  const x = ((event.clientX - rect.left) / rect.width) * 100;
  const y = ((event.clientY - rect.top) / rect.height) * 100;
  span.style.setProperty("--x", x + "%");
  span.style.setProperty("--y", y + "%");
  target.appendChild(span);
  setTimeout(() => span.remove(), 650);
}
function makeToast(target, text, isDown = false) {
  const t = document.createElement("span");
  t.className = "vote-toast" + (isDown ? " red" : "");
  t.textContent = text;
  target.appendChild(t);
  setTimeout(() => t.remove(), 1000);
}
function makeBurst(target, emoji = "✨") {
  const b = document.createElement("span");
  b.className = "burst";
  b.textContent = emoji;
  target.appendChild(b);
  setTimeout(() => b.remove(), 700);
}

/* ---------- Parsing & filenames ---------- */
function parsePrompts(raw) {
  const s = (raw || "").trim();
  if (!s) return [];
  if (!els.multi.checked) return [s];
  const d = els.delimiter.value;
  let parts = [];
  switch (d) {
    case "newline": parts = s.split(/\n+/); break;
    case "blankline": parts = s.split(/\n\s*\n+/); break;
    case "comma": parts = s.split(/\s*,\s*/); break;
    case "semicolon": parts = s.split(/\s*;\s*/); break;
    case "pipe": parts = s.split(/\s*\|\s*/); break;
    case "space": parts = s.split(/\s+/); break;
    default: parts = [s];
  }
  return parts.map(x => x.trim()).filter(Boolean);
}
function updatePromptCount() {
  const n = parsePrompts(els.prompt.value).length;
  els.chars.textContent = `${n} prompt${n === 1 ? "" : "s"}`;
}
function filenameFromPrompt(prompt, i, ext) {
  const base = (prompt || "")
    .trim()
    .slice(0, 60)
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/(^-|-$)/g, "")
    .toLowerCase() || "image";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${base}-${i}-${ts}.${ext}`;
}

/* ---------- Aspect/size ---------- */
function parseAspect(val){
  const [aw, ah] = (val || "1/1").split("/").map(Number);
  return { aw: Math.max(1, aw | 0), ah: Math.max(1, ah | 0) };
}
function updateDerivedHeight() {
  const { aw, ah } = parseAspect(els.aspect.value);
  const raw = (els.width.value || "").trim();
  if (raw === "") { els.heightComputed.value = ""; return; }
  const width = parseInt(raw, 10);
  if (!Number.isFinite(width) || width <= 0) return;
  const height = Math.max(1, Math.round(width * (ah / aw)));
  els.heightComputed.value = String(height);
}
els.width.addEventListener("input", updateDerivedHeight);
els.aspect.addEventListener("change", updateDerivedHeight);

/* ---------- Quality & dedupe ---------- */
function nearlyEqualRatio(a,b,tol=.12){return Math.abs(a-b)/Math.max(a,b)<=tol;}
async function analyzeImageQuality(img, wantW, wantH){
  const w = img.naturalWidth || img.width || 0, h = img.naturalHeight || img.height || 0;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 64 || h < 64) return false;
  const wantR = wantW && wantH ? wantW / wantH : null;
  if (wantR) { const gotR = w / h; if (!nearlyEqualRatio(gotR, wantR, .2)) return false; }
  const s = 64, c = document.createElement("canvas"); c.width = s; c.height = s; const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, s, s);
  const data = ctx.getImageData(0, 0, s, s).data;
  let mean = 0, n = s*s;
  for (let i=0;i<n;i++){ const r=data[i*4], g=data[i*4+1], b=data[i*4+2]; mean += 0.2126*r + 0.7152*g + 0.0722*b; }
  mean/=n; let variance=0;
  for (let i=0;i<n;i++){ const r=data[i*4], g=data[i*4+1], b=data[i*4+2]; const y = 0.2126*r + 0.7152*g + 0.0722*b; const d = y-mean; variance += d*d; }
  const stdev = Math.sqrt(variance/n);
  return stdev >= 6; // coarse texture check
}
const _seenHashes = new Set();
function _aHash(img, size=8){
  const s=size|0, c=document.createElement("canvas"); c.width=s; c.height=s; const ctx=c.getContext("2d");
  ctx.drawImage(img,0,0,s,s);
  const data=ctx.getImageData(0,0,s,s).data, gs=new Array(s*s);
  for(let i=0;i<s*s;i++){ const r=data[i*4], g=data[i*4+1], b=data[i*4+2]; gs[i]=Math.round(0.299*r+0.587*g+0.114*b); }
  const mean=gs.reduce((a,b)=>a+b,0)/(s*s);
  let bits=""; for(let i=0;i<gs.length;i++) bits += (gs[i]>=mean?"1":"0");
  let hex=""; for(let i=0;i<bits.length;i+=4) hex += parseInt(bits.slice(i,i+4),2).toString(16);
  return hex;
}
function _hamming(a,b){ if(!a||!b||a.length!==b.length) return 64; let d=0; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) d++; return d; }

/* ---------- GPU (minimal + safe) ---------- */
function getGpuReadableName(gl){
  try{
    const ext=gl.getExtension("WEBGL_debug_renderer_info");
    if(!ext) return gl.getParameter(gl.RENDERER) || "unknown";
    return gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || gl.getParameter(gl.RENDERER) || "unknown";
  }catch{return "unknown";}
}
function targetTooLargeForWebGL(tw,th){
  const maxDim=Math.max(tw,th), total=tw*th;
  return maxDim>6144 || total>24_000_000;
}
function createGLCanvas(tw,th){
  const canvas=document.createElement("canvas"); canvas.width=tw; canvas.height=th;
  const attrs={ premultipliedAlpha:false, powerPreference:"high-performance" };
  let gl=canvas.getContext("webgl2",attrs); let ver="WebGL2";
  if(!gl){ gl=canvas.getContext("webgl",attrs); ver = gl ? "WebGL1" : null; }
  return gl ? {canvas,gl,ver} : null;
}
function gpuBicubicUpscale(img, tw, th){
  if(!els.gpuEnable || !els.gpuEnable.checked) return null;
  if(targetTooLargeForWebGL(tw,th)) return null;

  const srcW = img.naturalWidth || img.width, srcH = img.naturalHeight || img.height;
  const ctx = createGLCanvas(tw,th); if(!ctx) return null;
  const { canvas: glCanvas, gl, ver } = ctx;
  try { els.gpuInfo.textContent = `GPU: ${ver} · ${getGpuReadableName(gl)}`; } catch {}

  const vs2 = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv=(p+1.0)*0.5; uv.y=1.0-uv.y; gl_Position=vec4(p,0.0,1.0); }`;

  const fs2 = `#version 300 es
precision highp float; uniform sampler2D t; uniform vec2 srcSize; in vec2 uv; out vec4 o;
float w(float x){ x=abs(x); if(x<=1.0) return 1.0-(2.0*x*x)+(x*x*x); else if(x<2.0) return 4.0-8.0*x+5.0*x*x-x*x*x; return 0.0; }
vec4 sampleBicubic(vec2 coord){ vec2 px=1.0/srcSize; vec2 st=coord*srcSize-0.5; vec2 i=floor(st); vec2 f=st-i; vec4 c=vec4(0.0);
for(int m=-1;m<=2;m++){ float km=w(float(m)-f.y); for(int n=-1;n<=2;n++){ float kn=w(f.x-float(n)); c+=texture(t,(i+vec2(n,m)+0.5)*px)*(km*kn);} } return c; }
void main(){ o=sampleBicubic(uv); }`;

  const vs1 = `
attribute vec2 p; varying vec2 uv;
void main(){ uv=(p+1.0)*0.5; uv.y=1.0-uv.y; gl_Position=vec4(p,0.0,1.0); }`;

  const fs1 = `precision mediump float; varying vec2 uv; uniform sampler2D t; void main(){ gl_FragColor=texture2D(t,uv);} `;

  function sh(type, src){
    const s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)||"shader compile failed"); return s;
  }

  try{
    const prog=gl.createProgram();
    if(ver==="WebGL2"){ gl.attachShader(prog, sh(gl.VERTEX_SHADER,vs2)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER,fs2)); }
    else { gl.attachShader(prog, sh(gl.VERTEX_SHADER,vs1)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER,fs1)); }
    gl.linkProgram(prog);
    if(!gl.getProgramParameter(prog,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog)||"link failed");
    gl.useProgram(prog);

    const buf=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,buf);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1, 1,-1, -1,1, 1,1]),gl.STATIC_DRAW);
    const loc=gl.getAttribLocation(prog,"p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);

    gl.activeTexture(gl.TEXTURE0);
    const tex=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,tex);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,img);

    gl.uniform1i(gl.getUniformLocation(prog,"t"),0);
    if(ver==="WebGL2") gl.uniform2f(gl.getUniformLocation(prog,"srcSize"),srcW,srcH);

    gl.viewport(0,0,tw,th);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);

    if(gl.getError()) return null;
    return glCanvas;
  }catch{ return null; }
}

/* ---------- CPU upscale fallback ---------- */
function createCanvas(w,h){ const c=document.createElement("canvas"); c.width=w; c.height=h; return c; }
function safe2d(c){ const ctx=c.getContext("2d"); if(!ctx) throw new Error("2D context unavailable"); return ctx; }
function drawImageHQ(ctx,img,dx,dy,dw,dh){ ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality="high"; ctx.drawImage(img,dx,dy,dw,dh); }
function multiStepResize(img, tw, th){
  let cw = img.naturalWidth || img.width, ch = img.naturalHeight || img.height, src = img;
  while(cw*1.5 < tw || ch*1.5 < th){
    const nw=Math.min(Math.round(cw*1.5),tw), nh=Math.min(Math.round(ch*1.5),th);
    const tmp=createCanvas(nw,nh); const tctx=safe2d(tmp); drawImageHQ(tctx,src,0,0,nw,nh); src=tmp; cw=nw; ch=nh;
  }
  if(cw!==tw || ch!==th){ const f=createCanvas(tw,th); const fctx=safe2d(f); drawImageHQ(fctx,src,0,0,tw,th); src=f; }
  return src;
}
function to2DCanvas(src){
  try{ const c=src.getContext && src.getContext("2d"); if(c) return src; }catch{}
  const c=document.createElement("canvas"); c.width=src.width; c.height=src.height; const ctx=c.getContext("2d"); ctx.drawImage(src,0,0); return c;
}
async function upscaleAuto(img, tw, th){
  try{ const glc = gpuBicubicUpscale(img,tw,th); if(glc) return to2DCanvas(glc); }catch{}
  return multiStepResize(img, tw, th);
}

/* ---------- Orientation-aware decode ---------- */
async function canvasFromBlobRespectOrientation(blob){
  if("createImageBitmap" in window){
    try{
      const bmp = await createImageBitmap(blob, { imageOrientation:"from-image" });
      const c=document.createElement("canvas"); c.width=bmp.width; c.height=bmp.height;
      const ctx=c.getContext("2d"); ctx.drawImage(bmp,0,0); bmp.close?.(); return c;
    }catch{}
  }
  const url=URL.createObjectURL(blob);
  try{
    const img=new Image(); img.crossOrigin="anonymous"; img.src=url; await img.decode();
    const c=document.createElement("canvas"); c.width=img.naturalWidth||img.width; c.height=img.naturalHeight||img.height;
    const ctx=c.getContext("2d"); ctx.drawImage(img,0,0); return c;
  }finally{ URL.revokeObjectURL(url); }
}

/* ---------- Pollinations ---------- */
function buildPollinationsUrl(prompt, { model, width, height, seed, nologo, quality="default" }){
  const base="https://image.pollinations.ai/prompt/";
  const q=new URLSearchParams();
  const W=Math.min(Math.max(64, Number(width||0)), 3072);
  const H=Math.min(Math.max(64, Number(height||0)), 3072);
  if(model && model!=="any") q.set("model", model);
  if(W) q.set("width", String(W));
  if(H) q.set("height", String(H));
  if(nologo) q.set("nologo","true");
  if(seed!==undefined && seed!==null && seed!=="") q.set("seed", String(seed));
  if(quality) q.set("q", quality);
  return base + encodeURIComponent(prompt) + (q.toString()?("?"+q.toString()):"");
}

async function toFormatted(imgUrl, { format, targetW, targetH, alt, signal }, tries=3){
  const backoff=600;
  for(let attempt=1; attempt<=tries; attempt++){
    const bust=(imgUrl.includes("?")?"&":"?")+"ts="+Date.now();
    const urlWithBust = imgUrl + bust;
    try{
      const resp = await fetchWithTimeout(urlWithBust, { signal }, 15000);
      if(!resp.ok){
        if(attempt<tries && (resp.status===429 || (resp.status>=500 && resp.status<600))){ await sleep(backoff + Math.random()*400); continue; }
        throw new Error(`HTTP ${resp.status}`);
      }
      const ctype=(resp.headers.get("content-type")||"").toLowerCase();
      if(!ctype.startsWith("image/")){
        if(attempt<tries){ await sleep(backoff + Math.random()*400); continue; }
        throw new Error(`Non-image (${ctype})`);
      }

      const blob = await resp.blob();
      const baseCanvas = await canvasFromBlobRespectOrientation(blob); // EXIF-aware
      const srcW = baseCanvas.width, srcH = baseCanvas.height;

      // if aspect flipped by 180°, swap target
      const rGot=srcW/srcH, rWant=targetW/targetH;
      const near=(a,b,t=.06)=>Math.abs(a-b)/Math.max(a,b)<=t;
      const [tw,th] = near(rGot,rWant) ? [targetW,targetH] : near(rGot, targetH/targetW) ? [targetH,targetW] : [targetW,targetH];

      // optional quality gate
      if(els.skipAbnormal && els.skipAbnormal.checked){
        const probe = new Image(); probe.src = baseCanvas.toDataURL("image/png"); await probe.decode();
        const ok = await analyzeImageQuality(probe, tw, th);
        if(!ok) throw new Error("SKIP_BAD_IMAGE");
      }

      // upscale
      let outCanvas = await upscaleAuto(baseCanvas, tw, th);

      // light post-FX
      outCanvas = (()=>{ // median blend
        const w=outCanvas.width,h=outCanvas.height; const ctx=safe2d(outCanvas);
        const src=ctx.getImageData(0,0,w,h), dst=ctx.createImageData(w,h), s=src.data, d=dst.data;
        const idx=(x,y)=>(y*w+x)*4; const kx=[-1,0,1,-1,0,1,-1,0,1], ky=[-1,-1,-1,0,0,0,1,1,1];
        const strength=0.12;
        if(strength<=0) return outCanvas;
        for(let y=1;y<h-1;y++){
          for(let x=1;x<w-1;x++){
            const rA=[],gA=[],bA=[];
            for(let k=0;k<9;k++){ const i=idx(x+kx[k], y+ky[k]); rA.push(s[i]); gA.push(s[i+1]); bA.push(s[i+2]); }
            rA.sort((a,b)=>a-b); gA.sort((a,b)=>a-b); bA.sort((a,b)=>a-b);
            const i=idx(x,y), mr=rA[4], mg=gA[4], mb=bA[4];
            d[i]=Math.round(s[i]*(1- strength) + mr*strength);
            d[i+1]=Math.round(s[i+1]*(1- strength) + mg*strength);
            d[i+2]=Math.round(s[i+2]*(1- strength) + mb*strength);
            d[i+3]=s[i+3];
          }
        }
        ctx.putImageData(dst,0,0); return outCanvas;
      })();

      // slight sharpen + contrast
      (function applySharpen(amount=0.45){
        if(amount<=0) return;
        const w=outCanvas.width,h=outCanvas.height; const ctx=safe2d(outCanvas);
        const src=ctx.getImageData(0,0,w,h), dst=ctx.createImageData(w,h);
        const s=src.data, d=dst.data; const a=amount;
        const k=[0,-1*a,0, -1*a, 1+4*a, -1*a, 0,-1*a,0];
        const pix=(x,y,c)=>s[(y*w+x)*4+c] | 0;
        for(let y=1;y<h-1;y++){
          for(let x=1;x<w-1;x++){
            for(let c=0;c<3;c++){
              const val =
                pix(x-1,y-1,c)*k[0] + pix(x,y-1,c)*k[1] + pix(x+1,y-1,c)*k[2] +
                pix(x-1,y,c)*k[3]   + pix(x,y,c)*k[4]   + pix(x+1,y,c)*k[5] +
                pix(x-1,y+1,c)*k[6] + pix(x,y+1,c)*k[7] + pix(x+1,y+1,c)*k[8];
              d[(y*w+x)*4+c] = Math.max(0, Math.min(255, val));
            }
            d[(y*w+x)*4+3] = s[(y*w+x)*4+3];
          }
        }
        ctx.putImageData(dst,0,0);
      })();

      (function applyContrast(boost=0.06){
        if(boost<=0) return;
        const ctx=safe2d(outCanvas), w=outCanvas.width,h=outCanvas.height;
        const img=ctx.getImageData(0,0,w,h), d=img.data, f=(1+boost), m=128;
        for(let i=0;i<d.length;i+=4){
          d[i]   = Math.max(0, Math.min(255, (d[i]  -m)*f + m));
          d[i+1] = Math.max(0, Math.min(255, (d[i+1]-m)*f + m));
          d[i+2] = Math.max(0, Math.min(255, (d[i+2]-m)*f + m));
        }
        ctx.putImageData(img,0,0);
      })();

      const useJpeg = (format==="jpeg");
      const mime = useJpeg ? "image/jpeg" : "image/png";
      const dataUrl = outCanvas.toDataURL(mime, useJpeg ? 1.0 : undefined);

      const out=new Image(); out.src=dataUrl; out.alt=alt||""; await out.decode();
      out.dataset.format = useJpeg ? "jpeg" : "png";
      out.dataset.w = String(outCanvas.width);
      out.dataset.h = String(outCanvas.height);
      out.dataset.downloadHref = dataUrl;
      return out;
    }catch(e){
      if(signal && signal.aborted) throw e;
      const msg=String((e && e.message) || e || "");
      if(attempt<tries && (msg.includes("timeout") || msg.includes("Failed to fetch") || msg.includes("SKIP_BAD_IMAGE"))){
        await sleep(backoff + Math.random()*400); continue;
      }
      if(attempt>=tries) throw e;
    }
  }
  throw new Error("Unexpected: toFormatted exhausted retries.");
}

/* ---------- Gallery ---------- */
function addToGallery(img, prompt, model, idx){
  const card=document.createElement("div"); card.className="imgcard";
  const wrap=document.createElement("div"); wrap.className="imgwrap";
  const ratio=els.aspect.value.split("/").map(Number);
  if(ratio.length===2) wrap.style.aspectRatio=`${ratio[0]} / ${ratio[1]}`;
  img.alt=prompt; img.loading="lazy";
  wrap.appendChild(img);

  const tools=document.createElement("div"); tools.className="imgtools";
  const meta=document.createElement("div"); meta.className="small";
  const w=img.dataset.w||"—", h=img.dataset.h||"—";
  meta.textContent = `${model} · ${prompt.slice(0,64)}${prompt.length>64?"…":""} · ${w}×${h}`;

  const upBtn=document.createElement("button");
  upBtn.className="btn-ghost thumb"; upBtn.textContent="👍";
  upBtn.title="Looks good"; upBtn.setAttribute("aria-label","Mark this image good");

  const downBtn=document.createElement("button");
  downBtn.className="btn-ghost thumb"; downBtn.textContent="👎";
  downBtn.title="Looks bad"; downBtn.setAttribute("aria-label","Mark this image bad");

  upBtn.addEventListener("click", async (e)=>{
    e.preventDefault();
    makeRipple(e, upBtn); makeBurst(upBtn,"💫");
    await recordVoteGlobal({ prompt, model, seed: Number(img.dataset.seed||0), up:true });
    makeToast(upBtn,"Saved");
  }, { passive:false });

  downBtn.addEventListener("click", async (e)=>{
    e.preventDefault();
    makeRipple(e, downBtn); makeBurst(downBtn,"💥");
    await recordVoteGlobal({ prompt, model, seed: Number(img.dataset.seed||0), up:false });
    makeToast(downBtn,"Saved",true);
  }, { passive:false });

  const dl=document.createElement("a"); dl.className="btn-ghost"; dl.textContent="Download";
  const ext=img.dataset.format || (els.format.value==="jpeg" ? "jpeg" : "png");
  dl.download=filenameFromPrompt(prompt, idx, ext);
  dl.href = img.dataset.downloadHref || img.src;

  tools.appendChild(meta);
  tools.appendChild(upBtn);
  tools.appendChild(downBtn);
  tools.appendChild(dl);

  card.appendChild(wrap);
  card.appendChild(tools);
  els.gallery.prepend(card);
}

/* ---------- Main flow ---------- */
function buildSeed(base, i, attempts, adaptiveOn, prompt){
  const rnd = Math.floor(Math.random()*1e9);
  const baseSeed = (base!==null && base!==undefined) ? (base + i - 1) : rnd;
  if(!adaptiveOn) return { seed: baseSeed, used: "plain" };
  // let backend memory choose (via DB); we still jitter if needed later
  return { seed: baseSeed, used: "adaptive" };
}

function setGpuBadge(){
  const el=els.gpuInfo; if(!el) return;
  let label="GPU: unavailable";
  try{
    const test = (function(){
      const c=document.createElement("canvas");
      let gl=c.getContext("webgl2");
      if(gl) return { gl, ver:"WebGL2" };
      gl=c.getContext("webgl");
      if(gl) return { gl, ver:"WebGL1" };
      return null;
    })();
    if(test && test.gl){
      const name = getGpuReadableName(test.gl) || "";
      window.__gpuEnabled = true; window.__gpuName = name || "WebGL";
      label = `GPU: ${test.ver}${name ? " · " + name : ""}`;
    }
  }catch{}
  el.textContent = label;
}

async function generateBatch(){
  if(running) return;
  const prompts = parsePrompts(els.prompt.value);
  if(!prompts.length){ els.prompt.focus(); return; }

  running = true; cancel = false;
  els.gen.disabled = true; els.stop.disabled = false;
  setBusy(true, "Generating…");

  const n = parseInt(els.count.value,10) || 1;
  const outFormat = els.format.value;
  const seedBase = els.seed.value.trim() ? Number(els.seed.value.trim()) : null;
  const nologo = !!(els.nologo && els.nologo.checked);

  const { aw, ah } = parseAspect(els.aspect.value);
  let targetW = parseInt(els.width.value,10);
  if(!Number.isFinite(targetW) || targetW<64) targetW=64;
  if(targetW>16384) targetW=16384;

  const targetH = els.lockAspect.checked
    ? Math.max(1, Math.round(targetW * (ah/aw)))
    : Math.max(1, parseInt(els.heightComputed.value || "0",10) || Math.round(targetW*(ah/aw)));
  els.heightComputed.value = String(targetH);

  let k=0, skipped=0;
  setProgress(0, n*prompts.length);
  if(els.skipCounter) els.skipCounter.textContent = "Skipped: 0";
  _seenHashes.clear();
  currentAbort = new AbortController();

  try{
    for(const p of prompts){
      // smart model selection per prompt
      const chosenModel = await chooseModelSmart(p);

      for(let i=1;i<=n;i++){
        if(cancel){ setBusy(false,"Canceled"); throw new Error("canceled"); }
        setProgress(k, n*prompts.length);
        await nextFrame();

        try{
          const { seed: baseSeed } = buildSeed(seedBase, i, 0, !!(els.adaptive && els.adaptive.checked), p);

          let finalImg=null, attempts=0;
          const extraBad = Math.max(0, parseInt((els.smartRetries && els.smartRetries.value) || "0",10));
          const extraDup = Math.max(0, parseInt((els.uniqueRetries && els.uniqueRetries.value) || "0",10));
          const wantUnique = !!(els.avoidDup && els.avoidDup.checked);

          while(attempts <= (extraBad + extraDup)){
            if(cancel){ setBusy(false,"Canceled"); throw new Error("canceled"); }

            const jitter = attempts===0 ? 0 : (attempts*9973 + Math.floor(Math.random()*1000));
            const trySeed = baseSeed + jitter;

            const urlTry = buildPollinationsUrl(p, {
              model: chosenModel,
              width: targetW, height: targetH,
              seed: trySeed, nologo,
              quality: `m${chosenModel}-a${attempts}`
            });

            const img = await toFormatted(urlTry, {
              format: outFormat, targetW, targetH, alt: p, signal: currentAbort.signal
            }, 3);

            if(wantUnique){
              let isDup=false;
              try{
                const h=_aHash(img,8); img.dataset.phash=h;
                for(const old of _seenHashes){ if(_hamming(h,old) <= 6){ isDup=true; break; } }
                if(!isDup) _seenHashes.add(h);
              }catch{}
              if(isDup && attempts < (extraBad + extraDup)){ attempts++; continue; }
            }

            img.dataset.seed = String(trySeed);
            finalImg = img; break;
          }

          if(!finalImg) throw new Error("Failed to get a good, unique image.");
          addToGallery(finalImg, p, (els.gpuEnable && els.gpuEnable.checked ? "GPU" : "CPU") + " • " + chosenModel + " • auto", i);

        }catch(err){
          const m=String((err && err.message) || err || "");
          if(m.includes("SKIP_BAD_IMAGE")){
            skipped++; if(els.skipCounter) els.skipCounter.textContent = `Skipped: ${skipped}`;
          }
          els.statusText.textContent = `Skipped (${m})`;
        }

        k++; setProgress(k, n*prompts.length);
        await idle(30);
      }
    }
    setProgress(n*prompts.length, n*prompts.length);
    setBusy(false, "Done");
  }finally{
    running=false;
    els.gen.disabled=false;
    els.stop.disabled=true;
    currentAbort=null;
  }
}

/* ---------- Download all ---------- */
async function downloadAllZip(){
  const imgs = Array.from(document.querySelectorAll(".imgwrap img"));
  if(!imgs.length) return;
  // lazy-load zip libs if not already loaded
  if(!window.JSZip){
    const s1=document.createElement("script"); s1.src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
    const s2=document.createElement("script"); s2.src="https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js";
    document.head.appendChild(s1); await new Promise(r=>s1.onload=r);
    document.head.appendChild(s2); await new Promise(r=>s2.onload=r);
  }
  const zip=new window.JSZip(); let i=1;
  for(const img of imgs){
    const src=img.dataset.downloadHref || img.src;
    const resp=await fetch(src); const blob=await resp.blob(); const arrBuf=await blob.arrayBuffer();
    const ext=(img.dataset.format||"png").replace("jpg","jpeg");
    const name=filenameFromPrompt(img.alt||"image", i++, ext);
    zip.file(name, arrBuf);
  }
  const content=await zip.generateAsync({ type:"blob" });
  window.saveAs(content,"images.zip");
}

/* ---------- Wire events ---------- */
els.gen.addEventListener("click", (e)=>{ e.preventDefault(); generateBatch(); });
els.stop.addEventListener("click", ()=>{ cancel=true; if(currentAbort){ try{ currentAbort.abort(); }catch{} } setBusy(false,"Canceled"); });
els.clear.addEventListener("click", ()=>{ els.gallery.innerHTML=""; setProgress(0,0); updatePromptCount(); });
els.downloadAll.addEventListener("click", downloadAllZip);
els.surprise.addEventListener("click", ()=>{ els.prompt.value = samples[Math.floor(Math.random()*samples.length)]; updatePromptCount(); });

els.prompt.addEventListener("input", updatePromptCount);
els.multi.addEventListener("change", updatePromptCount);
els.delimiter.addEventListener("change", updatePromptCount);

/* ---------- Defaults & GPU badge ---------- */
(function init(){
  els.prompt.value = samples[0];
  updatePromptCount();
  updateDerivedHeight();
  setGpuBadge();

  // global error surfacing
  window.addEventListener("error", ev=>{
    const msg=(ev?.error?.message) || ev?.message || "Unknown error";
    console.error("Global error:", ev?.error || ev);
    els.statusText.textContent = `Error: ${msg}`;
    setBusy(true,"Error");
  });
  window.addEventListener("unhandledrejection", ev=>{
    const msg=(ev?.reason?.message) || ev?.reason || "Unknown promise rejection";
    console.error("Unhandled rejection:", ev?.reason);
    els.statusText.textContent = `Async error: ${msg}`;
    setBusy(true,"Error");
  });
})();
