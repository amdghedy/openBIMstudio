// openbim-step1:family-foundation
// Family system foundation - parametric geometry resolver.
//
// Walks a FamilyGeometrySpec together with a resolved parameter map and
// returns a THREE.Object3D. All primitives are built from scratch with
// THREE geometry classes; this module has no dependency on authoring.ts.

import * as THREE from "three";
import { evaluateFormula } from "./formula-engine";
import type {
  CustomGeometryBuilder,
  FamilyGeometrySpec,
  NumberRef,
  ProfileSpec,
  TransformSpec,
} from "./types";

const CUSTOM_BUILDERS = new Map<string, CustomGeometryBuilder>();

export function registerCustomBuilder(name: string, fn: CustomGeometryBuilder): void {
  CUSTOM_BUILDERS.set(name, fn);
}

export function getCustomBuilder(name: string): CustomGeometryBuilder | null {
  return CUSTOM_BUILDERS.get(name) ?? null;
}

/** Resolve a NumberRef to a concrete number given the parameter map. */
export function resolveNumber(ref: NumberRef, params: Record<string, any>): number {
  if ("const" in ref) return ref.const;
  if ("expr" in ref) {
    const n = evaluateFormula(ref.expr, params);
    if (n === null) {
      console.warn("[families] NumberRef expr '" + ref.expr + "' failed to evaluate; using 0");
      return 0;
    }
    return n;
  }
  const v = params[ref.ref];
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) {
    console.warn("[families] NumberRef '" + ref.ref + "' resolved to non-number; using 0");
    return 0;
  }
  return n;
}

/** Build a Transform matrix from a TransformSpec. */
export function resolveTransform(
  spec: TransformSpec | undefined,
  params: Record<string, any>,
): THREE.Object3D {
  const wrapper = new THREE.Group();
  if (!spec) return wrapper;
  if (spec.translate) {
    wrapper.position.set(
      resolveNumber(spec.translate[0], params),
      resolveNumber(spec.translate[1], params),
      resolveNumber(spec.translate[2], params),
    );
  }
  if (spec.rotate) {
    wrapper.rotation.set(
      resolveNumber(spec.rotate[0], params),
      resolveNumber(spec.rotate[1], params),
      resolveNumber(spec.rotate[2], params),
    );
  }
  if (spec.scale) {
    wrapper.scale.set(
      resolveNumber(spec.scale[0], params),
      resolveNumber(spec.scale[1], params),
      resolveNumber(spec.scale[2], params),
    );
  }
  return wrapper;
}

function profileToShape(profile: ProfileSpec, params: Record<string, any>): THREE.Shape {
  const shape = new THREE.Shape();
  if (profile.kind === "rect") {
    const w = resolveNumber(profile.w, params);
    const h = resolveNumber(profile.h, params);
    shape.moveTo(-w / 2, -h / 2);
    shape.lineTo( w / 2, -h / 2);
    shape.lineTo( w / 2,  h / 2);
    shape.lineTo(-w / 2,  h / 2);
    shape.closePath();
  } else if (profile.kind === "circle") {
    const r = resolveNumber(profile.r, params);
    shape.absarc(0, 0, r, 0, Math.PI * 2, false);
  } else if (profile.kind === "polygon") {
    const pts = profile.points;
    if (pts.length < 3) return shape;
    shape.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
    shape.closePath();
  }
  return shape;
}

function profileToHole(profile: ProfileSpec, params: Record<string, any>): THREE.Path {
  const shape = profileToShape(profile, params);
  const path = new THREE.Path();
  const pts = shape.getPoints(64);
  if (pts.length < 3) return path;
  path.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
  path.closePath();
  return path;
}

/**
 * Build a THREE.Object3D from a FamilyGeometrySpec + resolved parameters.
 * Returns null on unsupported spec or empty geometry.
 */
export function buildParametricGeometry(
  spec: FamilyGeometrySpec,
  params: Record<string, any>,
): THREE.Object3D | null {
  switch (spec.kind) {
    case "box": {
      const w = resolveNumber(spec.w, params);
      const d = resolveNumber(spec.d, params);
      const h = resolveNumber(spec.h, params);
      if (w <= 0 || d <= 0 || h <= 0) return null;
      const geo = new THREE.BoxGeometry(w, h, d);
      const mesh = new THREE.Mesh(geo);
      const wrap = resolveTransform(spec.transform, params);
      wrap.add(mesh);
      return wrap;
    }

    case "cylinder": {
      const r = resolveNumber(spec.r, params);
      const h = resolveNumber(spec.h, params);
      const seg = spec.segments ?? 24;
      if (r <= 0 || h <= 0) return null;
      const geo = new THREE.CylinderGeometry(r, r, h, seg);
      const mesh = new THREE.Mesh(geo);
      const wrap = resolveTransform(spec.transform, params);
      wrap.add(mesh);
      return wrap;
    }

    case "extrusion": {
      const shape = profileToShape(spec.profile, params);
      if (spec.holes && spec.holes.length) {
        for (const h of spec.holes) shape.holes.push(profileToHole(h, params));
      }
      const depth = resolveNumber(spec.depth, params);
      if (depth <= 0) return null;
      const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
      // Extrusion runs along +Z; centre it on Z so the transform origin is
      // the mid-depth of the solid. Caller can override with transform.
      geo.translate(0, 0, -depth / 2);
      const mesh = new THREE.Mesh(geo);
      const wrap = resolveTransform(spec.transform, params);
      wrap.add(mesh);
      return wrap;
    }

    case "composed": {
      const group = new THREE.Group();
      for (const part of spec.parts) {
        const child = buildParametricGeometry(part, params);
        if (child) group.add(child);
      }
      return group.children.length ? group : null;
    }

    case "custom": {
      const builder = CUSTOM_BUILDERS.get(spec.builder);
      if (!builder) {
        console.warn("[families] custom builder '" + spec.builder + "' is not registered");
        return null;
      }
      return builder(params, (ref) => resolveNumber(ref, params), (t) => resolveTransform(t, params));
    }
  }

  return null;
}

/** Colour every mesh in the tree with the given THREE colour. */
export function tintObject(root: THREE.Object3D, colour: THREE.Color | string): void {
  const c = colour instanceof THREE.Color ? colour : new THREE.Color(colour);
  root.traverse((obj: any) => {
    if (!obj.isMesh) return;
    if (!obj.material) obj.material = new THREE.MeshLambertMaterial({ color: c });
    else if (obj.material.color) obj.material.color.copy(c);
  });
}
