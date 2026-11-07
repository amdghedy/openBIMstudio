// Minimal, behaviour-faithful subset of three.js (Vector3, Box3) for running the pure clash
// engine in Node, where the real `three` package is not installed. Only what clash code uses.
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setScalar(s) { this.x = this.y = this.z = s; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addVectors(a, b) { this.x = a.x + b.x; this.y = a.y + b.y; this.z = a.z + b.z; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  negate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v) { return this.crossVectors(this, v); }
  crossVectors(a, b) { const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x; this.x = x; this.y = y; this.z = z; return this; }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  distanceToSquared(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return dx * dx + dy * dy + dz * dz; }
  fromBufferAttribute(a, i) { this.x = a.getX(i); this.y = a.getY(i); this.z = a.getZ(i); return this; }
}
class Box3 {
  constructor(min, max) { this.min = min || new Vector3(Infinity, Infinity, Infinity); this.max = max || new Vector3(-Infinity, -Infinity, -Infinity); }
  set(min, max) { this.min.copy(min); this.max.copy(max); return this; }
  clone() { return new Box3(this.min.clone(), this.max.clone()); }
  copy(b) { this.min.copy(b.min); this.max.copy(b.max); return this; }
  makeEmpty() { this.min.set(Infinity, Infinity, Infinity); this.max.set(-Infinity, -Infinity, -Infinity); return this; }
  isEmpty() { return this.max.x < this.min.x || this.max.y < this.min.y || this.max.z < this.min.z; }
  setFromPoints(pts) { this.makeEmpty(); for (const p of pts) this.expandByPoint(p); return this; }
  expandByPoint(p) { this.min.x = Math.min(this.min.x, p.x); this.min.y = Math.min(this.min.y, p.y); this.min.z = Math.min(this.min.z, p.z); this.max.x = Math.max(this.max.x, p.x); this.max.y = Math.max(this.max.y, p.y); this.max.z = Math.max(this.max.z, p.z); return this; }
  expandByScalar(s) { this.min.x -= s; this.min.y -= s; this.min.z -= s; this.max.x += s; this.max.y += s; this.max.z += s; return this; }
  getCenter(t) { return this.isEmpty() ? t.set(0, 0, 0) : t.set((this.min.x + this.max.x) / 2, (this.min.y + this.max.y) / 2, (this.min.z + this.max.z) / 2); }
  getSize(t) { return this.isEmpty() ? t.set(0, 0, 0) : t.set(this.max.x - this.min.x, this.max.y - this.min.y, this.max.z - this.min.z); }
  containsPoint(p) { return !(p.x < this.min.x || p.x > this.max.x || p.y < this.min.y || p.y > this.max.y || p.z < this.min.z || p.z > this.max.z); }
  intersectsBox(b) { return !(b.max.x < this.min.x || b.min.x > this.max.x || b.max.y < this.min.y || b.min.y > this.max.y || b.max.z < this.min.z || b.min.z > this.max.z); }
  intersect(b) { this.min.x = Math.max(this.min.x, b.min.x); this.min.y = Math.max(this.min.y, b.min.y); this.min.z = Math.max(this.min.z, b.min.z); this.max.x = Math.min(this.max.x, b.max.x); this.max.y = Math.min(this.max.y, b.max.y); this.max.z = Math.min(this.max.z, b.max.z); if (this.isEmpty()) this.makeEmpty(); return this; }
  union(b) { this.min.x = Math.min(this.min.x, b.min.x); this.min.y = Math.min(this.min.y, b.min.y); this.min.z = Math.min(this.min.z, b.min.z); this.max.x = Math.max(this.max.x, b.max.x); this.max.y = Math.max(this.max.y, b.max.y); this.max.z = Math.max(this.max.z, b.max.z); return this; }
}
module.exports = { Vector3, Box3 };
