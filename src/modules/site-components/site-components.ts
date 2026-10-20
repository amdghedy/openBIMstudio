/**
 * Site Components Library — parking, planting, site furniture, equipment.
 *
 * BIM-equivalent of Revit's "Site Component" / "Parking Component" /
 * "Planting" tools. Generates lightweight parametric objects suitable for
 * scattering on a toposurface or pad.
 *
 * Each component is a self-contained Group with userData carrying the family
 * type, instance parameters and host handle.
 */

import * as THREE from "three";

export type SiteComponentType = "parking" | "tree" | "shrub" | "bench" | "lightpole" | "firehydrant" | "dumpster";

export interface SiteComponentParams {
  type: SiteComponentType;
  /** World position (X = East, Z = North). */
  position: { x: number; z: number };
  /** Elevation (Y). */
  elevation: number;
  /** Rotation around Y axis (radians). */
  rotation?: number;
  /** Per-type size override. */
  size?: number;
}

export interface SiteComponentResult {
  type: SiteComponentType;
  object: THREE.Object3D;
}

const COLORS: Record<SiteComponentType, number> = {
  parking: 0xf5f5f5,
  tree: 0x2f6b2f,
  shrub: 0x3d8c40,
  bench: 0x8b5a2b,
  lightpole: 0x6b7280,
  firehydrant: 0xdc2626,
  dumpster: 0x2563eb,
};

const SIZES: Record<SiteComponentType, number> = {
  parking: 2.5,
  tree: 3,
  shrub: 0.6,
  bench: 1.5,
  lightpole: 4,
  firehydrant: 0.8,
  dumpster: 1.5,
};

function makeParking(size: number): THREE.Object3D {
  const g = new THREE.Group();
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(size * 2.4, 0.02, size * 4.8),
    new THREE.MeshLambertMaterial({ color: COLORS.parking, transparent: true, opacity: 0.7 }),
  );
  g.add(box);
  // Striped markings
  for (let i = -1; i <= 1; i++) {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(size * 0.1, 0.025, size * 4.5),
      new THREE.MeshBasicMaterial({ color: 0xfbbf24 }),
    );
    stripe.position.set(i * size * 1.1, 0.02, 0);
    g.add(stripe);
  }
  return g;
}

function makeTree(size: number): THREE.Object3D {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(size * 0.06, size * 0.08, size * 0.6, 8),
    new THREE.MeshLambertMaterial({ color: 0x6b4f2a }),
  );
  trunk.position.y = size * 0.3;
  g.add(trunk);
  const crown = new THREE.Mesh(
    new THREE.IcosahedronGeometry(size * 0.7, 1),
    new THREE.MeshLambertMaterial({ color: COLORS.tree, flatShading: true }),
  );
  crown.position.y = size * 1.0;
  g.add(crown);
  return g;
}

function makeShrub(size: number): THREE.Object3D {
  const m = new THREE.Mesh(
    new THREE.IcosahedronGeometry(size * 0.5, 0),
    new THREE.MeshLambertMaterial({ color: COLORS.shrub, flatShading: true }),
  );
  m.position.y = size * 0.4;
  return m;
}

function makeBench(size: number): THREE.Object3D {
  const g = new THREE.Group();
  const seat = new THREE.Mesh(
    new THREE.BoxGeometry(size * 1.6, 0.05, size * 0.4),
    new THREE.MeshLambertMaterial({ color: COLORS.bench }),
  );
  seat.position.y = size * 0.45;
  g.add(seat);
  for (const sx of [-size * 0.7, size * 0.7]) {
    const leg = new THREE.Mesh(
      new THREE.BoxGeometry(size * 0.08, size * 0.45, size * 0.4),
      new THREE.MeshLambertMaterial({ color: 0x4b5563 }),
    );
    leg.position.set(sx, size * 0.22, 0);
    g.add(leg);
  }
  return g;
}

function makeLightPole(size: number): THREE.Object3D {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(size * 0.04, size * 0.06, size, 8),
    new THREE.MeshLambertMaterial({ color: COLORS.lightpole }),
  );
  pole.position.y = size * 0.5;
  g.add(pole);
  const arm = new THREE.Mesh(
    new THREE.BoxGeometry(size * 0.5, size * 0.04, size * 0.04),
    new THREE.MeshLambertMaterial({ color: COLORS.lightpole }),
  );
  arm.position.set(size * 0.2, size * 0.98, 0);
  g.add(arm);
  const lamp = new THREE.Mesh(
    new THREE.BoxGeometry(size * 0.25, size * 0.06, size * 0.15),
    new THREE.MeshBasicMaterial({ color: 0xfde68a }),
  );
  lamp.position.set(size * 0.4, size * 0.95, 0);
  g.add(lamp);
  return g;
}

function makeFireHydrant(size: number): THREE.Object3D {
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(size * 0.2, size * 0.25, size * 0.15, 8),
    new THREE.MeshLambertMaterial({ color: 0x4b5563 }),
  );
  base.position.y = size * 0.075;
  g.add(base);
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(size * 0.15, size * 0.18, size * 0.7, 8),
    new THREE.MeshLambertMaterial({ color: COLORS.firehydrant }),
  );
  body.position.y = size * 0.5;
  g.add(body);
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(size * 0.16, 8, 6),
    new THREE.MeshLambertMaterial({ color: COLORS.firehydrant }),
  );
  cap.position.y = size * 0.9;
  g.add(cap);
  return g;
}

function makeDumpster(size: number): THREE.Object3D {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(size * 1.5, size * 1.0, size * 1.0),
    new THREE.MeshLambertMaterial({ color: COLORS.dumpster }),
  );
  body.position.y = size * 0.5;
  g.add(body);
  const lid = new THREE.Mesh(
    new THREE.BoxGeometry(size * 1.55, size * 0.1, size * 1.05),
    new THREE.MeshLambertMaterial({ color: 0x1e3a8a }),
  );
  lid.position.y = size * 1.05;
  g.add(lid);
  return g;
}

const FACTORIES: Record<SiteComponentType, (size: number) => THREE.Object3D> = {
  parking: makeParking,
  tree: makeTree,
  shrub: makeShrub,
  bench: makeBench,
  lightpole: makeLightPole,
  firehydrant: makeFireHydrant,
  dumpster: makeDumpster,
};

/** Build a site component instance. */
export function buildSiteComponent(input: SiteComponentParams): SiteComponentResult {
  const size = input.size ?? SIZES[input.type];
  const obj = FACTORIES[input.type](size);
  obj.position.set(input.position.x, input.elevation, input.position.z);
  obj.rotation.y = input.rotation ?? 0;
  obj.name = `obs-site-${input.type}`;
  obj.userData = {
    kind: "site-component",
    type: input.type,
    size,
  };
  return { type: input.type, object: obj };
}

/** Get the default size for a site component type. */
export function defaultSize(type: SiteComponentType): number {
  return SIZES[type];
}

/** Get the default colour for a site component type. */
export function defaultColor(type: SiteComponentType): number {
  return COLORS[type];
}
