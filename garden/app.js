import { plants as plantStore, photos as photoStore, meta, uid, clearAll } from "./db.js";
import { identifyPlant, resizeImage, blobToBase64, DEFAULT_MODEL } from "./ai.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON = MONTHS.map((m) => m.slice(0, 3));

const state = {
  plants: [],
  thumbs: new Map(), // plantId -> object URL of first photo
  settings: { apiKey: "", model: DEFAULT_MODEL, climate: "" },
  map: null,
  markers: new Map(),
  layers: null,
  layerIdx: 0,
  me: null, // { marker, circle }
  walk: { active: false, watchId: null, path: [], line: null, wakeLock: null },
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

function gpsChip(acc) {
  const chip = $("#gps-chip");
  if (acc == null) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.textContent = `GPS ±${Math.round(acc)} m`;
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

/* ---------------- Data ---------------- */

async function loadAll() {
  state.settings = { ...state.settings, ...(await meta.get("settings", {})) };
  state.jobsDone = await meta.get("jobsDone", {});
  state.walk.path = await meta.get("walkPath", []);
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
  const map = L.map("map", { zoomControl: false, maxZoom: 22, attributionControl: true });
  state.map = map;
  state.layers = [
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 22, maxNativeZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    }),
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 22, maxNativeZoom: 19, attribution: "© OpenStreetMap contributors",
    }),
  ];
  state.layers[0].addTo(map);

  state.walk.line = L.polyline(state.walk.path.map((p) => [p.lat, p.lng]), {
    color: getComputedStyle(document.documentElement).getPropertyValue("--pollen").trim() || "#e0a92b",
    weight: 4, opacity: 0.9, dashArray: "2 8", lineCap: "round",
  }).addTo(map);

  map.on("zoomend", () => map.getContainer().classList.toggle("show-labels", map.getZoom() >= 19));
  map.on("moveend", () => meta.set("mapView", { center: map.getCenter(), zoom: map.getZoom() }));

  meta.get("mapView").then((v) => {
    const located = state.plants.filter((p) => p.lat != null);
    if (located.length) {
      map.fitBounds(L.latLngBounds(located.map((p) => [p.lat, p.lng])).pad(0.3), { maxZoom: 20 });
    } else if (v) {
      map.setView(v.center, v.zoom);
    } else {
      map.setView([54, -2], 5);
      locateMe(false);
    }
  });
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
  }
  for (const [id, m] of state.markers) {
    if (!seen.has(id)) { m.remove(); state.markers.delete(id); }
  }
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

/* ---------------- Walk mode ---------------- */

async function toggleWalk() {
  const w = state.walk;
  const btn = $("#btn-walk");
  if (w.active) {
    navigator.geolocation.clearWatch(w.watchId);
    w.active = false;
    w.wakeLock?.release?.().catch(() => {});
    w.wakeLock = null;
    btn.setAttribute("aria-pressed", "false");
    $(".label", btn).textContent = "Start walk";
    await meta.set("walkPath", w.path);
    gpsChip(null);
    toast("Walk saved");
    return;
  }
  if (!("geolocation" in navigator)) return toast("This device can't share its location.");
  w.active = true;
  btn.setAttribute("aria-pressed", "true");
  $(".label", btn).textContent = "Stop walk";
  try { w.wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* optional */ }
  let first = true;
  w.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const pt = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, t: Date.now() };
      showMe(pt.lat, pt.lng, pt.acc);
      gpsChip(pt.acc);
      if (first) { state.map?.setView([pt.lat, pt.lng], Math.max(state.map.getZoom(), 19)); first = false; }
      else state.map?.panTo([pt.lat, pt.lng], { animate: true });
      const last = w.path[w.path.length - 1];
      if (pt.acc <= 20 && (!last || metres(last, pt) >= 1.5)) {
        w.path.push(pt);
        w.line?.addLatLng([pt.lat, pt.lng]);
        if (w.path.length % 10 === 0) meta.set("walkPath", w.path);
      }
    },
    (err) => {
      toast(err.code === 1 ? "Location permission is off for this site." : "Lost GPS signal.");
      if (err.code === 1) toggleWalk();
    },
    { enableHighAccuracy: true, maximumAge: 0 }
  );
  toast("Walking. Tap Add plant here at each plant.");
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

  const sampler = sampleFix({
    onProgress: (fix, raw) => {
      draft.fix = fix;
      const quality = Math.max(0, Math.min(1, (25 - fix.accuracy) / 22));
      const ring = $("#fix .val");
      if (!ring) return;
      ring.style.strokeDashoffset = String(C * (1 - quality));
      $("#fix-acc").textContent = `±${fix.accuracy.toFixed(1)} m`;
      $("#fix-sub").textContent = `${fix.samples} reading${fix.samples === 1 ? "" : "s"} · latest ±${Math.round(raw.accuracy)} m`;
      gpsChip(raw.accuracy);
      showMe(fix.lat, fix.lng, fix.accuracy);
    },
  });
  sampler.promise.then(
    (fix) => {
      draft.fix = fix;
      if ($("#fix-sub")) $("#fix-sub").textContent = `Locked from ${fix.samples} readings`;
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
          const fix = await sampleFix({ onProgress: (f) => (t.textContent = `±${f.accuracy.toFixed(1)} m…`) }).promise;
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
  const actions = $(".map-actions");
  const saved = actions.innerHTML;
  actions.innerHTML = `<span class="pill">Drag the pin to the plant</span><button class="fab" id="move-done">Done</button>`;
  $("#move-done").onclick = async () => {
    m.dragging.disable();
    const ll = m.getLatLng();
    Object.assign(p, { lat: ll.lat, lng: ll.lng, approx: true, accuracy: null });
    state.moving = null;
    actions.innerHTML = saved;
    bindMapActions();
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
}

async function exportBackup() {
  const ph = await photoStore.all();
  const data = {
    app: "garden-log", version: 1, exportedAt: new Date().toISOString(),
    plants: state.plants,
    photos: await Promise.all(ph.map(async (x) => ({ id: x.id, plantId: x.plantId, createdAt: x.createdAt, data: await blobToBase64(x.blob) }))),
    walkPath: state.walk.path,
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
    if (data.jobsDone) await meta.set("jobsDone", { ...state.jobsDone, ...data.jobsDone });
    await loadAll();
    state.walk.line?.setLatLngs(state.walk.path.map((p) => [p.lat, p.lng]));
    renderAll();
    toast(`Imported ${data.plants?.length || 0} plants`);
  } catch {
    toast("That file isn't a Garden Log backup.");
  }
}

function bindMapActions() {
  $("#btn-add").onclick = openAddPlant;
  $("#btn-walk").onclick = toggleWalk;
  if (state.walk.active) {
    $("#btn-walk").setAttribute("aria-pressed", "true");
    $("#btn-walk .label").textContent = "Stop walk";
  }
}

function bindUI() {
  $$(".tab").forEach((t) => (t.onclick = () => switchView(t.dataset.view)));
  bindMapActions();
  $("#btn-locate").onclick = () => locateMe(true);
  $("#btn-layer").onclick = () => {
    if (!state.map) return;
    state.layers[state.layerIdx].remove();
    state.layerIdx = (state.layerIdx + 1) % state.layers.length;
    state.layers[state.layerIdx].addTo(state.map);
  };
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
    state.settings = { apiKey: $("#set-key").value.trim(), model: $("#set-model").value, climate: $("#set-climate").value.trim() };
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
