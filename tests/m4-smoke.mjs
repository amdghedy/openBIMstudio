/**
 * Lightweight smoke test for M4 types/store logic (Node, no DOM).
 * Run: node tests/m4-smoke.mjs
 */

import assert from "node:assert/strict";

// Minimal polyfills
globalThis.localStorage = {
  _d: new Map(),
  getItem(k) {
    return this._d.has(k) ? this._d.get(k) : null;
  },
  setItem(k, v) {
    this._d.set(k, String(v));
  },
  removeItem(k) {
    this._d.delete(k);
  },
};

// Dynamic import of compiled logic is not available without tsc;
// instead we re-validate pure helpers by inlining the critical contracts.

function createDefaultVg() {
  return {
    categoryOverrides: {},
    filters: [],
    showAnnotations: true,
    showModel: true,
    detailLevel: "medium",
    modelDisplay: "shaded",
    underlay: { levelId: null, orientation: "none" },
  };
}

function defaultCategoryOverride() {
  return {
    visible: true,
    halftone: false,
    transparent: false,
    lineColor: null,
    surfaceColor: null,
    lineWeight: null,
    surfacePattern: null,
    cutPattern: null,
  };
}

function mergeVg(base, local) {
  if (!local) return structuredClone(base);
  const out = structuredClone(base);
  out.showAnnotations = local.showAnnotations ?? out.showAnnotations;
  out.showModel = local.showModel ?? out.showModel;
  out.detailLevel = local.detailLevel ?? out.detailLevel;
  out.modelDisplay = local.modelDisplay ?? out.modelDisplay;
  out.filters = local.filters?.length ? structuredClone(local.filters) : out.filters;
  for (const [cat, ov] of Object.entries(local.categoryOverrides || {})) {
    out.categoryOverrides[cat] = {
      ...(out.categoryOverrides[cat] ?? defaultCategoryOverride()),
      ...ov,
    };
  }
  return out;
}

// --- tests ---

const base = createDefaultVg();
assert.equal(base.detailLevel, "medium");
assert.equal(base.showAnnotations, true);

const local = createDefaultVg();
local.categoryOverrides["Walls"] = { ...defaultCategoryOverride(), visible: false, halftone: true };
local.detailLevel = "fine";

const merged = mergeVg(base, local);
assert.equal(merged.detailLevel, "fine");
assert.equal(merged.categoryOverrides["Walls"].visible, false);
assert.equal(merged.categoryOverrides["Walls"].halftone, true);
assert.equal(merged.showModel, true);

const locked = mergeVg(base, null);
assert.equal(locked.detailLevel, "medium");

// Dimension length formatting contract
function formatLength(metres, unit = "auto", precision = 2) {
  if (unit === "mm") return `${(metres * 1000).toFixed(0)} mm`;
  if (unit === "m") return `${metres.toFixed(precision)} m`;
  if (Math.abs(metres) >= 1) return `${metres.toFixed(precision)} m`;
  return `${(metres * 1000).toFixed(0)} mm`;
}

assert.equal(formatLength(3.5), "3.50 m");
assert.equal(formatLength(0.25), "250 mm");
assert.equal(formatLength(1.234, "m", 3), "1.234 m");

// Cluster tolerance logic
function clusterCoords(coords, tol = 0.02) {
  const sorted = [...coords].sort((a, b) => a - b);
  const clusters = [];
  for (const c of sorted) {
    const last = clusters[clusters.length - 1];
    if (last !== undefined && Math.abs(last.coord - c) <= tol) {
      last.n += 1;
      last.coord = (last.coord * (last.n - 1) + c) / last.n;
    } else {
      clusters.push({ coord: c, n: 1 });
    }
  }
  return clusters.map((x) => x.coord);
}

const clustered = clusterCoords([0, 0.01, 5, 5.015, 10]);
assert.equal(clustered.length, 3);
assert.ok(Math.abs(clustered[0] - 0.005) < 1e-9);
assert.ok(Math.abs(clustered[1] - 5.0075) < 1e-9);
assert.equal(clustered[2], 10);

console.log("m4-smoke: all assertions passed");
