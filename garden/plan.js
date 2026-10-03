// The garden plan: feature types and styles, and a metre grid drawn instead of satellite imagery.

export const FEATURE_TYPES = {
  bed:      { label: "Bed or border",   closed: true,  color: "#7a5a3c", fill: "#b48a5f" },
  veg:      { label: "Veg patch",       closed: true,  color: "#6b5233", fill: "#9c7a4e" },
  lawn:     { label: "Lawn",            closed: true,  color: "#5f8f4a", fill: "#9fca85" },
  patio:    { label: "Patio or decking", closed: true, color: "#8f8676", fill: "#d2cabb" },
  building: { label: "Shed or building", closed: true, color: "#555c63", fill: "#9aa1a8" },
  water:    { label: "Pond or water",   closed: true,  color: "#3f84b3", fill: "#93c6e6" },
  path:     { label: "Path",            closed: false, color: "#c2b494", weight: 8 },
  hedge:    { label: "Hedge",           closed: false, color: "#3c7536", weight: 10 },
  boundary: { label: "Fence or wall",   closed: false, color: "#4a3f35", weight: 3 },
  other:    { label: "Other area",      closed: true,  color: "#8d8778", fill: "#e3ddcf", dash: "6 6" },
};

export function featureStyle(f, satellite = false) {
  const t = FEATURE_TYPES[f.type] || FEATURE_TYPES.other;
  if (!f.closed || !t.fill) {
    return { color: t.color, weight: t.weight || 3, opacity: 0.95, lineCap: "round", lineJoin: "round", dashArray: t.dash, fill: false };
  }
  return {
    color: t.color, weight: 2, opacity: 0.95, dashArray: t.dash,
    fillColor: t.fill, fillOpacity: satellite ? 0.35 : 0.8, lineJoin: "round",
  };
}

/** A Leaflet grid layer that draws 1 m / 5 m / 10 m lines like squared paper. */
export function createGridLayer(L, { minor = "rgba(60,80,60,0.12)", major = "rgba(60,80,60,0.28)", lat0 = 51.5 } = {}) {
  const cos = Math.cos((lat0 * Math.PI) / 180);
  const M = 111320;
  return new (L.GridLayer.extend({
    createTile(coords) {
      const size = this.getTileSize();
      const tile = document.createElement("canvas");
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      tile.width = size.x * dpr;
      tile.height = size.y * dpr;
      const ctx = tile.getContext("2d");
      ctx.scale(dpr, dpr);
      const nwPx = coords.scaleBy(size);
      const nw = this._map.unproject(nwPx, coords.z);
      const se = this._map.unproject(nwPx.add(size), coords.z);
      const w = (nw.lng * M * cos), e = (se.lng * M * cos);
      const n = nw.lat * M, s = se.lat * M;
      const pxPerM = size.x / (e - w);
      // Pick a spacing that keeps lines at least ~10 px apart.
      const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
      const step = steps.find((st) => st * pxPerM >= 10) || 1000;
      // Heavier line every 5 steps (every 2 when the step is 0.5/5/50 m), so majors land on round numbers.
      const majorEvery = String(step).replace(/[0.]/g, "")[0] === "5" ? 2 : 5;
      const lines = (from, to, draw) => {
        for (let v = Math.ceil(from / step) * step; v <= to; v += step) {
          const isMajor = Math.round(v / step) % majorEvery === 0;
          ctx.strokeStyle = isMajor ? major : minor;
          ctx.lineWidth = isMajor ? 1 : 0.6;
          ctx.beginPath();
          draw(v);
          ctx.stroke();
        }
      };
      lines(w, e, (v) => { const x = Math.round((v - w) * pxPerM) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, size.y); });
      lines(s, n, (v) => { const y = Math.round((n - v) * pxPerM) + 0.5; ctx.moveTo(0, y); ctx.lineTo(size.x, y); });
      return tile;
    },
  }))({ maxZoom: 25, pane: "tilePane" });
}
