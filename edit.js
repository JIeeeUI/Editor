"use strict";

/* =========================================================
   1. 상수 / 상태
   ========================================================= */
const RATIOS = {
  "1:1": [1080, 1080], "4:5": [1080, 1350], "9:16": [1080, 1920],
  "16:9": [1920, 1080], "1.91:1": [1080, 566], "3:4": [1080, 1440],
};
const STORAGE_KEY = "card-studio:templates:v1";
const HANDLE_R = 5, HANDLE_HIT = 12, ROTATE_R = 10, ROTATE_HIT = 15, ROTATE_OFFSET = 30;
const ACCENT = "#7b61ff";

const DEFAULT_TEXT = {
  type: "text", visible: true, text: "텍스트를 입력하세요",
  x: 0.5, y: 0.5, fontSize: 80, fontFamily: "'Black Han Sans', sans-serif",
  fontWeight: "normal", fontStyle: "normal", textDecoration: "none",
  color: "#333333", align: "center", letterSpacing: 0, lineHeight: 1.3, maxWidth: 0.9,
  scaleX: 1, scaleY: 1, rotation: 0,
};
const DEFAULT_MEDIA = {
  type: "image", visible: true, src: "", x: 0.5, y: 0.5,
  scaleX: 1, scaleY: 1, rotation: 0, originalRatio: 1,
  startTime: 0, endTime: 0, duration: 0,
  brightness: 0, contrast: 0, saturation: 0, hue: 0,
  crop: { top: 0, right: 0, bottom: 0, left: 0 }
};

const $ = (id) => document.getElementById(id);
const uuid = () => crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
const newTextLayer = (extra = {}) => ({ ...DEFAULT_TEXT, id: uuid(), ...extra });
const isMedia = (L) => L.type === "image" || L.type === "video";

const firstLayer = newTextLayer();
const state = { ratio: "1:1", layers: [firstLayer], selectedLayerId: firstLayer.id };

const mediaCache = new Map();           // src -> HTMLImageElement | HTMLVideoElement
const measureCtx = document.createElement("canvas").getContext("2d");
let renderQueued = false;
let draggedLayerId = null;
let isPlaying = false, animationFrameId = null;
let drag = null;                        // 캔버스 드래그 상태 { mode, ... }

const getSelectedLayer = () => state.layers.find((l) => l.id === state.selectedLayerId);
const getCanvas = () => $("preview");

/* =========================================================
   2. 유틸
   ========================================================= */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer;
function toast(msg) {
  let el = $("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

async function ensureFonts() {
  try {
    await Promise.all([
      document.fonts.load('700 80px "Noto Sans KR"'),
      ...["Black Han Sans", "Nanum Gothic", "Nanum Myeongjo", "Nanum Pen Script"].map((f) => document.fonts.load(`80px "${f}"`)),
    ]);
  } catch (_) { /* 폰트 로드 실패는 무시 */ }
  await document.fonts.ready;
}

/* =========================================================
   3. 미디어 로딩
   ========================================================= */
function loadMediaElement(src, type) {
  return new Promise((resolve, reject) => {
    if (type === "video") {
      const v = document.createElement("video");
      v.crossOrigin = "anonymous"; v.muted = true; v.playsInline = true;
      v.onloadedmetadata = () => resolve(v);
      v.onerror = () => reject(new Error("동영상을 열 수 없습니다."));
      v.src = src;
    } else {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("이미지를 열 수 없습니다."));
      img.src = src;
    }
  });
}

async function addMediaLayer(file, isBatch = false) {
  const isVideo = file.type.startsWith("video/");
  const isImage = file.type === "image/png" || file.type === "image/jpeg";
  if (!isVideo && !isImage) return false;

  try {
    const src = URL.createObjectURL(file);
    const el = await loadMediaElement(src, isVideo ? "video" : "image");
    mediaCache.set(src, el);

    const originalRatio = isVideo ? el.videoHeight / el.videoWidth : el.height / el.width;
    const duration = isVideo ? el.duration : 0;
    const jitter = () => (isBatch ? (Math.random() - 0.5) * 0.15 : 0);

    const layer = {
      ...DEFAULT_MEDIA, id: uuid(), type: isVideo ? "video" : "image",
      src, originalRatio, endTime: duration, duration,
      x: 0.5 + jitter(), y: 0.5 + jitter(),
    };
    state.layers.push(layer);
    state.selectedLayerId = layer.id;
    return true;
  } catch (err) {
    toast("오류: " + err.message);
    return false;
  }
}

async function handleMultipleFiles(files) {
  if (!files.length) return;
  const isBatch = files.length > 1;
  let ok = 0;
  for (const f of files) if (await addMediaLayer(f, isBatch)) ok++;

  if (ok) { refreshUI(); toast(`${ok}개의 파일이 추가되었습니다.`); }
  else toast("지원하지 않는 파일 형식입니다.");
}

/* =========================================================
   4. 텍스트 레이아웃 / 핸들 기하
   ========================================================= */
function applyTextStyle(ctx, L, scale) {
  ctx.font = `${L.fontStyle} ${L.fontWeight} ${L.fontSize * scale}px ${L.fontFamily}`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${L.letterSpacing * scale}px`;
}

function getGraphemes(text) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    return [...new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(text)].map((s) => s.segment);
  }
  return [...text];
}

function wrapText(ctx, text, maxWidth) {
  const out = [];
  for (const para of String(text).split("\n")) {
    if (!para) { out.push(""); continue; }
    let cur = "";
    for (const g of getGraphemes(para)) {
      if (cur && ctx.measureText(cur + g).width > maxWidth) { out.push(cur); cur = g; }
      else cur += g;
    }
    if (cur) out.push(cur);
  }
  return out;
}

function layoutText(ctx, L, W) {
  const scale = W / 1080;
  applyTextStyle(ctx, L, scale);
  const lines = wrapText(ctx, L.text, L.maxWidth * W);
  const lineHeight = L.fontSize * scale * L.lineHeight;
  const maxLineW = Math.max(10, ...lines.map((l) => ctx.measureText(l).width));
  return { lines, lineHeight, width: maxLineW, height: Math.max(lines.length, 1) * lineHeight, scale };
}

function getHandles(L, W, H) {
  let box;
  if (L.type === "text") {
    const t = layoutText(measureCtx, L, W);
    box = { left: -t.width / 2, top: -t.height / 2, w: t.width, h: t.height };
  } else if (isMedia(L)) {
    const w = W;
    let h = W * L.originalRatio;
    
    if (L.crop) {
      const cw = 1 - L.crop.left - L.crop.right;
      const ch = 1 - L.crop.top - L.crop.bottom;
      if (cw > 0.01 && ch > 0.01) {
        h = w * L.originalRatio * (ch / cw);
      }
    }
    box = { left: -w / 2, top: -h / 2, w, h };
  } else return null;

  const cos = Math.cos(L.rotation), sin = Math.sin(L.rotation);
  const tx = L.x * W, ty = L.y * H;
  const toCanvas = (px, py) => {
    const sx = px * L.scaleX, sy = py * L.scaleY;
    return { x: tx + sx * cos - sy * sin, y: ty + sx * sin + sy * cos };
  };

  const { left, top, w, h } = box;
  const mx = left + w / 2, my = top + h / 2;
  const pts = [
    ["tl", left, top], ["tc", mx, top], ["tr", left + w, top], ["mr", left + w, my],
    ["br", left + w, top + h], ["bc", mx, top + h], ["bl", left, top + h], ["ml", left, my],
  ];
  const points = pts.map(([type, px, py]) => ({ ...toCanvas(px, py), type }));
  const rotPoint = toCanvas(mx, top - ROTATE_OFFSET / L.scaleY);
  const center = toCanvas(mx, my);
  return { points, rotPoint, cx: center.x, cy: center.y };
}

function getLayerBounds(L, W, H) {
  const h = getHandles(L, W, H);
  if (!h) return null;
  const xs = h.points.map((p) => p.x), ys = h.points.map((p) => p.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/* =========================================================
   5. 렌더링
   ========================================================= */
function drawTextLayer(ctx, L, W) {
  const t = layoutText(ctx, L, W);
  ctx.fillStyle = L.color;
  ctx.textAlign = "left"; 
  ctx.textBaseline = "middle";
  
  const top = -t.height / 2;
  const boxLeft = -t.width / 2; 

  t.lines.forEach((ln, i) => {
    const y = top + i * t.lineHeight + t.lineHeight / 2;
    const lineW = ctx.measureText(ln).width;
    
    let x = boxLeft;
    if (L.align === "center") {
      x = -lineW / 2;
    } else if (L.align === "right") {
      x = -boxLeft - lineW;
    }
    
    ctx.fillText(ln, x, y);
    
    if (L.textDecoration === "underline") {
      ctx.beginPath();
      ctx.strokeStyle = L.color;
      ctx.lineWidth = Math.max(1, L.fontSize * t.scale * 0.05);
      ctx.moveTo(x, y + L.fontSize * t.scale * 0.35);
      ctx.lineTo(x + lineW, y + L.fontSize * t.scale * 0.35);
      ctx.stroke();
    }
  });
}

function drawSelection(ctx, L, W, H) {
  const handles = getHandles(L, W, H);
  if (!handles) return;
  const { points, rotPoint } = handles;

  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  [0, 2, 4, 6].forEach((i, k) => (k ? ctx.lineTo(points[i].x, points[i].y) : ctx.moveTo(points[i].x, points[i].y)));
  ctx.closePath();
  ctx.moveTo(points[1].x, points[1].y);
  ctx.lineTo(rotPoint.x, rotPoint.y);
  ctx.stroke();

  const dot = (x, y, r) => {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#fff"; ctx.fill(); ctx.stroke();
  };
  points.forEach((p) => dot(p.x, p.y, HANDLE_R));
  dot(rotPoint.x, rotPoint.y, ROTATE_R);

  ctx.fillStyle = ACCENT;
  ctx.font = "bold 12px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("↻", rotPoint.x, rotPoint.y + 1);
}

function renderCard(ctx, W, H) {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);

  for (const L of state.layers) {
    if (!L.visible) continue;

    const media = isMedia(L) ? mediaCache.get(L.src) : null;
    const drawable = L.type === "text" || (media && !(L.type === "video" && media.readyState < 2));

    if (drawable) {
      ctx.save();
      ctx.translate(L.x * W, L.y * H);
      ctx.rotate(L.rotation);
      ctx.scale(L.scaleX, L.scaleY);
      
      if (L.type === "text") {
        drawTextLayer(ctx, L, W);
      } else {
        const b = 1 + (L.brightness || 0) / 100;
        const c = 1 + (L.contrast || 0) / 100;
        const s = 1 + (L.saturation || 0) / 100;
        ctx.filter = `brightness(${b}) contrast(${c}) saturate(${s}) hue-rotate(${L.hue || 0}deg)`;

        const dw = W;
        let dh = W * L.originalRatio;
        
        let sx = 0, sy = 0, sw = media.width, sh = media.height;
        if (L.crop) {
          const cw = 1 - L.crop.left - L.crop.right;
          const ch = 1 - L.crop.top - L.crop.bottom;
          if (cw > 0.01 && ch > 0.01) {
            sx = media.width * L.crop.left;
            sy = media.height * L.crop.top;
            sw = media.width * cw;
            sh = media.height * ch;
            dh = dw * L.originalRatio * (ch / cw);
          }
        }
        ctx.drawImage(media, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
        ctx.filter = "none";
      }
      ctx.restore();
    }
    if (L.id === state.selectedLayerId) drawSelection(ctx, L, W, H);
  }
}

async function drawPreview() {
  const [W, H] = RATIOS[state.ratio];
  const canvas = getCanvas();
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  await document.fonts.ready;
  renderCard(canvas.getContext("2d"), W, H);
}

function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(async () => { renderQueued = false; await drawPreview(); });
}

/* =========================================================
   6. 동영상 재생 / 녹화
   ========================================================= */
const videoLayers = () => state.layers.filter((l) => l.type === "video" && l.visible);
const getVideo = (L) => mediaCache.get(L.src);

function startPlayback() {
  if (isPlaying) return;
  isPlaying = true;
  $("preview-play-btn").textContent = "⏸ 정지";
  $("floating-toolbar").classList.remove("show");

  for (const L of videoLayers()) {
    const v = getVideo(L);
    if (v) { v.currentTime = L.startTime; v.play(); }
  }
  const loop = () => {
    if (!isPlaying) return;
    for (const L of videoLayers()) {
      const v = getVideo(L);
      if (v && (v.currentTime >= L.endTime || v.currentTime < L.startTime)) v.currentTime = L.startTime;
    }
    renderCard(getCanvas().getContext("2d"), ...RATIOS[state.ratio]);
    animationFrameId = requestAnimationFrame(loop);
  };
  loop();
}

function stopPlayback() {
  isPlaying = false;
  cancelAnimationFrame(animationFrameId);
  $("preview-play-btn").textContent = "▶ 미리보기 재생";
  for (const L of state.layers.filter((l) => l.type === "video")) {
    const v = getVideo(L);
    if (v) { v.pause(); v.currentTime = L.startTime; }
  }
  requestRender();
}

async function handleDownloadPng() {
  const [W, H] = RATIOS[state.ratio];
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  await document.fonts.ready;

  const prev = state.selectedLayerId;
  state.selectedLayerId = null;
  renderCard(c.getContext("2d"), W, H);
  state.selectedLayerId = prev;

  c.toBlob((blob) => downloadBlob(blob, `card-${state.ratio.replace(/[:.]/g, "-")}-${Date.now()}.png`), "image/png");
}

async function handleDownloadWebm() {
  const vids = videoLayers();
  if (!vids.length) return toast("동영상 레이어가 없습니다.");

  stopPlayback();
  toast("동영상을 녹화합니다...");
  const prev = state.selectedLayerId;
  state.selectedLayerId = null;

  const [W, H] = RATIOS[state.ratio];
  const canvas = getCanvas();
  const ctx = canvas.getContext("2d");

  vids.forEach((L) => { const v = getVideo(L); if (v) v.currentTime = L.startTime; });
  await new Promise((r) => setTimeout(r, 100));
  renderCard(ctx, W, H);

  const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm" });
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    downloadBlob(new Blob(chunks, { type: "video/webm" }), `card-video-${Date.now()}.webm`);
    toast("동영상 저장 완료!");
    state.selectedLayerId = prev;
    requestRender();
  };

  const maxDuration = Math.max(...vids.map((L) => L.endTime - L.startTime));
  vids.forEach((L) => { const v = getVideo(L); if (v) { v.currentTime = L.startTime; v.play(); } });

  recorder.start();
  const t0 = performance.now();
  const tick = () => {
    renderCard(ctx, W, H);
    const allDone = vids.every((L) => { const v = getVideo(L); return !v || v.currentTime >= L.endTime; });
    if ((performance.now() - t0) / 1000 < maxDuration && !allDone) return requestAnimationFrame(tick);
    recorder.stop();
    vids.forEach((L) => getVideo(L)?.pause());
  };
  tick();
}

/* =========================================================
   7. 레이어 목록 / 컨트롤 동기화
   ========================================================= */
function refreshUI() { syncControls(); renderLayerList(); requestRender(); }

function layerLabel(L) {
  if (L.type === "text") return L.text.trim().substring(0, 12) || "(빈 텍스트)";
  return L.type === "video" ? "동영상" : "이미지";
}

function createLayerItem(L) {
  const li = document.createElement("li");
  li.dataset.id = L.id;
  li.draggable = true;
  li.classList.toggle("selected", L.id === state.selectedLayerId);
  li.classList.toggle("hidden-layer", !L.visible);

  const vis = document.createElement("span");
  vis.className = "layer-vis";
  vis.textContent = L.visible ? "👁" : "🚫";
  vis.onclick = (e) => { e.stopPropagation(); L.visible = !L.visible; renderLayerList(); requestRender(); };

  const thumb = document.createElement("div");
  thumb.className = "layer-thumb";
  if (L.type === "text") { thumb.textContent = "T"; thumb.style.cssText = `font-weight:bold;color:${L.color}`; }
  else if (L.type === "video") { thumb.textContent = "🎬"; thumb.style.fontSize = "14px"; }
  else { const img = document.createElement("img"); img.src = L.src; thumb.appendChild(img); }

  const name = document.createElement("span");
  name.className = "layer-name";
  name.textContent = layerLabel(L);

  li.append(vis, thumb, name);
  li.onclick = () => { state.selectedLayerId = L.id; refreshUI(); };

  li.ondragstart = (e) => {
    draggedLayerId = L.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", L.id);
    setTimeout(() => li.classList.add("dragging"), 0);
  };
  li.ondragend = () => {
    draggedLayerId = null;
    document.querySelectorAll(".layer-list li").forEach((el) => el.classList.remove("dragging", "drag-over"));
  };
  li.ondragover = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (draggedLayerId && draggedLayerId !== L.id) li.classList.add("drag-over");
  };
  li.ondragleave = () => li.classList.remove("drag-over");
  li.ondrop = (e) => {
    e.preventDefault();
    li.classList.remove("drag-over");
    if (!draggedLayerId || draggedLayerId === L.id) return;
    const from = state.layers.findIndex((l) => l.id === draggedLayerId);
    const to = state.layers.findIndex((l) => l.id === L.id);
    if (from < 0 || to < 0) return;
    state.layers.splice(to, 0, state.layers.splice(from, 1)[0]);
    renderLayerList(); requestRender();
  };
  return li;
}

function renderLayerList() {
  const ul = $("layer-list");
  ul.innerHTML = "";
  [...state.layers].reverse().forEach((L) => ul.appendChild(createLayerItem(L)));
}

function syncControls() {
  const L = getSelectedLayer();
  const toolbar = $("floating-toolbar");
  if (!L) { toolbar.classList.remove("show"); return; }

  document.querySelectorAll(".ratio-btn").forEach((b) => b.classList.toggle("active", b.dataset.ratio === state.ratio));
  $("x-input").value = Math.round(L.x * 100);
  $("y-input").value = Math.round(L.y * 100);

  const isText = L.type === "text";
  const isMediaType = isMedia(L);
  
  toolbar.classList.toggle("show", isText || isMediaType);
  $("toolbar-text").style.display = isText ? "contents" : "none";
  $("tb-image-group").style.display = isMediaType ? "contents" : "none";

  $("text-controls").style.display = isText ? "block" : "none";
  $("image-controls").style.display = isMediaType ? "block" : "none";
  $("video-controls").style.display = L.type === "video" ? "block" : "none";

  if (isText) {
    $("text-input").value = L.text;
    $("tb-font-family").value = L.fontFamily;
    $("tb-size-input").value = L.fontSize;
    $("tb-bold").classList.toggle("active", L.fontWeight === "bold");
    $("tb-italic").classList.toggle("active", L.fontStyle === "italic");
    $("tb-underline").classList.toggle("active", L.textDecoration === "underline");
    ["left", "center", "right"].forEach((a) => $("tb-align-" + a).classList.toggle("active", L.align === a));
    $("tb-letter-spacing").value = L.letterSpacing;
    $("val-letter-spacing").textContent = L.letterSpacing;
    $("tb-line-height").value = L.lineHeight;
    $("val-line-height").textContent = L.lineHeight;
    $("tb-color-input").value = L.color;
  } else if (isMediaType) {
    $("img-brightness").value = L.brightness || 0;
    $("img-contrast").value = L.contrast || 0;
    $("img-saturation").value = L.saturation || 0;
    $("img-hue").value = L.hue || 0;
    
    const isAuto = (L.brightness === 15 && L.contrast === 10 && L.saturation === 15);
    $("img-auto").checked = isAuto;

    $("crop-top").value = Math.round((L.crop?.top || 0) * 100);
    $("crop-bottom").value = Math.round((L.crop?.bottom || 0) * 100);
    $("crop-left").value = Math.round((L.crop?.left || 0) * 100);
    $("crop-right").value = Math.round((L.crop?.right || 0) * 100);

    $("scale-x-input").value = L.scaleX;
    $("scale-y-input").value = L.scaleY;
    $("rotation-input").value = Math.round(L.rotation * 180 / Math.PI);
    
    if (L.type === "video") {
      $("video-start-input").max = $("video-end-input").max = L.duration;
      $("video-start-input").value = L.startTime;
      $("video-end-input").value = L.endTime;
      $("start-time-text").textContent = L.startTime.toFixed(1) + "s";
      $("end-time-text").textContent = L.endTime.toFixed(1) + "s";
    }
  }
  $("download-webm-btn").disabled = !state.layers.some((l) => l.type === "video");
}

/* =========================================================
   8. 템플릿 / JSON
   ========================================================= */
function getTemplates() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return []; }
}
const setTemplates = (list) => localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
const serializeDoc = () => ({ ratio: state.ratio, layers: state.layers.map((l) => ({ ...l })) });

async function applyDoc(doc) {
  state.ratio = doc.ratio in RATIOS ? doc.ratio : "1:1";

  if (Array.isArray(doc.layers) && doc.layers.length) {
    state.layers = doc.layers.map((l) => {
      const n = { ...l, id: uuid() };
      if (n.type !== "text") {
        n.scaleX ??= l.scale || 1;
        n.scaleY ??= l.scale || 1;
        n.rotation ??= 0;
        n.brightness ??= 0;
        n.contrast ??= 0;
        n.saturation ??= 0;
        n.hue ??= 0;
        n.crop ??= { top: 0, right: 0, bottom: 0, left: 0 };
      }
      return n;
    });
    for (const L of state.layers) {
      if (isMedia(L) && L.src && !mediaCache.has(L.src)) {
        try { mediaCache.set(L.src, await loadMediaElement(L.src, L.type)); } catch { }
      }
    }
  } else {
    state.layers = [newTextLayer()];
  }
  state.selectedLayerId = state.layers[state.layers.length - 1].id;
  syncControls(); renderLayerList(); await drawPreview();
}

function renderTemplateList() {
  const ul = $("template-list");
  const list = getTemplates();
  if (!list.length) { ul.innerHTML = '<li class="empty">저장된 템플릿이 없습니다.</li>'; return; }
  ul.innerHTML = list.map((t) =>
    `<li data-id="${t.id}"><span class="tname">${escapeHtml(t.name)}</span>` +
    `<button data-action="load">불러오기</button><button data-action="delete">삭제</button></li>`
  ).join("");
}

function saveCurrentTemplate() {
  const input = $("template-name");
  const list = getTemplates();
  const name = input.value.trim() || `템플릿 ${list.length + 1}`;
  list.push({ id: uuid(), name, doc: serializeDoc(), createdAt: new Date().toISOString() });
  try { setTemplates(list); } catch { return toast("저장 실패: 용량 부족"); }
  input.value = "";
  renderTemplateList();
  toast(`"${name}" 저장됨`);
}

async function loadTemplateById(id) {
  const t = getTemplates().find((x) => x.id === id);
  if (!t) return;
  await applyDoc(t.doc);
  toast(`"${t.name}" 불러옴`);
}

function deleteTemplateById(id) {
  setTemplates(getTemplates().filter((x) => x.id !== id));
  renderTemplateList();
  toast("삭제됨");
}

function exportJson() {
  const blob = new Blob([JSON.stringify({ schemaVersion: 2, templates: getTemplates() }, null, 2)], { type: "application/json" });
  downloadBlob(blob, `card-studio-backup-${Date.now()}.json`);
}

function importJson(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data || !Array.isArray(data.templates)) throw new Error("잘못된 JSON 형식입니다.");
      
      const existing = getTemplates();
      const merged = [...existing];
      
      for (const t of data.templates) {
        if (!t.id || !t.name || !t.doc || !Array.isArray(t.doc.layers)) {
          throw new Error("필수 항목(템플릿 구조)이 누락되었습니다.");
        }
        if (!merged.find(x => x.id === t.id)) merged.push(t);
      }
      
      setTemplates(merged);
      renderTemplateList();
      toast("JSON을 성공적으로 가져왔습니다.");
    } catch (err) {
      toast("JSON 가져오기 실패: " + err.message);
    }
  };
  reader.readAsText(file);
}

/* =========================================================
   9. 캔버스 상호작용 (선택 / 이동 / 크기 / 회전)
   ========================================================= */
function getCanvasCoords(e) {
  const canvas = getCanvas();
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
}

function hitTestHandle(x, y) {
  const L = getSelectedLayer();
  if (!L || !L.visible) return null;
  const canvas = getCanvas();
  const handles = getHandles(L, canvas.width, canvas.height);
  if (!handles) return null;

  if (Math.hypot(x - handles.rotPoint.x, y - handles.rotPoint.y) < ROTATE_HIT) return { handles, rotate: true };
  const point = handles.points.find((p) => Math.hypot(x - p.x, y - p.y) < HANDLE_HIT);
  return point ? { handles, point } : null;
}

function hitTestLayer(x, y) {
  const { width: W, height: H } = getCanvas();
  for (let i = state.layers.length - 1; i >= 0; i--) {
    const L = state.layers[i];
    if (!L.visible) continue;
    const b = getLayerBounds(L, W, H);
    if (b && x >= b.left - 10 && x <= b.right + 10 && y >= b.top - 10 && y <= b.bottom + 10) return L;
  }
  return null;
}

const CURSORS = { tl: "nwse-resize", br: "nwse-resize", tr: "nesw-resize", bl: "nesw-resize", tc: "ns-resize", bc: "ns-resize", ml: "ew-resize", mr: "ew-resize" };

function onCanvasMouseDown(e) {
  if (isPlaying) return;
  const { x, y } = getCanvasCoords(e);
  const L = getSelectedLayer();

  const hit = hitTestHandle(x, y);
  if (hit?.rotate) {
    drag = { mode: "rotate", startAngle: Math.atan2(y - hit.handles.cy, x - hit.handles.cx), startRotation: L.rotation };
    return;
  }
  if (hit?.point) {
    const { handles } = hit;
    drag = {
      mode: "resize", handle: hit.point.type,
      startScaleX: L.scaleX, startScaleY: L.scaleY,
      distX: Math.abs(x - handles.cx), distY: Math.abs(y - handles.cy),
      dist: Math.hypot(x - handles.cx, y - handles.cy),
    };
    return;
  }

  const target = hitTestLayer(x, y);
  if (target) {
    state.selectedLayerId = target.id;
    refreshUI();
    drag = { mode: "move", startX: x, startY: y, layerX: target.x, layerY: target.y };
  }
}

function onWindowMouseMove(e) {
  if (!drag) return;
  const L = getSelectedLayer();
  if (!L) return;
  const canvas = getCanvas();
  const { x, y } = getCanvasCoords(e);

  if (drag.mode === "rotate") {
    const h = getHandles(L, canvas.width, canvas.height);
    if (h) L.rotation = drag.startRotation + (Math.atan2(y - h.cy, x - h.cx) - drag.startAngle);
  } else if (drag.mode === "resize") {
    const h = getHandles(L, canvas.width, canvas.height);
    if (!h) return;
    const ratio = (cur, start) => cur / Math.max(1, start);
    const clamp = (v) => Math.max(0.1, v);

    if (drag.handle === "mr" || drag.handle === "ml") {
      L.scaleX = clamp(drag.startScaleX * ratio(Math.abs(x - h.cx), drag.distX));
    } else if (drag.handle === "tc" || drag.handle === "bc") {
      L.scaleY = clamp(drag.startScaleY * ratio(Math.abs(y - h.cy), drag.distY));
    } else {
      const s = ratio(Math.hypot(x - h.cx, y - h.cy), drag.dist);
      L.scaleX = clamp(drag.startScaleX * s);
      L.scaleY = clamp(drag.startScaleY * s);
    }
  } else if (drag.mode === "move") {
    L.x = Math.max(0, Math.min(1, drag.layerX + (x - drag.startX) / canvas.width));
    L.y = Math.max(0, Math.min(1, drag.layerY + (y - drag.startY) / canvas.height));
    $("x-input").value = Math.round(L.x * 100);
    $("y-input").value = Math.round(L.y * 100);
  }
  requestRender();
}

function onCanvasHover(e) {
  if (drag || isPlaying) return;
  const canvas = getCanvas();
  const { x, y } = getCanvasCoords(e);
  const hit = hitTestHandle(x, y);
  if (hit) canvas.style.cursor = hit.rotate ? "crosshair" : CURSORS[hit.point.type];
  else canvas.style.cursor = hitTestLayer(x, y) ? "grab" : "default";
}

function initCanvasDrag() {
  const canvas = getCanvas();
  canvas.addEventListener("mousedown", onCanvasMouseDown);
  canvas.addEventListener("mousemove", onCanvasHover);
  window.addEventListener("mousemove", onWindowMouseMove);
  window.addEventListener("mouseup", () => { drag = null; canvas.style.cursor = "default"; });
}

/* =========================================================
   10. 이벤트 바인딩
   ========================================================= */
function editText(fn) {
  const L = getSelectedLayer();
  if (!L || L.type !== "text") return;
  fn(L);
  refreshUI();
}
function editMedia(fn, { sync = false } = {}) {
  const L = getSelectedLayer();
  if (!L || !isMedia(L)) return;
  fn(L);
  sync ? syncControls() : null;
  requestRender();
}
function closePopovers() {
  document.querySelectorAll(".tb-popover").forEach((p) => p.classList.remove("show"));
}

function togglePopover(pop, btn) {
  const willOpen = !pop.classList.contains("show");
  closePopovers();
  if (!willOpen) return;
  pop.classList.add("show");
  const wrap = pop.parentElement.getBoundingClientRect();
  const b = btn.getBoundingClientRect();
  const left = Math.max(0, Math.min(b.right - wrap.left - pop.offsetWidth, wrap.width - pop.offsetWidth));
  pop.style.left = left + "px";
  pop.style.top = b.bottom - wrap.top + 8 + "px";
}
function bindToolbarEvents() {
  $("tb-font-family").onchange = (e) => editText((L) => (L.fontFamily = e.target.value));
  $("tb-size-minus").onclick = () => editText((L) => (L.fontSize = Math.max(10, L.fontSize - 5)));
  $("tb-size-plus").onclick = () => editText((L) => (L.fontSize = Math.min(300, L.fontSize + 5)));
  $("tb-size-input").onchange = (e) => editText((L) => (L.fontSize = Number(e.target.value)));

  const toggle = (key, on, off) => editText((L) => (L[key] = L[key] === on ? off : on));
  $("tb-bold").onclick = () => toggle("fontWeight", "bold", "normal");
  $("tb-italic").onclick = () => toggle("fontStyle", "italic", "normal");
  $("tb-underline").onclick = () => toggle("textDecoration", "underline", "none");

  $("tb-color-input").oninput = (e) => editText((L) => (L.color = e.target.value));
  ["left", "center", "right"].forEach((a) => ($("tb-align-" + a).onclick = () => editText((L) => (L.align = a))));

const popover = $("spacing-popover");
$("tb-spacing-btn").onclick = (e) => { e.stopPropagation(); togglePopover(popover, e.currentTarget); };
document.addEventListener("click", closePopovers);
popover.onclick = (e) => e.stopPropagation();

  $("tb-letter-spacing").oninput = (e) => editText((L) => (L.letterSpacing = Number(e.target.value)));
  $("tb-line-height").oninput = (e) => editText((L) => (L.lineHeight = Number(e.target.value)));
}

function bindImageToolbarEvents() {
  const getMedia = () => { const L = getSelectedLayer(); return (L && isMedia(L)) ? L : null; };
  
  const syncAndRender = () => {
    const L = getMedia();
    if (!L) return;
    requestRender();
  };

  $("img-brightness").oninput = (e) => { const L = getMedia(); if (L) { L.brightness = Number(e.target.value); syncAndRender(); } };
  $("img-contrast").oninput = (e) => { const L = getMedia(); if (L) { L.contrast = Number(e.target.value); syncAndRender(); } };
  $("img-saturation").oninput = (e) => { const L = getMedia(); if (L) { L.saturation = Number(e.target.value); syncAndRender(); } };
  $("img-hue").oninput = (e) => { const L = getMedia(); if (L) { L.hue = Number(e.target.value); syncAndRender(); } };

  $("img-auto").onchange = (e) => {
    const L = getMedia(); if (!L) return;
    if (e.target.checked) {
      L.brightness = 15;
      L.contrast = 10;
      L.saturation = 15;
      L.hue = 0;
    } else {
      L.brightness = 0;
      L.contrast = 0;
      L.saturation = 0;
      L.hue = 0;
    }
    syncControls();
    requestRender();
  };

  $("img-reset-adjust").onclick = () => {
    const L = getMedia(); if (!L) return;
    L.brightness = 0; L.contrast = 0; L.saturation = 0; L.hue = 0;
    $("img-auto").checked = false;
    syncControls(); requestRender();
  };

  $("img-rotate-left").onclick = () => { const L = getMedia(); if (L) { L.rotation -= Math.PI/2; requestRender(); } };
  $("img-rotate-right").onclick = () => { const L = getMedia(); if (L) { L.rotation += Math.PI/2; requestRender(); } };

  const cropBtn = $("img-crop-btn");
  const cropPopover = $("crop-popover");
  cropBtn.onclick = (e) => { e.stopPropagation(); togglePopover(cropPopover, cropBtn); };
  cropPopover.onclick = (e) => e.stopPropagation();

  const onCropChange = () => {
    const L = getMedia(); if (!L) return;
    L.crop.top = Number($("crop-top").value) / 100;
    L.crop.bottom = Number($("crop-bottom").value) / 100;
    L.crop.left = Number($("crop-left").value) / 100;
    L.crop.right = Number($("crop-right").value) / 100;
    requestRender();
  };
  $("crop-top").oninput = onCropChange;
  $("crop-bottom").oninput = onCropChange;
  $("crop-left").oninput = onCropChange;
  $("crop-right").oninput = onCropChange;
}

function bindLayerEvents() {
  const menu = $("add-layer-menu");
  $("add-layer-btn").onclick = (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); };
  document.addEventListener("click", () => menu.classList.add("hidden"));
  menu.onclick = (e) => e.stopPropagation();

  $("menu-add-text").onclick = () => {
    const y = 0.3 + state.layers.length * 0.05;
    const layer = newTextLayer({ y: y > 0.9 ? 0.5 : y });
    state.layers.push(layer);
    state.selectedLayerId = layer.id;
    refreshUI();
    menu.classList.add("hidden");
  };
  $("menu-add-media").onclick = () => { $("hidden-media-input").click(); menu.classList.add("hidden"); };
  $("hidden-media-input").onchange = async (e) => {
    await handleMultipleFiles(Array.from(e.target.files));
    e.target.value = "";
  };

  $("delete-layer-btn").onclick = () => {
    if (state.layers.length <= 1) return toast("최소 1개 레이어 필요");
    state.layers = state.layers.filter((l) => l.id !== state.selectedLayerId);
    state.selectedLayerId = state.layers[state.layers.length - 1].id;
    refreshUI();
  };
}

function bindPropertyEvents() {
  const setPos = (key) => (e) => {
    const L = getSelectedLayer();
    if (L) { L[key] = Number(e.target.value) / 100; requestRender(); }
  };
  $("x-input").oninput = setPos("x");
  $("y-input").oninput = setPos("y");

  $("text-input").oninput = (e) => {
    const L = getSelectedLayer();
    if (L?.type === "text") { L.text = e.target.value; renderLayerList(); requestRender(); }
  };

  $("scale-x-input").oninput = (e) => editMedia((L) => (L.scaleX = Number(e.target.value)));
  $("scale-y-input").oninput = (e) => editMedia((L) => (L.scaleY = Number(e.target.value)));
  $("rotation-input").oninput = (e) => editMedia((L) => (L.rotation = Number(e.target.value) * Math.PI / 180));
  $("reset-transform-btn").onclick = () => editMedia((L) => { L.scaleX = L.scaleY = 1; L.rotation = 0; }, { sync: true });

  $("video-start-input").oninput = (e) => {
    const L = getSelectedLayer();
    if (L?.type !== "video") return;
    L.startTime = Math.min(Number(e.target.value), L.endTime - 0.1);
    $("start-time-text").textContent = L.startTime.toFixed(1) + "s";
    const v = getVideo(L);
    if (v && !isPlaying) v.currentTime = L.startTime;
    requestRender();
  };
  $("video-end-input").oninput = (e) => {
    const L = getSelectedLayer();
    if (L?.type !== "video") return;
    L.endTime = Math.max(Number(e.target.value), L.startTime + 0.1);
    $("end-time-text").textContent = L.endTime.toFixed(1) + "s";
    requestRender();
  };
  $("preview-play-btn").onclick = () => (isPlaying ? stopPlayback() : startPlayback());
}

function bindOutputEvents() {
  document.querySelectorAll(".ratio-btn").forEach((btn) => {
    btn.onclick = () => { state.ratio = btn.dataset.ratio; syncControls(); requestRender(); };
  });
  $("download-png-btn").onclick = handleDownloadPng;
  $("download-webm-btn").onclick = handleDownloadWebm;

  $("save-template-btn").onclick = saveCurrentTemplate;
  $("export-json-btn").onclick = exportJson;
  
  $("import-json-btn").onclick = () => $("import-json-input").click();
  $("import-json-input").onchange = (e) => {
    importJson(e.target.files[0]);
    e.target.value = "";
  };

  $("template-list").onclick = (e) => {
    const btn = e.target.closest("button");
    const id = btn?.closest("li")?.dataset.id;
    if (!id) return;
    if (btn.dataset.action === "load") loadTemplateById(id);
    if (btn.dataset.action === "delete" && confirm("삭제할까요?")) deleteTemplateById(id);
  };
}

function initRatioScroll() {
  const slider = $("ratio-group");
  let isDown = false, dragged = false, startX = 0, scrollLeft = 0;

  slider.addEventListener("mousedown", (e) => {
    isDown = true; dragged = false;
    slider.style.cursor = "grabbing";
    startX = e.pageX - slider.offsetLeft;
    scrollLeft = slider.scrollLeft;
  });
  const end = () => { isDown = false; slider.style.cursor = "grab"; };
  slider.addEventListener("mouseleave", end);
  slider.addEventListener("mouseup", end);
  slider.addEventListener("mousemove", (e) => {
    if (!isDown) return;
    e.preventDefault();
    const dx = e.pageX - slider.offsetLeft - startX;
    if (Math.abs(dx) > 5) dragged = true;
    slider.scrollLeft = scrollLeft - dx;
  });
  slider.addEventListener("click", (e) => { if (dragged) { e.preventDefault(); e.stopPropagation(); } }, true);

  $("scroll-left").onclick = () => slider.scrollBy({ left: -150, behavior: "smooth" });
  $("scroll-right").onclick = () => slider.scrollBy({ left: 150, behavior: "smooth" });
}

/* ★ 플로팅 툴바 드래그 스크롤 이벤트 */
function initToolbarDragScroll() {
  const toolbar = $("floating-toolbar");
  let isDown = false;
  let startX = 0;
  let scrollLeft = 0;
  let dragged = false;

  toolbar.addEventListener("mousedown", (e) => {
    // 입력창이나 셀렉트 박스를 클릭할 때는 드래그 스크롤 방지
    if (e.target.closest("input, select, button")) return;

    isDown = true;
    dragged = false;
    startX = e.pageX - toolbar.offsetLeft;
    scrollLeft = toolbar.scrollLeft;
  });

  const endDrag = () => {
    isDown = false;
    toolbar.style.cursor = "grab";
  };

  toolbar.addEventListener("mouseleave", endDrag);
  toolbar.addEventListener("mouseup", endDrag);

  toolbar.addEventListener("mousemove", (e) => {
    if (!isDown) return;
    e.preventDefault();
    const x = e.pageX - toolbar.offsetLeft;
    const walk = (x - startX) * 1.5; // 드래그 감도 조절 (1.5배)
    
    // 일정 거리(5px) 이상 움직이면 드래그로 간주
    if (Math.abs(walk) > 5) {
      dragged = true;
    }
    toolbar.scrollLeft = scrollLeft - walk;
  });

  // 드래그 중일 때는 클릭 이벤트(버튼 눌림 등)가 발생하지 않도록 방지
  toolbar.addEventListener("click", (e) => {
    if (dragged) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
}

function initFileDrop() {
  const overlay = $("drop-overlay");
  let counter = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");

  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (hasFiles(e)) { counter++; overlay.classList.add("show"); }
  });
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    if (--counter <= 0) { counter = 0; overlay.classList.remove("show"); }
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    counter = 0;
    overlay.classList.remove("show");
    if (e.dataTransfer.files?.length) handleMultipleFiles(Array.from(e.dataTransfer.files));
  });
}

/* =========================================================
   11. 초기화
   ========================================================= */
(async function init() {
  bindToolbarEvents();
  bindImageToolbarEvents();
  bindLayerEvents();
  bindPropertyEvents();
  bindOutputEvents();
  initRatioScroll();
  initToolbarDragScroll(); 
  initFileDrop();
  initCanvasDrag();

  await ensureFonts();
  renderTemplateList();
  syncControls();
  renderLayerList();
  await drawPreview();
})();