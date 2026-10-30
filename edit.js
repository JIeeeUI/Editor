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

const ADJUST_KEYS = ["brightness", "contrast", "saturation", "hue"];
const AUTO_ADJUST = { brightness: 15, contrast: 10, saturation: 15, hue: 0 };
const CROP_SIDES = ["top", "bottom", "left", "right"];

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
  brightness: 0, contrast: 0, saturation: 0, hue: 0,
};

const $ = (id) => document.getElementById(id);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36));
const emptyCrop = () => ({ top: 0, right: 0, bottom: 0, left: 0 });
const newTextLayer = (extra = {}) => ({ ...DEFAULT_TEXT, id: uuid(), ...extra });
const newMediaLayer = (extra = {}) => ({ ...DEFAULT_MEDIA, id: uuid(), crop: emptyCrop(), ...extra });
const isMedia = (L) => L.type === "image";

const firstLayer = newTextLayer();
const state = { ratio: "1:1", layers: [firstLayer], selectedLayerId: firstLayer.id };

const mediaCache = new Map();                              // src -> HTMLImageElement
const measureCtx = document.createElement("canvas").getContext("2d");
let renderQueued = false;
let draggedLayerId = null;                                 // 레이어 목록 드래그 중인 id
let drag = null;                                           // 캔버스 드래그 상태 { mode, ... }

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
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

/* 자르기 후 남는 영역 비율 (0.01 미만 방지) */
function getCropFraction(L) {
  const c = L.crop || {};
  return {
    cw: Math.max(0.01, 1 - (c.left || 0) - (c.right || 0)),
    ch: Math.max(0.01, 1 - (c.top || 0) - (c.bottom || 0)),
  };
}

const isAutoAdjust = (L) => ADJUST_KEYS.every((k) => (L[k] || 0) === AUTO_ADJUST[k]);

/* =========================================================
   3. 이미지 로딩
   ========================================================= */
function loadMediaElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("이미지를 열 수 없습니다."));
    img.src = src;
  });
}

async function addMediaLayer(file, isBatch = false) {
  if (file.type !== "image/png" && file.type !== "image/jpeg") return false;

  const src = URL.createObjectURL(file);
  try {
    mediaCache.set(src, await loadMediaElement(src));
  } catch (err) {
    URL.revokeObjectURL(src);
    toast("오류: " + err.message);
    return false;
  }

  const el = mediaCache.get(src);
  const jitter = () => (isBatch ? (Math.random() - 0.5) * 0.15 : 0);
  const layer = newMediaLayer({
    src, originalRatio: el.height / el.width,
    x: 0.5 + jitter(), y: 0.5 + jitter(),
  });
  state.layers.push(layer);
  state.selectedLayerId = layer.id;
  return true;
}

async function handleMultipleFiles(files) {
  if (!files.length) return;
  const isBatch = files.length > 1;
  let ok = 0;
  for (const f of files) if (await addMediaLayer(f, isBatch)) ok++;

  if (ok) { refreshUI(); toast(`${ok}개의 파일이 추가되었습니다.`); }
  else toast("지원하지 않는 파일 형식입니다. (PNG, JPEG만 가능)");
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
    const { cw, ch } = getCropFraction(L);
    const w = W * cw, h = W * L.originalRatio * ch;
    box = { left: -w / 2, top: -h / 2, w, h };
  } else {
    return null;
  }

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
    if (L.align === "center") x = -lineW / 2;
    else if (L.align === "right") x = -boxLeft - lineW;

    ctx.fillText(ln, x, y);

    if (L.textDecoration === "underline") {
      const uy = y + L.fontSize * t.scale * 0.35;
      ctx.beginPath();
      ctx.strokeStyle = L.color;
      ctx.lineWidth = Math.max(1, L.fontSize * t.scale * 0.05);
      ctx.moveTo(x, uy);
      ctx.lineTo(x + lineW, uy);
      ctx.stroke();
    }
  });
}

function drawImageLayer(ctx, L, img, W) {
  const { cw, ch } = getCropFraction(L);
  const crop = L.crop || {};
  const dw = W * cw, dh = W * L.originalRatio * ch;

  ctx.filter =
    `brightness(${1 + (L.brightness || 0) / 100}) contrast(${1 + (L.contrast || 0) / 100}) ` +
    `saturate(${1 + (L.saturation || 0) / 100}) hue-rotate(${L.hue || 0}deg)`;
  ctx.drawImage(
    img,
    img.width * (crop.left || 0), img.height * (crop.top || 0), img.width * cw, img.height * ch,
    -dw / 2, -dh / 2, dw, dh,
  );
  ctx.filter = "none";
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
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.stroke();
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

    const img = isMedia(L) ? mediaCache.get(L.src) : null;
    if (L.type !== "text" && !img) continue;

    ctx.save();
    ctx.translate(L.x * W, L.y * H);
    ctx.rotate(L.rotation);
    ctx.scale(L.scaleX, L.scaleY);
    if (L.type === "text") drawTextLayer(ctx, L, W);
    else drawImageLayer(ctx, L, img, W);
    ctx.restore();
  }

  // 선택 표시는 항상 맨 위에 그립니다
  const selected = getSelectedLayer();
  if (selected?.visible) drawSelection(ctx, selected, W, H);
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
   6. PNG 저장
   ========================================================= */
async function handleDownloadPng() {
  const [W, H] = RATIOS[state.ratio];
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  await document.fonts.ready;

  // 저장본에는 선택 핸들이 나오지 않도록 잠시 선택 해제
  const prev = state.selectedLayerId;
  state.selectedLayerId = null;
  renderCard(c.getContext("2d"), W, H);
  state.selectedLayerId = prev;

  c.toBlob((blob) => downloadBlob(blob, `card-${state.ratio.replace(/[:.]/g, "-")}-${Date.now()}.png`), "image/png");
}

/* =========================================================
   7. 레이어 목록 / 컨트롤 동기화
   ========================================================= */
function refreshUI() { syncControls(); renderLayerList(); requestRender(); }

function layerLabel(L) {
  if (L.type === "text") return L.text.trim().substring(0, 12) || "(빈 텍스트)";
  return "이미지";
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
  if (L.type === "text") {
    thumb.textContent = "T";
    thumb.style.cssText = `font-weight:bold;color:${L.color}`;
  } else {
    const img = document.createElement("img");
    img.src = L.src;
    thumb.appendChild(img);
  }

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
    renderLayerList();
    requestRender();
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
  const isImage = isMedia(L);

  toolbar.classList.toggle("show", isText || isImage);
  $("toolbar-text").hidden = !isText;
  $("toolbar-image").hidden = !isImage;
  $("text-controls").hidden = !isText;
  $("image-controls").hidden = !isImage;

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
  } else if (isImage) {
    ADJUST_KEYS.forEach((k) => ($("img-" + k).value = L[k] || 0));
    $("img-auto").checked = isAutoAdjust(L);
    CROP_SIDES.forEach((s) => ($("crop-" + s).value = Math.round((L.crop?.[s] || 0) * 100)));
    $("scale-x-input").value = L.scaleX;
    $("scale-y-input").value = L.scaleY;
    $("rotation-input").value = Math.round((L.rotation * 180) / Math.PI);
  }
}

/* =========================================================
   8. 템플릿 / JSON
   ========================================================= */
function getTemplates() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return []; }
}
const setTemplates = (list) => localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
const serializeDoc = () => ({ ratio: state.ratio, layers: state.layers.map((l) => ({ ...l })) });

/* 저장된 레이어에 빠진 필드를 기본값으로 채움 (이전 버전 데이터 호환) */
function normalizeLayer(l) {
  if (l.type === "text") return { ...DEFAULT_TEXT, ...l, id: uuid() };
  const legacyScale = l.scale || 1;
  return {
    ...DEFAULT_MEDIA, scaleX: legacyScale, scaleY: legacyScale,
    ...l, type: "image", id: uuid(),
    crop: { ...emptyCrop(), ...l.crop },
  };
}

async function applyDoc(doc) {
  state.ratio = doc.ratio in RATIOS ? doc.ratio : "1:1";

  if (Array.isArray(doc.layers) && doc.layers.length) {
    state.layers = doc.layers.map(normalizeLayer);
    await Promise.all(
      state.layers
        .filter((L) => isMedia(L) && L.src && !mediaCache.has(L.src))
        .map(async (L) => {
          try { mediaCache.set(L.src, await loadMediaElement(L.src)); } catch { /* 불러오기 실패한 이미지는 건너뜀 */ }
        }),
    );
  } else {
    state.layers = [newTextLayer()];
  }
  state.selectedLayerId = state.layers[state.layers.length - 1].id;
  refreshUI();
}

function renderTemplateList() {
  const ul = $("template-list");
  const list = getTemplates();
  if (!list.length) { ul.innerHTML = '<li class="empty">저장된 템플릿이 없습니다.</li>'; return; }
  ul.innerHTML = list.map((t) =>
    `<li data-id="${escapeHtml(t.id)}"><span class="tname">${escapeHtml(t.name)}</span>` +
    `<button type="button" data-action="load">불러오기</button><button type="button" data-action="delete">삭제</button></li>`
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

      const merged = getTemplates();
      for (const t of data.templates) {
        if (!t.id || !t.name || !t.doc || !Array.isArray(t.doc.layers)) {
          throw new Error("필수 항목(템플릿 구조)이 누락되었습니다.");
        }
        if (!merged.some((x) => x.id === t.id)) merged.push(t);
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

const CURSORS = {
  tl: "nwse-resize", br: "nwse-resize", tr: "nesw-resize", bl: "nesw-resize",
  tc: "ns-resize", bc: "ns-resize", ml: "ew-resize", mr: "ew-resize",
};

function onCanvasMouseDown(e) {
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
  if (drag) return;
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

function editMedia(fn) {
  const L = getSelectedLayer();
  if (!L || !isMedia(L)) return;
  fn(L);
  syncControls();
  requestRender();
}

function closePopovers() {
  document.querySelectorAll(".tb-popover").forEach((p) => p.classList.remove("show"));
}

/* 팝오버는 .preview-wrap 안에 있고, 버튼 바로 아래에 맞춰 배치합니다 */
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

function bindPopover(btnId, popId) {
  const btn = $(btnId), pop = $(popId);
  btn.onclick = (e) => { e.stopPropagation(); togglePopover(pop, btn); };
  pop.onclick = (e) => e.stopPropagation();
}

function bindToolbarEvents() {
  $("tb-font-family").onchange = (e) => editText((L) => (L.fontFamily = e.target.value));
  $("tb-size-minus").onclick = () => editText((L) => (L.fontSize = Math.max(10, L.fontSize - 5)));
  $("tb-size-plus").onclick = () => editText((L) => (L.fontSize = Math.min(300, L.fontSize + 5)));
  $("tb-size-input").onchange = (e) => editText((L) => (L.fontSize = Math.min(300, Math.max(10, Number(e.target.value) || 80))));

  const toggle = (key, on, off) => editText((L) => (L[key] = L[key] === on ? off : on));
  $("tb-bold").onclick = () => toggle("fontWeight", "bold", "normal");
  $("tb-italic").onclick = () => toggle("fontStyle", "italic", "normal");
  $("tb-underline").onclick = () => toggle("textDecoration", "underline", "none");

  $("tb-color-input").oninput = (e) => editText((L) => (L.color = e.target.value));
  ["left", "center", "right"].forEach((a) => ($("tb-align-" + a).onclick = () => editText((L) => (L.align = a))));

  bindPopover("tb-spacing-btn", "spacing-popover");
  $("tb-letter-spacing").oninput = (e) => editText((L) => (L.letterSpacing = Number(e.target.value)));
  $("tb-line-height").oninput = (e) => editText((L) => (L.lineHeight = Number(e.target.value)));
}

function bindImageToolbarEvents() {
  ADJUST_KEYS.forEach((key) => {
    $("img-" + key).oninput = (e) => editMedia((L) => (L[key] = Number(e.target.value)));
  });

  $("img-auto").onchange = (e) => editMedia((L) => {
    Object.assign(L, e.target.checked ? AUTO_ADJUST : { brightness: 0, contrast: 0, saturation: 0, hue: 0 });
  });
  $("img-reset-adjust").onclick = () => editMedia((L) => {
    Object.assign(L, { brightness: 0, contrast: 0, saturation: 0, hue: 0 });
  });

  $("img-rotate-left").onclick = () => editMedia((L) => (L.rotation -= Math.PI / 2));
  $("img-rotate-right").onclick = () => editMedia((L) => (L.rotation += Math.PI / 2));

  bindPopover("img-crop-btn", "crop-popover");
  CROP_SIDES.forEach((side) => {
    $("crop-" + side).oninput = (e) => editMedia((L) => {
      L.crop ??= emptyCrop();
      L.crop[side] = Number(e.target.value) / 100;
    });
  });
}

function bindLayerEvents() {
  const menu = $("add-layer-menu");
  $("add-layer-btn").onclick = (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); };
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

  // 입력 중 커서가 튀지 않도록 refreshUI 대신 목록/캔버스만 갱신
  $("text-input").oninput = (e) => {
    const L = getSelectedLayer();
    if (L?.type === "text") { L.text = e.target.value; renderLayerList(); requestRender(); }
  };

  $("scale-x-input").oninput = (e) => editMedia((L) => (L.scaleX = Number(e.target.value)));
  $("scale-y-input").oninput = (e) => editMedia((L) => (L.scaleY = Number(e.target.value)));
  $("rotation-input").oninput = (e) => editMedia((L) => (L.rotation = (Number(e.target.value) * Math.PI) / 180));
  $("reset-transform-btn").onclick = () => editMedia((L) => { L.scaleX = L.scaleY = 1; L.rotation = 0; });
}

function bindOutputEvents() {
  document.querySelectorAll(".ratio-btn").forEach((btn) => {
    btn.onclick = () => { state.ratio = btn.dataset.ratio; syncControls(); requestRender(); };
  });
  $("download-png-btn").onclick = handleDownloadPng;

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

/* 마우스 드래그로 가로 스크롤 (드래그 직후의 클릭은 무시) */
function enableDragScroll(el, { speed = 1, ignoreSelector = null } = {}) {
  let isDown = false, dragged = false, startX = 0, startScroll = 0;

  el.addEventListener("mousedown", (e) => {
    if (ignoreSelector && e.target.closest(ignoreSelector)) return;
    isDown = true;
    dragged = false;
    startX = e.pageX;
    startScroll = el.scrollLeft;
  });

  const end = () => { isDown = false; };
  el.addEventListener("mouseleave", end);
  el.addEventListener("mouseup", end);

  el.addEventListener("mousemove", (e) => {
    if (!isDown) return;
    e.preventDefault();
    const dx = (e.pageX - startX) * speed;
    if (Math.abs(dx) > 5) dragged = true;
    el.scrollLeft = startScroll - dx;
  });

  el.addEventListener("click", (e) => {
    if (dragged) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}

function initScrollers() {
  const ratioGroup = $("ratio-group");
  enableDragScroll(ratioGroup);
  $("scroll-left").onclick = () => ratioGroup.scrollBy({ left: -150, behavior: "smooth" });
  $("scroll-right").onclick = () => ratioGroup.scrollBy({ left: 150, behavior: "smooth" });

  // 툴바는 입력 요소 위에서 시작한 드래그는 스크롤로 취급하지 않음
  enableDragScroll($("floating-toolbar"), { speed: 1.5, ignoreSelector: "input, select, button" });
}

function initGlobalClicks() {
  document.addEventListener("click", () => {
    closePopovers();
    $("add-layer-menu").classList.add("hidden");
  });
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
  initScrollers();
  initGlobalClicks();
  initFileDrop();
  initCanvasDrag();

  await ensureFonts();
  renderTemplateList();
  refreshUI();
})();