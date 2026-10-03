// Small geometry helpers. Garden-sized areas are flat enough to treat lat/lng as a local metre grid.

const M_PER_DEG = 111320;
const rad = (d) => (d * Math.PI) / 180;

export function toLocal(p, origin) {
  return {
    e: (p.lng - origin.lng) * M_PER_DEG * Math.cos(rad(origin.lat)),
    n: (p.lat - origin.lat) * M_PER_DEG,
  };
}

export function toLatLng(p, origin) {
  return {
    lat: origin.lat + p.n / M_PER_DEG,
    lng: origin.lng + p.e / (M_PER_DEG * Math.cos(rad(origin.lat))),
  };
}

const local = (pts) => pts.map((p) => toLocal(p, pts[0]));

/** Length in metres of a line through the points (closed adds the last→first edge). */
export function lengthM(pts, closed = false) {
  if (pts.length < 2) return 0;
  const l = local(pts);
  let d = 0;
  for (let i = 1; i < l.length; i++) d += Math.hypot(l[i].e - l[i - 1].e, l[i].n - l[i - 1].n);
  if (closed) d += Math.hypot(l[0].e - l[l.length - 1].e, l[0].n - l[l.length - 1].n);
  return d;
}

/** Area in m² of a polygon (shoelace formula). */
export function areaM2(pts) {
  if (pts.length < 3) return 0;
  const l = local(pts);
  let s = 0;
  for (let i = 0; i < l.length; i++) {
    const a = l[i], b = l[(i + 1) % l.length];
    s += a.e * b.n - b.e * a.n;
  }
  return Math.abs(s) / 2;
}

/** Douglas–Peucker: drop points that sit within `tol` metres of the line through their neighbours. */
export function simplify(pts, tol = 0.25) {
  if (pts.length < 3) return pts.slice();
  const l = local(pts);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const A = l[s], B = l[e];
    const dx = B.e - A.e, dy = B.n - A.n, len2 = dx * dx + dy * dy;
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const P = l[i];
      let t = len2 ? ((P.e - A.e) * dx + (P.n - A.n) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(P.e - (A.e + t * dx), P.n - (A.n + t * dy));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.lat > p.lat) !== (b.lat > p.lat) && p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng) inside = !inside;
  }
  return inside;
}

export function formatArea(m2) {
  return m2 >= 100 ? `${Math.round(m2)} m²` : `${m2.toFixed(1)} m²`;
}

export function formatLength(m) {
  return m >= 100 ? `${Math.round(m)} m` : `${m.toFixed(1)} m`;
}

/**
 * Loop closure for a shape walked back to its start: any gap between the last and first point is
 * accumulated drift, so spread the correction along the walk (none at the start, all of it at the end).
 */
export function closeLoop(pts) {
  if (pts.length < 4) return pts;
  const first = pts[0], last = pts[pts.length - 1];
  const dLat = last.lat - first.lat, dLng = last.lng - first.lng;
  // Cumulative distance, so the correction grows with distance walked rather than point count.
  const l = local(pts);
  const cum = [0];
  for (let i = 1; i < l.length; i++) cum.push(cum[i - 1] + Math.hypot(l[i].e - l[i - 1].e, l[i].n - l[i - 1].n));
  const total = cum[cum.length - 1] || 1;
  return pts.slice(0, -1).map((p, i) => ({ lat: p.lat - dLat * (cum[i] / total), lng: p.lng - dLng * (cum[i] / total) }));
}
