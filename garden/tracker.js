// Position tracker that fuses GPS with step counting and the compass.
//
// Phone GPS on its own wanders by several metres, which turns a straight bed edge into a zigzag.
// Steps + compass (pedestrian dead reckoning) are smooth over short distances but drift over long
// ones. A small Kalman filter combines them: each step moves the estimate and grows its uncertainty,
// and each GPS reading pulls it back in proportion to how much the two are trusted.

import { toLocal, toLatLng } from "./geo.js";

const STEP_THRESHOLD = 1.1; // m/s² above the running baseline counts as a footfall peak
const MIN_STEP_MS = 280;
const MAX_STEP_MS = 2000;

// Tuning, checked against simulated walks round 6×4 m and 12×8 m beds (GPS with drifting error).
export const TUNING = {
  gpsTrustFused: 2.0, // GPS errors drift slowly rather than jumping, so with steps we lean on it less
  gpsTrustAlone: 1.0,
  stepNoise: 0.15, // fraction of step length
  walkNoise: 1.5, // m/s of unexplained movement allowed between GPS fixes without steps
};

export class Tracker {
  constructor({ stepLength = 0.7, useMotion = true, onUpdate } = {}) {
    this.stepLength = stepLength;
    this.useMotion = useMotion;
    this.onUpdate = onUpdate;
    this.listeners = new Set();
    this.active = false;
    this.reset();
    this._onMotion = (e) => this.handleMotion(e);
    this._onOrient = (e) => this.handleOrientation(e);
  }

  reset() {
    this.origin = null; // {lat, lng} of the local metre frame
    this.est = null; // {e, n} metres east/north of origin
    this.variance = 100;
    this.lastTime = 0;
    this.heading = null; // degrees clockwise from north, smoothed
    this.hx = 0; this.hy = 0;
    this.steps = 0;
    this.lastStep = 0;
    this.smooth = 9.81; this.baseline = 9.81; this.inPeak = false;
    this.rejects = 0;
    this.gpsAccuracy = null;
  }

  /** Must be called from a tap: iOS only grants motion/compass permission during a user gesture. */
  async start() {
    if (this.active) return;
    this.active = true;
    this.reset();

    let motionOK = this.useMotion;
    if (this.useMotion) {
      // Call both permission prompts synchronously so they share the same user gesture.
      const askMotion = typeof DeviceMotionEvent !== "undefined" && DeviceMotionEvent.requestPermission?.();
      const askOrient = typeof DeviceOrientationEvent !== "undefined" && DeviceOrientationEvent.requestPermission?.();
      try {
        const [m, o] = await Promise.all([askMotion, askOrient]);
        if ((askMotion && m !== "granted") || (askOrient && o !== "granted")) motionOK = false;
      } catch {
        motionOK = false;
      }
    }
    this.motion = motionOK;
    if (motionOK) {
      window.addEventListener("devicemotion", this._onMotion);
      this.orientEvent = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
      window.addEventListener(this.orientEvent, this._onOrient);
    }

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.handleGPS(pos),
      (err) => this.onError?.(err),
      { enableHighAccuracy: true, maximumAge: 0 }
    );
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    navigator.geolocation.clearWatch(this.watchId);
    window.removeEventListener("devicemotion", this._onMotion);
    if (this.orientEvent) window.removeEventListener(this.orientEvent, this._onOrient);
  }

  /** True once steps and a compass heading are both arriving. */
  get deadReckoning() {
    return this.motion && this.heading != null && this.steps > 0;
  }

  get position() {
    if (!this.est) return null;
    const { lat, lng } = toLatLng(this.est, this.origin);
    return { lat, lng, accuracy: Math.sqrt(this.variance), steps: this.steps, heading: this.heading, fused: this.deadReckoning };
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  emit() {
    const p = this.position;
    if (!p) return;
    this.onUpdate?.(p);
    for (const fn of this.listeners) fn(p);
  }

  handleGPS(pos) {
    const { latitude: lat, longitude: lng, accuracy, speed, heading } = pos.coords;
    const now = pos.timestamp || Date.now();
    this.gpsAccuracy = accuracy;
    const trust = this.deadReckoning ? TUNING.gpsTrustFused : TUNING.gpsTrustAlone;
    const r2 = (Math.max(accuracy, 2) * trust) ** 2;

    if (!this.origin) {
      this.origin = { lat, lng };
      this.est = { e: 0, n: 0 };
      this.variance = r2;
      this.lastTime = now;
      return this.emit();
    }

    const dt = Math.min(Math.max((now - this.lastTime) / 1000, 0), 30);
    this.lastTime = now;
    if (this.deadReckoning) {
      // Steps already moved the estimate; allow only a little drift.
      this.variance += 0.03 * dt;
    } else {
      // No steps: move along the GPS's own speed and direction (when it reports them), so the
      // estimate doesn't lag behind and cut corners, then allow for some unexplained movement.
      if (speed > 0.3 && heading != null && !Number.isNaN(heading)) {
        const h = (heading * Math.PI) / 180;
        this.est.e += speed * dt * Math.sin(h);
        this.est.n += speed * dt * Math.cos(h);
      }
      this.variance += Math.min((TUNING.walkNoise * dt) ** 2, 400);
    }

    const g = toLocal({ lat, lng }, this.origin);
    const de = g.e - this.est.e, dn = g.n - this.est.n;
    const dist = Math.hypot(de, dn);
    // Ignore a wild GPS jump unless it keeps happening (then we're the ones who are wrong).
    if (dist > 4 * Math.sqrt(this.variance + r2) && this.rejects < 3) {
      this.rejects++;
      return;
    }
    this.rejects = 0;
    const k = this.variance / (this.variance + r2);
    this.est.e += k * de;
    this.est.n += k * dn;
    this.variance *= 1 - k;
    this.emit();
  }

  handleOrientation(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading; // iOS
    else if (e.absolute && typeof e.alpha === "number") h = 360 - e.alpha; // Android
    if (h == null || Number.isNaN(h)) return;
    h += screen.orientation?.angle || 0;
    const rad = (h * Math.PI) / 180;
    // Circular low-pass filter so the heading doesn't jitter.
    this.hx = this.hx * 0.85 + Math.sin(rad) * 0.15;
    this.hy = this.hy * 0.85 + Math.cos(rad) * 0.15;
    this.heading = ((Math.atan2(this.hx, this.hy) * 180) / Math.PI + 360) % 360;
  }

  handleMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    const mag = Math.hypot(a.x, a.y, a.z);
    this.smooth += 0.3 * (mag - this.smooth);
    this.baseline += 0.02 * (mag - this.baseline);
    const d = this.smooth - this.baseline;
    const now = performance.now();
    if (!this.inPeak && d > STEP_THRESHOLD) this.inPeak = true;
    else if (this.inPeak && d < 0) {
      this.inPeak = false;
      const gap = now - this.lastStep;
      if (gap > MIN_STEP_MS) {
        this.lastStep = now;
        if (gap < MAX_STEP_MS || this.steps === 0) this.onStep();
      }
    }
  }

  onStep() {
    this.steps++;
    if (!this.est || this.heading == null) return;
    const rad = (this.heading * Math.PI) / 180;
    const L = this.stepLength;
    this.est.e += L * Math.sin(rad);
    this.est.n += L * Math.cos(rad);
    // Step length and compass are both a little uncertain, so each step adds some doubt.
    this.variance += (TUNING.stepNoise * L) ** 2;
    this.emit();
  }
}
