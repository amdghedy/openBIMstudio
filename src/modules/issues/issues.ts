/** Issue state + viewpoint capture/restore. Persisted via the projects module. */
import * as THREE from "three";
import { ctx } from "../../core/context";
import { getProjection, updateClipping } from "../../features/camera-tools";
import type {
  ClippingPlaneState,
  Issue,
  IssueComment,
  IssuePriority,
  IssueStatus,
  IssueViewpoint,
} from "./types";
import { syncOrthoZoom } from "../../core/ortho-zoom";

let issues: Issue[] = [];
const listeners = new Set<() => void>();

export function onIssuesChanged(cb: () => void) {
  listeners.add(cb);
}
function notify() {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* */
    }
  }
}

export function getIssues() {
  return issues;
}
export function setIssues(list: Issue[] | undefined | null) {
  issues = Array.isArray(list) ? list : [];
  notify();
}
export function getIssue(id: string) {
  return issues.find((i) => i.id === id);
}

const uid = () =>
  (crypto as any).randomUUID?.() ??
  `i-${Date.now()}-${Math.random().toString(16).slice(2)}`;

// ── Author identity ──
export function getAuthor(): string {
  try {
    return localStorage.getItem("obs.author") || "Anonymous";
  } catch {
    return "Anonymous";
  }
}
export function setAuthor(name: string) {
  try {
    localStorage.setItem("obs.author", name.trim() || "Anonymous");
  } catch {
    /* */
  }
}

// ── Selection extraction ──
function isNumericSet(v: any): v is Set<number> {
  if (!(v instanceof Set) || v.size === 0) return false;
  for (const x of v) if (typeof x !== "number") return false;
  return true;
}
function scanIdMaps(
  root: any,
  depth = 0,
  out: Record<string, Set<number>> = {},
): Record<string, Set<number>> {
  if (!root || depth > 4) return out;
  if (root instanceof Map) {
    for (const [k, v] of root) {
      if (isNumericSet(v)) out[String(k)] = v;
      else scanIdMaps(v, depth + 1, out);
    }
    return out;
  }
  if (Array.isArray(root)) {
    for (const v of root) scanIdMaps(v, depth + 1, out);
    return out;
  }
  if (typeof root !== "object") return out;
  for (const [k, v] of Object.entries(root)) {
    if (isNumericSet(v)) out[k] = v as Set<number>;
    else if (v && typeof v === "object") scanIdMaps(v, depth + 1, out);
  }
  return out;
}

export function currentSelectionMap(): Record<string, number[]> {
  const maps = scanIdMaps((ctx.highlighter as any)?.selection);
  const plain: Record<string, number[]> = {};
  for (const [k, s] of Object.entries(maps)) plain[k] = Array.from(s as Set<number>);
  return plain;
}

// ── Clipper state (best-effort read) ──
function readClippingPlanes(): ClippingPlaneState[] {
  try {
    const list = (ctx.clipper as any)?.list;
    if (!list) return [];
    const out: ClippingPlaneState[] = [];
    // DataSet-like: iterate Map, or fall back to array
    const iter: any = list[Symbol.iterator] ? list : null;
    if (iter) {
      for (const entry of iter) {
        const item = Array.isArray(entry) ? entry[1] : entry;
        const p: THREE.Plane = item?.three ?? item;
        if (!p?.normal || typeof p.constant !== "number") continue;
        const n = p.normal.clone().normalize();
        // Plane equation: n·x + c = 0 → point on plane at -c·n
        const loc = n.clone().multiplyScalar(-p.constant);
        out.push({
          location: [loc.x, loc.y, loc.z],
          direction: [n.x, n.y, n.z],
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ── Viewpoint capture / restore ──
export function captureThumbnail(maxW = 260): string {
  const renderer = ctx.world.renderer.three as THREE.WebGLRenderer;
  try {
    renderer.render(ctx.world.scene.three, ctx.world.camera.three);
  } catch {
    /* */
  }
  const src = renderer.domElement;
  const scale = Math.min(1, maxW / Math.max(src.width, 1));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(src.width * scale));
  c.height = Math.max(1, Math.round(src.height * scale));
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

export function captureViewpoint(withThumbnail = true): IssueViewpoint {
  const cam = ctx.world.camera.three;
  const controls: any = ctx.world.camera.controls;
  const target = new THREE.Vector3();
  try {
    if (controls.target?.isVector3) target.copy(controls.target);
  } catch {
    /* */
  }
  const up = cam.up.clone();
  const vp: IssueViewpoint = {
    cam: [cam.position.x, cam.position.y, cam.position.z],
    target: [target.x, target.y, target.z],
    up: [up.x, up.y, up.z],
    projection: getProjection(),
  };

  // Ortho scale
  if ((cam as any).isOrthographicCamera) {
    const ortho = cam as THREE.OrthographicCamera;
    vp.orthoScale = (ortho.top - ortho.bottom) / Math.max(0.0001, ortho.zoom);
  }

  if (withThumbnail) {
    try {
      vp.thumbnail = captureThumbnail();
    } catch {
      /* */
    }
  }
  const sel = currentSelectionMap();
  if (Object.keys(sel).length) vp.selection = sel;

  const planes = readClippingPlanes();
  if (planes.length) vp.clippingPlanes = planes;

  return vp;
}

export function goToViewpoint(vp: IssueViewpoint) {
  if (vp.projection && vp.projection !== getProjection()) {
    try {
      (ctx.cam as any).setProjection?.(vp.projection);
    } catch {
      /* */
    }
  }
  if (vp.up) {
    ctx.world.camera.three.up.set(vp.up[0], vp.up[1], vp.up[2]);
  }
  ctx.world.camera.controls.setLookAt(
    vp.cam[0],
    vp.cam[1],
    vp.cam[2],
    vp.target[0],
    vp.target[1],
    vp.target[2],
    true,
  );

  // Restore ortho scale
  if (vp.orthoScale && (ctx.world.camera.three as any).isOrthographicCamera) {
    const ortho = ctx.world.camera.three as THREE.OrthographicCamera;
    const height = ortho.top - ortho.bottom;
    ortho.zoom = height / Math.max(0.0001, vp.orthoScale);
    syncOrthoZoom(ortho);
    ortho.updateProjectionMatrix();
  }

  updateClipping();

  // Restore selection
  try {
    const hl: any = ctx.highlighter;
    hl.clear?.("select");
    const map: any = {};
    for (const [mid, ids] of Object.entries(vp.selection ?? {})) {
      map[mid] = new Set(ids);
    }
    if (Object.keys(map).length) hl.highlightByID?.("select", map, true);
  } catch {
    /* */
  }

  // Restore clipping planes (best-effort — SDK API varies)
  try {
    if (vp.clippingPlanes?.length) {
      const clipper: any = ctx.clipper;
      if (typeof clipper.deleteAll === "function") clipper.deleteAll();
      if (typeof clipper.createFromNormalAndCoplanarPoint === "function") {
        for (const p of vp.clippingPlanes) {
          const normal = new THREE.Vector3(p.direction[0], p.direction[1], p.direction[2]);
          const point = new THREE.Vector3(p.location[0], p.location[1], p.location[2]);
          clipper.createFromNormalAndCoplanarPoint(ctx.world, normal, point);
        }
      }
    }
  } catch {
    /* */
  }
}

// ── CRUD ──
export function createIssue(
  title: string,
  description = "",
  vp?: IssueViewpoint,
): Issue {
  const issue: Issue = {
    id: uid(),
    title: title.trim() || "Untitled issue",
    description: description.trim(),
    status: "open",
    priority: "medium",
    author: getAuthor(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    viewpoint: vp ?? captureViewpoint(true),
    comments: [],
  };
  issues.unshift(issue);
  notify();
  return issue;
}

export function addComment(
  issueId: string,
  text: string,
  withViewpoint = false,
): IssueComment | null {
  const issue = getIssue(issueId);
  if (!issue || !text.trim()) return null;
  const c: IssueComment = {
    id: uid(),
    author: getAuthor(),
    date: Date.now(),
    text: text.trim(),
    ...(withViewpoint ? { viewpoint: captureViewpoint(true) } : {}),
  };
  issue.comments.push(c);
  issue.updatedAt = Date.now();
  notify();
  return c;
}

export function setStatus(issueId: string, status: IssueStatus) {
  const i = getIssue(issueId);
  if (!i) return;
  i.status = status;
  i.updatedAt = Date.now();
  notify();
}

export function setPriority(issueId: string, priority: IssuePriority) {
  const i = getIssue(issueId);
  if (!i) return;
  i.priority = priority;
  i.updatedAt = Date.now();
  notify();
}

export function setAssignee(issueId: string, name: string) {
  const i = getIssue(issueId);
  if (!i) return;
  i.assignee = name.trim() || undefined;
  i.updatedAt = Date.now();
  notify();
}

export function setDueDate(issueId: string, date: number | undefined) {
  const i = getIssue(issueId);
  if (!i) return;
  i.dueDate = date;
  i.updatedAt = Date.now();
  notify();
}

export function deleteIssue(issueId: string) {
  issues = issues.filter((i) => i.id !== issueId);
  notify();
}

// ── Setup ──
export function setupIssues() {
  ctx.features.issues = {
    getIssues,
    setIssues,
    createIssue,
    addComment,
    setStatus,
    setPriority,
    setAssignee,
    setDueDate,
    deleteIssue,
    captureViewpoint,
    goToViewpoint,
    getAuthor,
    setAuthor,
    onIssuesChanged,
  };
}