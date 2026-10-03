import { plants as plantStore, photos as photoStore, meta, uid, clearAll } from "./db.js";
import { identifyPlant, resizeImage, blobToBase64, DEFAULT_MODEL } from "./ai.js";
import { Tracker } from "./tracker.js";
import { simplify, closeLoop, areaM2, lengthM, pointInPolygon, formatArea, formatLength } from "./geo.js";
import { FEATURE_TYPES, featureStyle, createGridLayer } from "./plan.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON = MONTHS.map((m) => m.slice(0, 3));

const state = {
  plants: [],
  thumbs: new Map(), // plantId -> object URL of first photo
  settings: { apiKey: "", model: DEFAULT_MODEL, climate: "", stepLength: 0.7, useMotion: true },
  map: null,
  markers: new Map(),
  canopies: new Map(), // plantId -> circle showing the plant's spread
  layers: null, // { satellite, street, grid }
  mode: "satellite", // "plan" | "satellite" | "street"
  features: [], // traced beds, lawns, paths… [{ id, type, name, closed, points: [{lat,lng}] }]
  featureLayers: new Map(),
  tracker: null,
  trace: null, // feature being traced right now
  editing: null, // feature whose corners are being dragged
  me: null, // { marker, circle }
  walk: { active: false, path: [], line: null, wakeLock: null, unsub: null },
  jobsMonth: new Date().getMonth() + 1,
  jobsDone: {},
  moving: null,
  busy: new Set(), // plant ids currently being identified
};

/* ---------------- Utilities ---------------- */

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

function metres(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function displayName(p) {
  return p.nickname || p.ai?.common_name || "Unidentified plant";
}

function gpsChip(acc, steps) {
  const chip = $("#gps-chip");
  if (acc == null) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.textContent = `±${acc < 10 ? acc.toFixed(1) : Math.round(acc)} m` + (steps ? ` · ${steps} steps` : " GPS");
  chip.className = "chip " + (acc <= 6 ? "good" : "poor");
}

/**
 * Collect GPS readings for a few seconds and return an accuracy-weighted average.
 * Phone GPS jitters by several metres, so averaging gives a noticeably steadier pin.
 */
function sampleFix({ onProgress, maxMs = 15000, goodAcc = 5, goodCount = 4 } = {}) {
  let watchId, timer, resolveFn, rejectFn;
  const samples = [];
  const combine = () => {
    // Use the best readings only: anything within 1.5x of the best accuracy.
    const best = Math.min(...samples.map((s) => s.accuracy));
    const use = samples.filter((s) => s.accuracy <= Math.max(best * 1.5, best + 2));
    let w = 0, lat = 0, lng = 0;
    for (const s of use) { const k = 1 / (s.accuracy * s.accuracy); w += k; lat += s.lat * k; lng += s.lng * k; }
    return { lat: lat / w, lng: lng / w, accuracy: Math.max(best / Math.sqrt(use.length), 1), samples: samples.length };
  };
  const finish = () => {
    navigator.geolocation.clearWatch(watchId);
    clearTimeout(timer);
    if (samples.length) resolveFn(combine());
    else rejectFn(new Error("No GPS signal yet."));
  };
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve; rejectFn = reject;
    if (!("geolocation" in navigator)) return reject(new Error("This device can't share its location."));
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const s = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        samples.push(s);
        const fix = combine();
        onProgress?.(fix, s);
        if (samples.filter((x) => x.accuracy <= goodAcc).length >= goodCount) finish();
      },
      (err) => {
        navigator.geolocation.clearWatch(watchId);
        clearTimeout(timer);
        reject(new Error(err.code === 1 ? "Location permission is off. Allow location for this site in your browser settings." : "Couldn't get a GPS fix."));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: maxMs }
    );
    timer = setTimeout(finish, maxMs);
  });
  return { promise, stop: finish };
}

/**
 * Best position for "here". During a walk the fused tracker is already running, so watch it for a
 * few seconds while you stand still (GPS keeps averaging in); otherwise take fresh GPS samples.
 */
function getFix({ onProgress, maxMs = 6000, goodAcc = 2.5 } = {}) {
  const t = state.tracker;
  if (!t?.active || !t.position) return sampleFix({ onProgress });
  let unsub, timer, done;
  const promise = new Promise((resolve) => {
    done = () => { unsub?.(); clearTimeout(timer); resolve({ ...t.position, fromWalk: true }); };
    const tick = (p) => { onProgress?.({ ...p, fromWalk: true }, { accuracy: t.gpsAccuracy ?? p.accuracy }); if (p.accuracy <= goodAcc) done(); };
    unsub = t.subscribe(tick);
    tick(t.position);
    timer = setTimeout(done, maxMs);
  });
  return { promise, stop: () => done?.() };
}

/* ---------------- Data ---------------- */

async function loadAll() {
  state.settings = { ...state.settings, ...(await meta.get("settings", {})) };
  state.jobsDone = await meta.get("jobsDone", {});
  state.walk.path = await meta.get("walkPath", []);
  state.features = await meta.get("features", []);
  state.plants = await plantStore.all();
  state.plants.sort((a, b) => displayName(a).localeCompare(displayName(b)));
  for (const p of state.plants) await refreshThumb(p.id);
}

async function refreshThumb(plantId) {
  const old = state.thumbs.get(plantId);
  if (old) URL.revokeObjectURL(old);
  state.thumbs.delete(plantId);
  const ph = (await photoStore.forPlant(plantId)).sort((a, b) => a.createdAt - b.createdAt);
  if (ph[0]) state.thumbs.set(plantId, URL.createObjectURL(ph[0].blob));
}

async function savePlant(p) {
  await plantStore.put(p);
  const i = state.plants.findIndex((x) => x.id === p.id);
  if (i >= 0) state.plants[i] = p; else state.plants.push(p);
  state.plants.sort((a, b) => displayName(a).localeCompare(displayName(b)));
  renderAll();
}

async function addPhotos(plantId, files) {
  for (const f of files) {
    const blob = await resizeImage(f);
    await photoStore.put({ id: uid(), plantId, blob, createdAt: Date.now() });
  }
  await refreshThumb(plantId);
}

/* ---------------- Map ---------------- */

function initMap() {
  if (!window.L) {
    $("#map-fallback").hidden = false;
    return;
  }
  const map = L.map("map", { zoomControl: false, maxZoom: 24, attributionControl: true });
  state.map = map;
  const css = getComputedStyle(document.documentElement);
  const anchor = state.plants.find((p) => p.lat != null) || state.features[0]?.points[0] || state.walk.path[0];
  state.layers = {
    satellite: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 24, maxNativeZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    }),
    street: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 24, maxNativeZoom: 19, attribution: "© OpenStreetMap contributors",
    }),
    grid: createGridLayer(L, {
      minor: css.getPropertyValue("--grid-minor").trim(),
      major: css.getPropertyValue("--grid-major").trim(),
      lat0: anchor?.lat ?? 52,
    }),
  };
  L.control.scale({ metric: true, imperial: false, position: "topleft", maxWidth: 120 }).addTo(map);

  state.walk.line = L.polyline(state.walk.path.map((p) => [p.lat, p.lng]), {
    color: css.getPropertyValue("--pollen").trim() || "#e0a92b",
    weight: 3, opacity: 0.85, dashArray: "2 7", lineCap: "round", interactive: false,
  }).addTo(map);

  map.on("zoomend", () => map.getContainer().classList.toggle("show-labels", map.getZoom() >= 19));
  map.on("moveend", () => meta.set("mapView", { center: map.getCenter(), zoom: map.getZoom() }));
  map.on("click", (e) => onMapTap(e.latlng));
  map.on("dragstart", () => (state.follow = false));

  meta.get("mapMode").then((m) => setMode(m || (state.features.length ? "plan" : "satellite")));
  meta.get("mapView").then((v) => {
    const pts = [
      ...state.plants.filter((p) => p.lat != null),
      ...state.features.flatMap((f) => f.points),
    ];
    if (pts.length) {
      map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])).pad(0.2), { maxZoom: 21 });
    } else if (v) {
      map.setView(v.center, v.zoom);
    } else {
      map.setView([54, -2], 5);
      locateMe(false);
    }
  });
}

function setMode(mode) {
  if (!state.map || !state.layers[mode === "plan" ? "grid" : mode]) mode = "satellite";
  state.mode = mode;
  const { satellite, street, grid } = state.layers;
  for (const l of [satellite, street, grid]) l.remove();
  (mode === "plan" ? grid : state.layers[mode]).addTo(state.map);
  state.map.getContainer().classList.toggle("plan-mode", mode === "plan");
  $$(".seg [data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  meta.set("mapMode", mode);
  renderFeatures();
}

function pinIcon(p) {
  const url = state.thumbs.get(p.id);
  const cls = "plant-pin" + (p.ai ? "" : " pending");
  return L.divIcon({
    className: "",
    html: `<div class="${cls}">${url ? `<img src="${url}" alt="">` : ""}</div>`,
    iconSize: [34, 34],
    iconAnchor: [3, 34],
    popupAnchor: [14, -30],
  });
}

function renderMarkers() {
  if (!state.map) return;
  const seen = new Set();
  for (const p of state.plants) {
    if (p.lat == null) continue;
    seen.add(p.id);
    let m = state.markers.get(p.id);
    if (!m) {
      m = L.marker([p.lat, p.lng], { icon: pinIcon(p), draggable: false, autoPan: true });
      m.on("click", () => { if (!state.moving) openPlant(p.id); });
      m.addTo(state.map);
      state.markers.set(p.id, m);
    } else {
      m.setLatLng([p.lat, p.lng]);
      m.setIcon(pinIcon(p));
    }
    m.unbindTooltip();
    m.bindTooltip(esc(displayName(p)), { permanent: true, direction: "top", offset: [14, -30], className: "plant-label" });

    // Canopy circle: the plant's mature spread, drawn to scale on the plan.
    const radius = Math.min(Math.max((p.ai?.mature_spread_m || 0.8) / 2, 0.15), 10);
    let c = state.canopies.get(p.id);
    if (!c) {
      c = L.circle([p.lat, p.lng], { radius, color: "#2f6d3c", weight: 1, fillColor: "#5aa864", fillOpacity: 0.35, interactive: false }).addTo(state.map);
      state.canopies.set(p.id, c);
    } else c.setLatLng([p.lat, p.lng]).setRadius(radius);
  }
  for (const [id, m] of state.markers) {
    if (!seen.has(id)) { m.remove(); state.markers.delete(id); state.canopies.get(id)?.remove(); state.canopies.delete(id); }
  }
}

/* ---------------- Garden plan features ---------------- */

function renderFeatures() {
  if (!state.map) return;
  const sat = state.mode !== "plan";
  const seen = new Set();
  // Areas first (largest underneath), then lines on top.
  const order = [...state.features].sort((a, b) => (a.closed === b.closed ? areaM2(b.points) - areaM2(a.points) : a.closed ? -1 : 1));
  for (const f of order) {
    if (f.points.length < 2) continue;
    seen.add(f.id);
    const latlngs = f.points.map((p) => [p.lat, p.lng]);
    let layer = state.featureLayers.get(f.id);
    if (layer && (layer instanceof L.Polygon) !== Boolean(f.closed && f.points.length > 2)) { layer.remove(); layer = null; }
    if (!layer) {
      layer = f.closed && f.points.length > 2 ? L.polygon(latlngs) : L.polyline(latlngs);
      layer.on("click", (e) => { L.DomEvent.stopPropagation(e); if (!state.trace && !state.editing && !state.moving) openFeature(f.id); });
      layer.addTo(state.map);
      state.featureLayers.set(f.id, layer);
    } else layer.setLatLngs(latlngs);
    layer.setStyle(featureStyle(f, sat));
    layer.bringToFront();
    layer.unbindTooltip();
    const label = f.name || (FEATURE_TYPES[f.type] || FEATURE_TYPES.other).label;
    layer.bindTooltip(esc(label), { permanent: true, direction: "center", className: "feature-label" });
  }
  for (const [id, l] of state.featureLayers) if (!seen.has(id)) { l.remove(); state.featureLayers.delete(id); }
  // Keep plant canopies above the beds they sit in.
  for (const c of state.canopies.values()) c.bringToFront();
}

async function saveFeatures() {
  await meta.set("features", state.features);
  renderFeatures();
}

/** The smallest traced area a point sits inside, e.g. "Front border". */
function featureAt(lat, lng) {
  if (lat == null) return null;
  const hits = state.features.filter((f) => f.closed && f.points.length > 2 && pointInPolygon({ lat, lng }, f.points));
  hits.sort((a, b) => areaM2(a.points) - areaM2(b.points));
  return hits[0] || null;
}

function featureLabel(f) {
  const t = (FEATURE_TYPES[f.type] || FEATURE_TYPES.other).label;
  return f.name ? `${f.name} (${t.toLowerCase()})` : t;
}

function showMe(lat, lng, acc) {
  if (!state.map) return;
  if (!state.me) {
    state.me = {
      circle: L.circle([lat, lng], { radius: acc, color: "#2b7de9", weight: 1, fillOpacity: 0.12 }).addTo(state.map),
      marker: L.marker([lat, lng], { icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: 1000 }).addTo(state.map),
    };
  } else {
    state.me.circle.setLatLng([lat, lng]).setRadius(acc);
    state.me.marker.setLatLng([lat, lng]);
  }
}

function locateMe(announce = true) {
  if (!("geolocation" in navigator)) return announce && toast("This device can't share its location.");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      showMe(lat, lng, accuracy);
      gpsChip(accuracy);
      state.map?.setView([lat, lng], Math.max(state.map.getZoom(), 19));
    },
    () => announce && toast("Couldn't find your location. Check location permission."),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
  );
}

/* ---------------- Tracking: walks and tracing ---------------- */

function ensureTracker() {
  if (!state.tracker) state.tracker = new Tracker();
  const t = state.tracker;
  t.stepLength = Number(state.settings.stepLength) || 0.7;
  t.useMotion = state.settings.useMotion !== false;
  t.onUpdate = onTrackerUpdate;
  t.onError = (err) => {
    if (err.code === 1) {
      toast("Location permission is off. Allow location for this site in your browser settings.");
      if (state.walk.active) toggleWalk();
      if (state.trace) cancelTrace();
      return;
    }
    // Brief dropouts are normal under trees; only mention it now and then.
    if (Date.now() - (state.lastGpsWarn || 0) > 30000) { state.lastGpsWarn = Date.now(); toast("Weak GPS signal. Steps and compass keep tracking for now."); }
  };
  return t;
}

/** Start the fused tracker. Call from a tap so iOS can ask for motion permission. */
async function startTracking() {
  if (!("geolocation" in navigator)) { toast("This device can't share its location."); return null; }
  const t = ensureTracker();
  if (!t.active) {
    state.follow = true;
    await t.start();
    try { state.walk.wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* optional */ }
    if (!t.motion && t.useMotion) toast("Motion sensors unavailable, so tracking uses GPS only.");
  }
  return t;
}

function stopTrackingIfIdle() {
  if (state.walk.active || state.trace?.source === "walk") return;
  state.tracker?.stop();
  state.walk.wakeLock?.release?.().catch(() => {});
  state.walk.wakeLock = null;
  gpsChip(null);
}

function onTrackerUpdate(p) {
  showMe(p.lat, p.lng, p.accuracy);
  gpsChip(p.accuracy, p.fused ? p.steps : 0);
  if (state.follow && state.map && !state.editing) {
    const want = state.trace ? 21 : 19;
    if (state.map.getZoom() < want) state.map.setView([p.lat, p.lng], want + 1);
    else state.map.panTo([p.lat, p.lng], { animate: true });
  }
  const w = state.walk;
  if (w.active) {
    const last = w.path[w.path.length - 1];
    if (p.accuracy <= 15 && (!last || metres(last, p) >= 1)) {
      w.path.push({ lat: p.lat, lng: p.lng, acc: p.accuracy, t: Date.now() });
      w.line?.addLatLng([p.lat, p.lng]);
      if (w.path.length % 10 === 0) meta.set("walkPath", w.path);
    }
  }
  const tr = state.trace;
  if (tr?.source === "walk" && !tr.paused) {
    const last = tr.points[tr.points.length - 1];
    if (!last || metres(last, p) >= 0.4) { tr.points.push({ lat: p.lat, lng: p.lng }); updateTrace(); }
  }
}

async function toggleWalk() {
  const w = state.walk;
  const btn = $("#btn-walk");
  if (w.active) {
    w.active = false;
    btn.setAttribute("aria-pressed", "false");
    $(".label", btn).textContent = "Start walk";
    await meta.set("walkPath", w.path);
    stopTrackingIfIdle();
    toast("Walk saved");
    return;
  }
  w.active = true;
  btn.setAttribute("aria-pressed", "true");
  $(".label", btn).textContent = "Stop walk";
  if (!(await startTracking())) { w.active = false; btn.setAttribute("aria-pressed", "false"); $(".label", btn).textContent = "Start walk"; return; }
  toast("Walking. Tap Add plant here at each plant, or Trace to map a bed or path.");
}

/* Swap the buttons along the bottom of the map for a mode's own controls. */
function setActionBar(html) {
  const bar = $(".map-actions");
  if (state.savedActions == null) state.savedActions = bar.innerHTML;
  bar.innerHTML = html;
  bar.classList.add("mode");
}
function restoreActionBar() {
  const bar = $(".map-actions");
  if (state.savedActions != null) bar.innerHTML = state.savedActions;
  state.savedActions = null;
  bar.classList.remove("mode");
  bindMapActions();
}

function openTraceStart() {
  const types = Object.entries(FEATURE_TYPES);
  openSheet(`
    <div class="sheet-head">
      <div><h2>Map part of the garden</h2><p class="muted">Pick what it is, then walk round its edge or tap its corners on the map.</p></div>
      <button class="close" data-close aria-label="Close">×</button>
    </div>
    <div class="type-grid" role="radiogroup" aria-label="What are you mapping?">
      ${types.map(([k, t], i) => `<button class="type-opt" role="radio" aria-checked="${i === 0}" data-type="${k}">
        <span class="swatch" style="--sw:${t.fill || t.color};--sw-line:${t.color}" data-shape="${t.closed ? "area" : "line"}"></span>${esc(t.label)}</button>`).join("")}
    </div>
    <label class="field"><span>Name <span class="muted small">(optional)</span></span>
      <input id="trace-name" placeholder="e.g. Back border, Veg bed 2, Gravel path">
    </label>
    <div class="callout small">
      <p><strong>Walk round it:</strong> hold the phone flat in front of you, pointing the way you walk, and go at a steady pace along the edge. The app uses GPS plus your steps and compass, so shapes come out smoother than GPS alone.</p>
      <p><strong>Tap on the map:</strong> quicker for straight-edged shapes, or when the GPS is poor.</p>
    </div>
    <div class="actions">
      <button class="primary" data-start="walk">Walk round it</button>
      <button class="secondary" data-start="tap">Tap on the map</button>
    </div>
  `);
  let type = types[0][0];
  $("#sheet-body").onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.matches("[data-close]")) return closeSheet();
    if (b.dataset.type) {
      type = b.dataset.type;
      $$(".type-opt").forEach((o) => o.setAttribute("aria-checked", String(o === b)));
      return;
    }
    if (b.dataset.start) {
      const name = $("#trace-name").value.trim();
      closeSheet();
      startTrace(type, name, b.dataset.start);
    }
  };
}

async function startTrace(type, name, source) {
  switchView("map");
  if (!state.map) return toast("The map needs to load before you can trace.");
  const t = FEATURE_TYPES[type];
  const tr = (state.trace = {
    type, name, source, closed: t.closed, points: [],
    layer: L.polyline([], { color: t.color, weight: 4, dashArray: "6 6", opacity: 0.95, interactive: false }).addTo(state.map),
    dots: L.layerGroup().addTo(state.map),
  });
  setActionBar(`
    <div class="trace-bar">
      <div class="trace-info"><strong>${esc(name || t.label)}</strong><span id="trace-stats" class="mono small"></span></div>
      <div class="trace-btns">
        ${source === "walk" ? `<button class="secondary" id="trace-pause">Pause</button>` : ""}
        <button class="secondary" id="trace-undo">Undo</button>
        <button class="secondary" id="trace-cancel">Cancel</button>
        <button class="primary" id="trace-done">Finish</button>
      </div>
    </div>`);
  $("#trace-undo").onclick = () => { tr.points.pop(); updateTrace(); };
  $("#trace-cancel").onclick = cancelTrace;
  $("#trace-done").onclick = finishTrace;
  if (source === "walk") {
    $("#trace-pause").onclick = (e) => {
      tr.paused = !tr.paused;
      e.target.textContent = tr.paused ? "Resume" : "Pause";
    };
    const tk = await startTracking();
    if (!tk) return cancelTrace();
    if (tk.position) tr.points.push({ lat: tk.position.lat, lng: tk.position.lng });
    toast("Walk along the edge. Tap Finish when you're back where you started.", 4000);
  } else {
    toast("Tap each corner on the map.", 3000);
  }
  updateTrace();
}

function onMapTap(latlng) {
  const tr = state.trace;
  if (tr?.source === "tap") {
    tr.points.push({ lat: latlng.lat, lng: latlng.lng });
    updateTrace();
  }
}

function updateTrace() {
  const tr = state.trace;
  if (!tr) return;
  const ll = tr.points.map((p) => [p.lat, p.lng]);
  tr.layer.setLatLngs(tr.closed && ll.length > 2 ? [...ll, ll[0]] : ll);
  if (tr.source === "tap") {
    tr.dots.clearLayers();
    for (const p of ll) L.circleMarker(p, { radius: 5, color: "#fff", weight: 2, fillColor: FEATURE_TYPES[tr.type].color, fillOpacity: 1, interactive: false }).addTo(tr.dots);
  }
  const stats = $("#trace-stats");
  if (!stats) return;
  const n = tr.points.length;
  const size = tr.closed && n > 2 ? formatArea(areaM2(tr.points)) : formatLength(lengthM(tr.points));
  stats.textContent = n ? `${n} point${n === 1 ? "" : "s"} · ${size}` : tr.source === "walk" ? "Waiting for GPS…" : "Tap the first corner";
}

function endTrace() {
  const tr = state.trace;
  if (!tr) return;
  tr.layer.remove();
  tr.dots.remove();
  state.trace = null;
  restoreActionBar();
  stopTrackingIfIdle();
}

function cancelTrace() {
  endTrace();
  toast("Tracing cancelled");
}

async function finishTrace() {
  const tr = state.trace;
  const need = tr.closed ? 3 : 2;
  let pts = tr.points;
  if (tr.source === "walk") {
    const gap = pts.length > 3 ? metres(pts[0], pts[pts.length - 1]) : Infinity;
    if (tr.closed && state.tracker?.deadReckoning && gap < 0.3 * lengthM(pts)) {
      // Back at the start: the leftover gap is step/compass drift, so spread it out along the walk.
      pts = closeLoop(pts);
    } else if (tr.closed && gap < 1.5) {
      pts = pts.slice(0, -1); // near-duplicate of the first point
    }
    pts = simplify(pts, 0.3);
  }
  if (pts.length < need) return toast(tr.closed ? "Need at least 3 points for an area. Keep going." : "Need at least 2 points.");
  const f = { id: uid(), type: tr.type, name: tr.name, closed: tr.closed, points: pts, createdAt: Date.now(), source: tr.source };
  state.features.push(f);
  endTrace();
  if (state.mode !== "plan") setMode("plan");
  await saveFeatures();
  toast(`Saved · ${f.closed ? formatArea(areaM2(f.points)) : formatLength(lengthM(f.points))}`);
}

/* ---------------- Feature details & shape editing ---------------- */

function openFeature(id) {
  const f = state.features.find((x) => x.id === id);
  if (!f) return;
  const t = FEATURE_TYPES[f.type] || FEATURE_TYPES.other;
  const inside = f.closed ? state.plants.filter((p) => p.lat != null && featureAt(p.lat, p.lng)?.id === f.id) : [];
  const size = f.closed
    ? `${formatArea(areaM2(f.points))} · ${formatLength(lengthM(f.points, true))} round the edge`
    : `${formatLength(lengthM(f.points))} long`;
  openSheet(`
    <div class="sheet-head">
      <div><h2>${esc(f.name || t.label)}</h2><p class="mono muted">${size}</p></div>
      <button class="close" data-close aria-label="Close">×</button>
    </div>
    <label class="field"><span>Name</span><input id="f-name" value="${esc(f.name)}" placeholder="${esc(t.label)}"></label>
    <label class="field"><span>Type</span>
      <select id="f-type">${Object.entries(FEATURE_TYPES).map(([k, v]) => `<option value="${k}" ${k === f.type ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select>
    </label>
    <label class="check"><input type="checkbox" id="f-closed" ${f.closed ? "checked" : ""}> Join up the ends (an area, not a line)</label>
    ${f.closed ? `<div><p class="section-label">Plants here</p>${inside.length
      ? `<div class="chips">${inside.map((p) => `<button class="chip-btn" data-plant="${p.id}">${esc(displayName(p))}</button>`).join("")}</div>`
      : `<p class="muted">No plants recorded inside this area yet.</p>`}</div>` : ""}
    <div class="actions">
      <button class="secondary" data-act="edit">Adjust shape</button>
      <button class="ghost danger-text" data-act="delete">Delete</button>
    </div>
  `);
  const save = async () => {
    f.name = $("#f-name").value.trim();
    f.type = $("#f-type").value;
    f.closed = $("#f-closed").checked;
    await saveFeatures();
    renderAll();
  };
  $("#f-name").onchange = save;
  $("#f-type").onchange = save;
  $("#f-closed").onchange = async () => { await save(); openFeature(f.id); };
  $("#sheet-body").onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.matches("[data-close]")) return closeSheet();
    if (b.dataset.plant) return openPlant(b.dataset.plant);
    if (b.dataset.act === "edit") { closeSheet(); return editShape(f.id); }
    if (b.dataset.act === "delete") {
      b.parentElement.innerHTML = `<p style="flex-basis:100%">Delete ${esc(f.name || t.label.toLowerCase())} from the plan?</p>
        <button class="secondary" data-act="keep">Keep it</button><button class="primary" style="background:var(--bad)" data-act="really">Delete</button>`;
      return;
    }
    if (b.dataset.act === "keep") return openFeature(f.id);
    if (b.dataset.act === "really") {
      state.features = state.features.filter((x) => x.id !== f.id);
      await saveFeatures();
      closeSheet();
      toast("Removed from the plan");
    }
  };
}

function editShape(id) {
  const f = state.features.find((x) => x.id === id);
  const layer = state.featureLayers.get(id);
  if (!f || !layer) return;
  switchView("map");
  state.follow = false;
  state.map.fitBounds(layer.getBounds().pad(0.3), { maxZoom: 23 });
  const group = L.layerGroup().addTo(state.map);
  const icon = L.divIcon({ className: "", html: '<div class="vertex"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
  const original = f.points.map((p) => ({ ...p }));
  const draw = () => {
    group.clearLayers();
    f.points.forEach((p, i) => {
      const m = L.marker([p.lat, p.lng], { icon, draggable: true, zIndexOffset: 2000 }).addTo(group);
      m.on("drag", (e) => { const ll = e.target.getLatLng(); f.points[i] = { lat: ll.lat, lng: ll.lng }; layer.setLatLngs(f.points.map((q) => [q.lat, q.lng])); });
      m.on("click", () => {
        // Tap a corner twice within a second to remove it.
        if (m._armed && f.points.length > (f.closed ? 3 : 2)) { f.points.splice(i, 1); layer.setLatLngs(f.points.map((q) => [q.lat, q.lng])); draw(); return; }
        m._armed = true; setTimeout(() => (m._armed = false), 1000);
      });
    });
  };
  draw();
  state.editing = { id, group };
  setActionBar(`
    <div class="trace-bar">
      <div class="trace-info"><strong>Adjust shape</strong><span class="small muted">Drag corners. Double-tap one to remove it.</span></div>
      <div class="trace-btns"><button class="secondary" id="edit-cancel">Cancel</button><button class="primary" id="edit-done">Done</button></div>
    </div>`);
  const end = async (keep) => {
    if (!keep) f.points = original;
    group.remove();
    state.editing = null;
    restoreActionBar();
    await saveFeatures();
    renderAll();
  };
  $("#edit-done").onclick = () => end(true);
  $("#edit-cancel").onclick = () => end(false);
}

/* ---------------- Sheet ---------------- */

function openSheet(html) {
  $("#sheet-body").innerHTML = html;
  $("#sheet").hidden = false;
  $("#sheet-backdrop").hidden = false;
  $("#sheet").scrollTop = 0;
}

function closeSheet() {
  $("#sheet").hidden = true;
  $("#sheet-backdrop").hidden = true;
  $("#sheet-body").innerHTML = "";
  closeSheet.onClose?.();
  closeSheet.onClose = null;
  state.openPlantId = null;
}

/** Ask for photos via the hidden inputs. Resolves with an array of Files (may be empty). */
function pickPhotos(fromGallery = false) {
  const input = fromGallery ? $("#photo-input-gallery") : $("#photo-input");
  return new Promise((resolve) => {
    input.value = "";
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}

/* ---------------- Add plant flow ---------------- */

function openAddPlant() {
  const draft = { files: [], urls: [], fix: null, fixError: null };
  const C = 2 * Math.PI * 23;

  openSheet(`
    <div class="sheet-head">
      <div><h2>New plant</h2><p class="muted">Stand right next to the plant while the GPS settles.</p></div>
      <button class="close" data-close aria-label="Close">×</button>
    </div>
    <div class="fix" id="fix">
      <svg class="ring" viewBox="0 0 54 54" aria-hidden="true"><circle class="track" cx="27" cy="27" r="23"/><circle class="val" cx="27" cy="27" r="23" stroke-dasharray="${C}" stroke-dashoffset="${C}"/></svg>
      <div class="acc" id="fix-acc">Finding you…</div>
      <div class="sub" id="fix-sub">Waiting for GPS</div>
    </div>
    <div>
      <p class="section-label">Photos</p>
      <p class="muted small">One close-up of leaves or flowers plus one of the whole plant gives the best identification.</p>
    </div>
    <div class="photos" id="draft-photos"></div>
    <label class="field"><span>Notes <span class="muted small">(optional)</span></span>
      <textarea id="draft-notes" rows="2" placeholder="e.g. by the back fence, planted 2023, flowers pink in June"></textarea>
    </label>
    <div class="actions">
      <button class="primary" id="draft-save" disabled>Save and identify</button>
      <button class="secondary" id="draft-save-only" disabled>Save without identifying</button>
    </div>
  `);

  const renderPhotos = () => {
    $("#draft-photos").innerHTML =
      draft.urls.map((u, i) => `<div class="ph"><img src="${u}" alt=""><button data-rm="${i}" aria-label="Remove photo">×</button></div>`).join("") +
      `<button class="add-photo" data-cam><svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Take photo</button>
       <button class="add-photo" data-gal><svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="m4 16 5-5 4 4 2-2 5 5"/></svg>From gallery</button>`;
    const has = draft.files.length > 0;
    $("#draft-save").disabled = !has;
    $("#draft-save-only").disabled = false;
  };
  renderPhotos();

  const sampler = getFix({
    onProgress: (fix, raw) => {
      draft.fix = fix;
      const quality = Math.max(0, Math.min(1, (25 - fix.accuracy) / 22));
      const ring = $("#fix .val");
      if (!ring) return;
      ring.style.strokeDashoffset = String(C * (1 - quality));
      $("#fix-acc").textContent = `±${fix.accuracy.toFixed(1)} m`;
      $("#fix-sub").textContent = fix.fromWalk
        ? `${fix.fused ? "GPS + steps + compass" : "Averaging GPS from your walk"} · GPS alone ±${Math.round(raw.accuracy)} m`
        : `${fix.samples} reading${fix.samples === 1 ? "" : "s"} · latest ±${Math.round(raw.accuracy)} m`;
      gpsChip(fix.fused ? fix.accuracy : raw.accuracy, fix.fused ? fix.steps : 0);
      showMe(fix.lat, fix.lng, fix.accuracy);
    },
  });
  sampler.promise.then(
    (fix) => {
      draft.fix = fix;
      if ($("#fix-sub")) $("#fix-sub").textContent = fix.fromWalk ? "Locked from your walk" : `Locked from ${fix.samples} readings`;
    },
    (err) => {
      draft.fixError = err.message;
      if ($("#fix-acc")) {
        $("#fix-acc").textContent = "No GPS fix";
        $("#fix-sub").textContent = err.message + " The plant will be placed at the map centre; drag its pin later.";
      }
    }
  );
  closeSheet.onClose = () => { sampler.stop(); draft.urls.forEach(URL.revokeObjectURL); };

  $("#sheet-body").onclick = async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.matches("[data-close]")) return closeSheet();
    if (t.matches("[data-rm]")) {
      const i = +t.dataset.rm;
      URL.revokeObjectURL(draft.urls[i]);
      draft.files.splice(i, 1); draft.urls.splice(i, 1);
      return renderPhotos();
    }
    if (t.matches("[data-cam], [data-gal]")) {
      const files = await pickPhotos(t.matches("[data-gal]"));
      for (const f of files) { draft.files.push(f); draft.urls.push(URL.createObjectURL(f)); }
      return renderPhotos();
    }
    if (t.id === "draft-save" || t.id === "draft-save-only") {
      t.disabled = true;
      sampler.stop();
      let pos = draft.fix;
      let approx = false;
      if (!pos) {
        const c = state.map?.getCenter();
        pos = c ? { lat: c.lat, lng: c.lng, accuracy: null } : { lat: null, lng: null, accuracy: null };
        approx = true;
      }
      const plant = {
        id: uid(),
        createdAt: Date.now(),
        lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy, approx,
        notes: $("#draft-notes").value.trim(),
        nickname: "",
        ai: null,
      };
      await addPhotos(plant.id, draft.files);
      await savePlant(plant);
      const identify = t.id === "draft-save";
      closeSheet();
      toast(approx ? "Saved at map centre. Drag the pin to place it." : `Saved (±${Math.round(pos.accuracy)} m)`);
      openPlant(plant.id);
      if (identify) runIdentify(plant.id);
    }
  };
}

/* ---------------- Identification ---------------- */

/** Where the plant sits on the plan, in words, so the care plan can account for it. */
function describeSurroundings(p) {
  if (p.lat == null) return "";
  const parts = [];
  const inside = featureAt(p.lat, p.lng);
  if (inside) parts.push(`Growing in: ${featureLabel(inside)}.`);
  const near = [];
  for (const f of state.features) {
    if (f === inside || !["building", "hedge", "boundary", "water", "patio"].includes(f.type)) continue;
    const d = Math.min(...f.points.map((q) => metres(p, q)));
    if (d <= 3) near.push(`${featureLabel(f)} about ${Math.max(1, Math.round(d))} m away`);
  }
  if (near.length) parts.push(`Nearby: ${near.join("; ")}.`);
  return parts.join(" ");
}

async function runIdentify(plantId) {
  const p = state.plants.find((x) => x.id === plantId);
  if (!p) return;
  if (!state.settings.apiKey) {
    toast("Add your Claude API key in Settings first.");
    return;
  }
  const ph = (await photoStore.forPlant(plantId)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  if (!ph.length) return toast("Add a photo first.");
  state.busy.add(plantId);
  p.aiError = null;
  if (state.openPlantId === plantId) renderPlantSheet(p);
  try {
    const images = await Promise.all(ph.map(async (x) => ({ mediaType: "image/jpeg", data: await blobToBase64(x.blob) })));
    const result = await identifyPlant({
      apiKey: state.settings.apiKey, model: state.settings.model, images,
      lat: p.lat, lng: p.lng, notes: p.notes, settings: state.settings,
      where: describeSurroundings(p),
    });
    p.ai = result;
  } catch (err) {
    p.aiError = err.message;
  } finally {
    state.busy.delete(plantId);
  }
  await savePlant(p);
  if (state.openPlantId === plantId) renderPlantSheet(p);
  else if (p.ai) toast(`Identified: ${displayName(p)}`);
  else toast(p.aiError);
}

/* ---------------- Plant detail ---------------- */

const ICONS = {
  sunlight: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  watering: '<svg viewBox="0 0 24 24"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/></svg>',
  soil: '<svg viewBox="0 0 24 24"><path d="M3 15h18M5 19h14M8 15c0-3 2-5 4-6M12 9c0-3 2-5 5-5 0 3-2 5-5 5Z"/></svg>',
  feeding: '<svg viewBox="0 0 24 24"><path d="M7 3h10l-1 5H8zM8 8l-2 13h12L16 8"/></svg>',
  pruning: '<svg viewBox="0 0 24 24"><circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8 16 19 4M16 16 5 4"/></svg>',
  pests_diseases: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="14" rx="5" ry="6"/><path d="M12 8V5M9 5l-2-2M15 5l2-2M7 12H3M21 12h-4M7 17l-3 2M17 17l3 2"/></svg>',
  winter: '<svg viewBox="0 0 24 24"><path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 4l3 2 3-2M9 20l3-2 3 2"/></svg>',
  hardiness: '<svg viewBox="0 0 24 24"><path d="M12 3v12M9 6h6"/><circle cx="12" cy="18" r="3"/></svg>',
};
const CARE_LABELS = { sunlight: "Light", watering: "Watering", soil: "Soil", feeding: "Feeding", pruning: "Pruning", pests_diseases: "Pests & diseases", winter: "Winter care", hardiness: "Hardiness" };

function healthBadge(h) {
  if (!h || h.status === "unknown") return "";
  const cls = h.status === "healthy" ? "good" : h.status === "minor issues" ? "warn" : "bad";
  return `<span class="badge ${cls}">${esc(h.status)}</span>`;
}
function confBadge(ai) {
  if (!ai) return `<span class="badge warn">Not identified</span>`;
  const cls = ai.confidence === "high" ? "good" : ai.confidence === "medium" ? "warn" : "bad";
  return `<span class="badge ${cls}">${esc(ai.confidence)} confidence</span>`;
}

async function openPlant(id) {
  const p = state.plants.find((x) => x.id === id);
  if (!p) return;
  state.openPlantId = id;
  openSheet(`<div class="thinking"><div class="spinner"></div><p>Loading…</p></div>`);
  state.openPlantId = id;
  closeSheet.onClose = () => (state.sheetPhotoUrls || []).forEach(URL.revokeObjectURL);
  await renderPlantSheet(p);
}

async function renderPlantSheet(p) {
  (state.sheetPhotoUrls || []).forEach(URL.revokeObjectURL);
  const ph = (await photoStore.forPlant(p.id)).sort((a, b) => a.createdAt - b.createdAt);
  const urls = ph.map((x) => URL.createObjectURL(x.blob));
  state.sheetPhotoUrls = urls;
  const ai = p.ai;
  const busy = state.busy.has(p.id);
  const month = new Date().getMonth() + 1;
  const selMonth = state.sheetMonth?.[p.id] ?? month;

  const careHtml = ai
    ? Object.keys(CARE_LABELS)
        .filter((k) => ai.care?.[k])
        .map((k) => `<div class="fact"><h4>${ICONS[k]}${CARE_LABELS[k]}</h4><p>${esc(ai.care[k])}</p></div>`)
        .join("")
    : "";

  const cal = ai?.calendar || [];
  const tasksFor = (m) => cal.find((c) => c.month === m)?.tasks || [];
  const calHtml = ai
    ? `<div>
        <p class="section-label">Year planner</p>
        <div class="calendar" role="tablist">
          ${MON.map((m, i) => `<button class="cal-m ${tasksFor(i + 1).length ? "has" : ""} ${i + 1 === month ? "now" : ""} ${i + 1 === selMonth ? "sel" : ""}" data-month="${i + 1}" role="tab" aria-selected="${i + 1 === selMonth}">${m[0]}<span class="bar"></span></button>`).join("")}
        </div>
        <div class="cal-tasks">
          <h4>${MONTHS[selMonth - 1]}${selMonth === month ? " · this month" : ""}</h4>
          ${tasksFor(selMonth).length ? `<ul>${tasksFor(selMonth).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : `<p class="muted">Nothing to do this month.</p>`}
        </div>
      </div>`
    : "";

  const healthHtml =
    ai?.health && ai.health.status !== "unknown"
      ? `<div class="callout"><div class="row"><span class="section-label">Health check</span>${healthBadge(ai.health)}</div>
          <p>${esc(ai.health.observations)}</p>
          ${ai.health.actions?.length ? `<ul>${ai.health.actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}</div>`
      : "";

  const posText =
    p.lat == null ? "No position recorded"
    : `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}${p.accuracy ? ` · ±${p.accuracy.toFixed(1)} m` : ""}${p.approx ? " · placed by hand" : ""}`;

  $("#sheet-body").innerHTML = `
    <div class="sheet-head">
      <div style="min-width:0">
        <h2>${esc(displayName(p))}</h2>
        ${ai?.scientific_name ? `<p class="sci">${esc(ai.scientific_name)}${ai.family ? ` · ${esc(ai.family)}` : ""}</p>` : ""}
        <div class="row wrap" style="margin-top:8px">${confBadge(ai)}${healthBadge(ai?.health)}${ai?.plant_type ? `<span class="badge">${esc(ai.plant_type)}</span>` : ""}</div>
      </div>
      <button class="close" data-close aria-label="Close">×</button>
    </div>

    ${urls[0] ? `<img class="hero-photo" src="${urls[urls.length - 1]}" alt="Photo of ${esc(displayName(p))}">` : ""}

    ${busy ? `<div class="thinking"><div class="spinner"></div><div><strong>Identifying…</strong><p class="muted small">Claude is looking at your photos and writing a care plan. This takes 10–40 seconds.</p></div></div>` : ""}
    ${p.aiError && !busy ? `<p class="error">${esc(p.aiError)}</p>` : ""}

    <div class="actions">
      <button class="primary" data-act="identify" ${busy ? "disabled" : ""}>${ai ? "Re-identify" : "Identify with Claude"}</button>
      <button class="secondary" data-act="photo">Add photo</button>
    </div>

    ${ai?.description ? `<p>${esc(ai.description)}</p>` : ""}
    ${healthHtml}
    ${careHtml ? `<div class="facts">${careHtml}</div>` : ""}
    ${calHtml}
    ${ai?.tips?.length ? `<div><p class="section-label">Tips</p><ul class="tips">${ai.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
    ${ai?.toxicity ? `<div class="fact"><h4>Pets &amp; children</h4><p>${esc(ai.toxicity)}</p></div>` : ""}
    ${ai?.alternatives?.length ? `<div class="alts"><p class="section-label">Could also be</p>${ai.alternatives.map((a) => `<p class="alt"><strong>${esc(a.common_name)}</strong> <em>${esc(a.scientific_name)}</em>${a.reason ? ` · ${esc(a.reason)}` : ""}</p>`).join("")}</div>` : ""}

    <div>
      <p class="section-label">Photos</p>
      <div class="photos">
        ${ph.map((x, i) => `<div class="ph"><img src="${urls[i]}" alt=""><button data-rmphoto="${x.id}" aria-label="Delete photo">×</button></div>`).join("")}
      </div>
    </div>

    <label class="field"><span>Your name for it</span><input id="pl-nick" value="${esc(p.nickname)}" placeholder="${esc(ai?.common_name || "e.g. Grandma's rose")}"></label>
    <label class="field"><span>Notes</span><textarea id="pl-notes" rows="3" placeholder="Planting date, where it came from, what you've noticed">${esc(p.notes)}</textarea></label>

    <div>
      <p class="section-label">Position</p>
      ${featureAt(p.lat, p.lng) ? `<p>In <strong>${esc(featureLabel(featureAt(p.lat, p.lng)))}</strong></p>` : ""}
      <p class="coords">${posText}</p>
    </div>
    <div class="actions">
      <button class="secondary" data-act="show">Show on map</button>
      <button class="secondary" data-act="move">Drag pin</button>
      <button class="secondary" data-act="here">Re-record here</button>
    </div>
    <div class="actions" id="del-row">
      <button class="ghost danger-text" data-act="delete">Delete plant</button>
    </div>
    ${ai?.model ? `<p class="muted small">Identified by ${esc(ai.model)} on ${new Date(ai.identifiedAt).toLocaleDateString()}. Check important details, such as toxicity, with a trusted source.</p>` : ""}
  `;

  const save = async () => {
    p.nickname = $("#pl-nick").value.trim();
    p.notes = $("#pl-notes").value.trim();
    await savePlant(p);
  };
  $("#pl-nick").onchange = save;
  $("#pl-notes").onchange = save;

  $("#sheet-body").onclick = async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.matches("[data-close]")) return closeSheet();
    if (t.dataset.month) {
      state.sheetMonth = { ...(state.sheetMonth || {}), [p.id]: +t.dataset.month };
      return renderPlantSheet(p);
    }
    if (t.dataset.rmphoto) {
      await photoStore.remove(t.dataset.rmphoto);
      await refreshThumb(p.id);
      renderAll();
      return renderPlantSheet(p);
    }
    switch (t.dataset.act) {
      case "identify": return runIdentify(p.id);
      case "photo": {
        const files = await pickPhotos(false);
        if (!files.length) return;
        await addPhotos(p.id, files);
        renderAll();
        await renderPlantSheet(p);
        if (!p.ai && state.settings.apiKey) runIdentify(p.id);
        return;
      }
      case "show":
        closeSheet(); switchView("map");
        if (p.lat != null) state.map?.setView([p.lat, p.lng], 20);
        return;
      case "move": closeSheet(); return startMovePin(p.id);
      case "here": {
        t.disabled = true;
        t.textContent = "Locating…";
        try {
          const fix = await getFix({ onProgress: (f) => (t.textContent = `±${f.accuracy.toFixed(1)} m…`) }).promise;
          Object.assign(p, { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, approx: false });
          await savePlant(p);
          toast(`Position updated (±${Math.round(fix.accuracy)} m)`);
        } catch (err) { toast(err.message); }
        return renderPlantSheet(p);
      }
      case "delete":
        $("#del-row").innerHTML = `<p style="flex-basis:100%">Delete ${esc(displayName(p))} and its photos? This can't be undone.</p>
          <button class="secondary" data-act="cancel-del">Keep it</button><button class="primary" style="background:var(--bad)" data-act="confirm-del">Delete</button>`;
        return;
      case "cancel-del": return renderPlantSheet(p);
      case "confirm-del":
        await plantStore.remove(p.id);
        state.plants = state.plants.filter((x) => x.id !== p.id);
        closeSheet(); renderAll(); toast("Plant deleted");
        return;
    }
  };
}

function startMovePin(id) {
  switchView("map");
  const m = state.markers.get(id);
  const p = state.plants.find((x) => x.id === id);
  if (!state.map || !p) return;
  if (!m) { // plant without a position: drop it at the centre
    const c = state.map.getCenter();
    Object.assign(p, { lat: c.lat, lng: c.lng, approx: true });
    renderMarkers();
    return startMovePin(id);
  }
  state.moving = id;
  state.map.setView(m.getLatLng(), Math.max(state.map.getZoom(), 20));
  m.dragging.enable();
  state.follow = false;
  setActionBar(`<span class="pill">Drag the pin to the plant</span><button class="fab" id="move-done">Done</button>`);
  $("#move-done").onclick = async () => {
    m.dragging.disable();
    const ll = m.getLatLng();
    Object.assign(p, { lat: ll.lat, lng: ll.lng, approx: true, accuracy: null });
    state.moving = null;
    restoreActionBar();
    await savePlant(p);
    toast("Pin moved");
  };
}

/* ---------------- Lists ---------------- */

function renderList() {
  const q = $("#search").value.trim().toLowerCase();
  const month = new Date().getMonth() + 1;
  const list = state.plants.filter((p) =>
    !q || [displayName(p), p.ai?.scientific_name, p.notes].some((s) => s?.toLowerCase().includes(q)));
  $("#plant-count").textContent = state.plants.length ? String(state.plants.length) : "";
  $("#plants-empty").hidden = state.plants.length > 0;
  $("#plant-list").innerHTML = list
    .map((p) => {
      const t = p.ai?.calendar?.find((c) => c.month === month)?.tasks?.[0];
      const url = state.thumbs.get(p.id);
      return `<li><button class="plant-item" data-id="${p.id}">
        ${url ? `<img class="thumb" src="${url}" alt="">` : `<div class="thumb"></div>`}
        <div class="meta">
          <div class="name">${esc(displayName(p))}</div>
          ${p.ai?.scientific_name ? `<div class="sci">${esc(p.ai.scientific_name)}</div>` : ""}
          <div class="next">${state.busy.has(p.id) ? "Identifying…" : t ? esc(t) : p.ai ? '<span class="muted">No jobs this month</span>' : '<span class="muted">Tap to identify</span>'}</div>
        </div>
        ${p.ai ? healthBadge(p.ai.health) : confBadge(null)}
      </button></li>`;
    })
    .join("");
}

function jobKey(month, plantId, i) {
  return `${new Date().getFullYear()}-${month}:${plantId}:${i}`;
}

function renderJobs() {
  const m = state.jobsMonth;
  const now = new Date().getMonth() + 1;
  $("#jobs-title").textContent = m === now ? `Jobs for ${MONTHS[m - 1]}` : MONTHS[m - 1];
  const rows = [];
  for (const p of state.plants) {
    const tasks = p.ai?.calendar?.find((c) => c.month === m)?.tasks || [];
    tasks.forEach((task, i) => rows.push({ p, task, key: jobKey(m, p.id, i) }));
  }
  if (!rows.length) {
    $("#jobs").innerHTML = `<div class="empty"><h3>Nothing listed for ${MONTHS[m - 1]}</h3><p>Jobs come from each identified plant's care plan. Add and identify plants to fill this in.</p></div>`;
    return;
  }
  const open = rows.filter((r) => !state.jobsDone[r.key]);
  const done = rows.filter((r) => state.jobsDone[r.key]);
  $("#jobs").innerHTML =
    `<p class="muted mono small">${open.length} to do · ${done.length} done</p>` +
    [...open, ...done]
      .map((r) => `<label class="job ${state.jobsDone[r.key] ? "done" : ""}">
        <input type="checkbox" data-key="${r.key}" ${state.jobsDone[r.key] ? "checked" : ""}>
        <div><button type="button" class="who" data-id="${r.p.id}">${esc(displayName(r.p))}</button><div class="task">${esc(r.task)}</div></div>
      </label>`)
      .join("");
}

function renderAll() {
  renderList();
  renderJobs();
  renderMarkers();
}

/* ---------------- Views & settings ---------------- */

function switchView(name) {
  $$(".view").forEach((v) => (v.hidden = v.id !== "view-" + name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  if (name === "map") setTimeout(() => state.map?.invalidateSize(), 50);
  if (name === "settings") showStorage();
}

async function showStorage() {
  try {
    const est = await navigator.storage?.estimate?.();
    const ph = await photoStore.all();
    $("#storage-info").textContent = `${state.plants.length} plants · ${ph.length} photos${est ? ` · ${(est.usage / 1048576).toFixed(1)} MB used` : ""}`;
  } catch { /* not critical */ }
}

function fillSettings() {
  $("#set-key").value = state.settings.apiKey || "";
  $("#set-model").value = state.settings.model || DEFAULT_MODEL;
  $("#set-climate").value = state.settings.climate || "";
  $("#set-step").value = state.settings.stepLength || 0.7;
  $("#set-motion").checked = state.settings.useMotion !== false;
}

async function exportBackup() {
  const ph = await photoStore.all();
  const data = {
    app: "garden-log", version: 1, exportedAt: new Date().toISOString(),
    plants: state.plants,
    photos: await Promise.all(ph.map(async (x) => ({ id: x.id, plantId: x.plantId, createdAt: x.createdAt, data: await blobToBase64(x.blob) }))),
    walkPath: state.walk.path,
    features: state.features,
    jobsDone: state.jobsDone,
  };
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const name = `garden-log-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([blob], name, { type: "application/json" });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Garden Log backup" }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "garden-log") throw new Error();
    for (const p of data.plants || []) await plantStore.put(p);
    for (const x of data.photos || []) {
      const bin = Uint8Array.from(atob(x.data), (c) => c.charCodeAt(0));
      await photoStore.put({ id: x.id, plantId: x.plantId, createdAt: x.createdAt, blob: new Blob([bin], { type: "image/jpeg" }) });
    }
    if (data.walkPath?.length) await meta.set("walkPath", data.walkPath);
    if (data.features?.length) {
      const have = new Set(state.features.map((f) => f.id));
      await meta.set("features", [...state.features, ...data.features.filter((f) => !have.has(f.id))]);
    }
    if (data.jobsDone) await meta.set("jobsDone", { ...state.jobsDone, ...data.jobsDone });
    await loadAll();
    state.walk.line?.setLatLngs(state.walk.path.map((p) => [p.lat, p.lng]));
    renderFeatures();
    renderAll();
    toast(`Imported ${data.plants?.length || 0} plants`);
  } catch {
    toast("That file isn't a Garden Log backup.");
  }
}

function bindMapActions() {
  $("#btn-add").onclick = openAddPlant;
  $("#btn-walk").onclick = toggleWalk;
  $("#btn-trace").onclick = openTraceStart;
  if (state.walk.active) {
    $("#btn-walk").setAttribute("aria-pressed", "true");
    $("#btn-walk .label").textContent = "Stop walk";
  }
}

function bindUI() {
  $$(".tab").forEach((t) => (t.onclick = () => switchView(t.dataset.view)));
  bindMapActions();
  $("#btn-locate").onclick = () => {
    const p = state.tracker?.active && state.tracker.position;
    if (p) { state.follow = true; state.map?.setView([p.lat, p.lng], Math.max(state.map.getZoom(), 20)); }
    else locateMe(true);
  };
  $$(".seg [data-mode]").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  $("#sheet-backdrop").onclick = closeSheet;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#sheet").hidden) closeSheet(); });

  $("#search").oninput = renderList;
  $("#plant-list").onclick = (e) => { const b = e.target.closest("[data-id]"); if (b) openPlant(b.dataset.id); };

  $("#month-prev").onclick = () => { state.jobsMonth = ((state.jobsMonth + 10) % 12) + 1; renderJobs(); };
  $("#month-next").onclick = () => { state.jobsMonth = (state.jobsMonth % 12) + 1; renderJobs(); };
  $("#jobs").onclick = (e) => { const b = e.target.closest(".who"); if (b) { e.preventDefault(); openPlant(b.dataset.id); } };
  $("#jobs").onchange = async (e) => {
    const k = e.target.dataset.key;
    if (!k) return;
    if (e.target.checked) state.jobsDone[k] = Date.now(); else delete state.jobsDone[k];
    await meta.set("jobsDone", state.jobsDone);
    renderJobs();
  };

  $("#settings-form").onsubmit = async (e) => {
    e.preventDefault();
    const step = parseFloat($("#set-step").value);
    state.settings = {
      apiKey: $("#set-key").value.trim(), model: $("#set-model").value, climate: $("#set-climate").value.trim(),
      stepLength: step >= 0.3 && step <= 1.5 ? step : 0.7, useMotion: $("#set-motion").checked,
    };
    await meta.set("settings", state.settings);
    toast("Settings saved");
  };
  $("#btn-export").onclick = exportBackup;
  $("#import-file").onchange = (e) => e.target.files[0] && importBackup(e.target.files[0]);
  $("#btn-clear-walk").onclick = async () => {
    state.walk.path = [];
    state.walk.line?.setLatLngs([]);
    await meta.set("walkPath", []);
    toast("Walk path cleared");
  };
  $("#btn-wipe").onclick = () => {
    $("#danger").innerHTML = `<p>Delete all plants, photos and settings from this phone? Export a backup first if you want to keep them.</p>
      <div class="row wrap" style="margin-top:10px"><button class="secondary" id="wipe-no">Cancel</button><button class="primary" style="background:var(--bad)" id="wipe-yes">Delete everything</button></div>`;
    $("#wipe-no").onclick = () => location.reload();
    $("#wipe-yes").onclick = async () => { await clearAll(); location.reload(); };
  };
}

/* ---------------- Boot ---------------- */

async function boot() {
  bindUI();
  await loadAll();
  fillSettings();
  const start = () => { initMap(); renderAll(); };
  if (window.L) start();
  else window.addEventListener("load", start, { once: true });
  if (!state.settings.apiKey && !state.plants.length) {
    setTimeout(() => toast("Tip: add your Claude API key in Settings to identify plants.", 4500), 800);
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  navigator.storage?.persist?.().catch(() => {});
}

boot();
