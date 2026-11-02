import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

async function existsFile(fullPath) {
  try {
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

async function backup(rel) {
  const full = path.join(root, rel);
  if (!(await existsFile(full))) return false;
  await fs.copyFile(full, full + ".bak-" + stamp);
  return true;
}

async function read(rel) {
  return fs.readFile(path.join(root, rel), "utf8");
}

async function write(rel, content) {
  await fs.writeFile(path.join(root, rel), content, "utf8");
}

function cleanIconValue(value) {
  let clean = String(value || "").replace(/[^\x20-\x7E]/g, "").trim();

  if (/^[?\uFFFD]+$/.test(clean)) {
    clean = "";
  }

  return clean;
}

function cleanIcons(src) {
  let changed = false;

  src = src.replace(/icon:\s*"([^"]*)"/g, (match, value) => {
    const clean = cleanIconValue(value);
    if (clean !== value) changed = true;
    return 'icon: "' + clean + '"';
  });

  src = src.replace(/icon:\s*'([^']*)'/g, (match, value) => {
    const clean = cleanIconValue(value);
    if (clean !== value) changed = true;
    return "icon: '" + clean + "'";
  });

  return { src, changed };
}

function findMatchingBraceForward(src, start) {
  if (src[start] !== "{") return -1;

  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = start; i < src.length; i++) {
    const ch = src[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function patchFocusItems(src) {
  const focusObjectLines = [
    "{",
    '            type: "action",',
    '            text: "Focus",',
    '            icon: "",',
    "            onclick: () => {",
    "              void (async () => {",
    "                try {",
    '                  const m: any = await import("./focus-service");',
    "                  const ok = await m.focusSelected();",
    "                  if (!ok) {",
    "                    try {",
    '                      const n: any = await import("../core/notify");',
    '                      n.toast?.("Nothing selected to focus.", "warn");',
    "                    } catch {",
    "                      /* notify optional */",
    "                    }",
    "                  }",
    "                } catch (err) {",
    '                  console.warn("[context-menu] Focus selected object failed", err);',
    "                }",
    "              })();",
    "            },",
    "          }",
  ];

  const focusObject = focusObjectLines.join("\n");
  const re = /text:\s*["']Focus["']/g;
  const indexes = [];
  let m;

  while ((m = re.exec(src))) {
    indexes.push(m.index);
  }

  let changed = false;

  for (let i = indexes.length - 1; i >= 0; i--) {
    const textIndex = indexes[i];
    const start = src.lastIndexOf("{", textIndex);

    if (start < 0) continue;

    const end = findMatchingBraceForward(src, start);

    if (end < 0 || end < textIndex) continue;

    const before = src.slice(0, start);
    const after = src.slice(end + 1);

    src = before + focusObject + after;
    changed = true;
  }

  return { src, changed };
}

function patchRmbHandler(src) {
  const rmbReplacementLines = [
    'if (g.kind !== "rmb-click") return false;',
    "void (async () => {",
    "  try {",
    '    const selMod: any = await import("./selection");',
    "    const auth: any = (ctx as any).features?.authoring;",
    "",
    "    const authIdsRaw = auth?.getSelectedIds?.() ?? [];",
    "    const authIds: string[] = Array.from(authIdsRaw as any).map((x: any) => String(x));",
    "",
    "    const snap = selMod.selection?.snapshot?.() ?? {};",
    "    const fragSelected: Record<string, Set<number>> = {};",
    "    let fragCount = 0;",
    "",
    "    for (const [modelId, ids] of Object.entries(snap)) {",
    "      if (ids instanceof Set && ids.size) {",
    "        fragSelected[String(modelId)] = ids;",
    "        fragCount += ids.size;",
    "      }",
    "    }",
    "",
    "    const authoredIdRaw = auth?.pickAuthoredElementAt?.(g.event as MouseEvent) ?? null;",
    "    const hit = authoredIdRaw ? null : await selMod.pickFragmentAtPointer?.();",
    "",
    "    if (authoredIdRaw) {",
    "      const id = String(authoredIdRaw);",
    "",
    "      if (!authIds.includes(id) && fragCount === 0) {",
    '        auth?.setSelectedAuthored?.([...authIds, id], "replace");',
    "      }",
    "    } else if (hit) {",
    "      const modelKey = String(hit.modelId);",
    "      const set = fragSelected[modelKey];",
    "      const already = !!set && set.has(hit.localId);",
    "",
    "      if (!already && authIds.length === 0) {",
    "        selMod.selection.applyClick(hit.modelId, hit.localId, { ctrl: true });",
    "        await selMod.selection.applyToHighlighter?.();",
    "      }",
    "    }",
    "  } catch (err) {",
    '    console.warn("[context-menu] right-click preserve selection failed", err);',
    "  }",
    "",
    "  await openCtxMenu(g.event);",
    "})();",
    "return true;",
  ];

  const replacement = rmbReplacementLines.join("\n");

  const re =
    /if\s*\(\s*g\.kind\s*!==?\s*["']rmb-click["']\s*\)\s*return\s+false\s*;[\s\S]*?return\s+true\s*;/;

  if (re.test(src)) {
    src = src.replace(re, replacement);
    return { src, changed: true };
  }

  return { src, changed: false };
}

const focusService = `import * as THREE from "three";
import { ctx } from "../core/context";

type Any = Record<string, any>;

function w(): Any {
  return window as Any;
}

function c(): Any {
  return (ctx as Any) || w().__OBS_CTX__ || {};
}

function asSet(v: any): Set<number> {
  const out = new Set<number>();

  if (!v) return out;

  if (v instanceof Set) {
    for (const x of v) {
      const n = Number(x);
      if (Number.isFinite(n)) out.add(n);
    }
    return out;
  }

  if (Array.isArray(v)) {
    for (const x of v) {
      const n = Number(x);
      if (Number.isFinite(n)) out.add(n);
    }
    return out;
  }

  if (typeof v === "number" && Number.isFinite(v)) {
    out.add(v);
  }

  return out;
}

function mergeMap(
  target: Record<string, Set<number>>,
  source: any,
): void {
  if (!source || typeof source !== "object") return;

  for (const [modelId, value] of Object.entries(source)) {
    const ids = asSet(value);
    if (!ids.size) continue;

    const key = String(modelId);

    if (!target[key]) {
      target[key] = new Set<number>();
    }

    for (const id of ids) {
      target[key].add(id);
    }
  }
}

function getFragmentSelection(): Record<string, Set<number>> {
  const out: Record<string, Set<number>> = {};
  const cont = c();

  const sources: any[] = [
    cont.features?.selection,
    cont.highlighter,
    w().__obsSelection,
  ];

  for (const s of sources) {
    if (!s) continue;

    let snap: any = null;

    if (typeof s.snapshot === "function") {
      try {
        snap = s.snapshot();
      } catch {
        snap = null;
      }
    }

    if (!snap && s.selection && typeof s.selection === "object") {
      snap = s.selection;
    }

    if (snap) {
      mergeMap(out, snap);
    }
  }

  return out;
}

function getAuthoredSelection(): string[] {
  const cont = c();
  const auth = cont.features?.authoring || w().__obsAuthoring;

  const raw =
    auth?.getSelectedIds?.() ??
    auth?.selectedIds ??
    auth?.selection ??
    [];

  return Array.from(raw as any)
    .map((x: any) => String(x))
    .filter(Boolean);
}

function boxFromAnyBox(b: any): THREE.Box3 | null {
  if (!b) return null;

  if (b.isBox3) {
    return new THREE.Box3().copy(b);
  }

  if (b.min && b.max) {
    try {
      return new THREE.Box3(
        new THREE.Vector3(b.min.x, b.min.y, b.min.z),
        new THREE.Vector3(b.max.x, b.max.y, b.max.z),
      );
    } catch {
      return null;
    }
  }

  return null;
}

function includeObject(obj: any, box: THREE.Box3): void {
  if (!obj) return;

  if (obj.isMesh) {
    const geo = obj.geometry;

    if (!geo) return;

    if (!geo.boundingBox) {
      try {
        geo.computeBoundingBox();
      } catch {
        return;
      }
    }

    const bb = geo.boundingBox;

    if (bb && !bb.isEmpty()) {
      box.union(bb.clone().applyMatrix4(obj.matrixWorld));
    }

    return;
  }

  if (Array.isArray(obj.children)) {
    for (const child of obj.children) {
      includeObject(child, box);
    }
  }
}

function getAuthoredBox(ids: string[]): THREE.Box3 | null {
  const cont = c();
  const auth = cont.features?.authoring || w().__obsAuthoring;

  if (!auth || !ids.length) return null;

  const elements = auth.getElements?.() ?? auth.elements ?? [];
  const box = new THREE.Box3();

  for (const id of ids) {
    const el = (elements as any[]).find(
      (x: any) => String(x?.id) === id,
    );

    if (!el) continue;

    const candidates = [
      auth.getElementWorldBox?.(el),
      auth.getWorldBox?.(el),
      auth.getBoundingBox?.(el),
      el.worldBox,
      el.box,
      el.boundingBox,
    ];

    let added = false;

    for (const cand of candidates) {
      const b = boxFromAnyBox(cand);

      if (b && !b.isEmpty()) {
        box.union(b);
        added = true;
        break;
      }
    }

    if (!added) {
      includeObject(el.mesh ?? el.three ?? el.object ?? el, box);
    }
  }

  return box.isEmpty() ? null : box;
}

function getFragmentBox(
  frag: Record<string, Set<number>>,
): THREE.Box3 | null {
  const cont = c();
  const scene = cont.world?.scene?.three ?? cont.world?.scene;

  if (!scene || !Object.keys(frag).length) return null;

  try {
    scene.updateMatrixWorld(true);
  } catch {
    /* ignore */
  }

  const lookup = new Map<string, Set<string>>();

  for (const [modelId, ids] of Object.entries(frag)) {
    const set = new Set<string>();

    for (const id of ids) {
      set.add(String(id));
    }

    if (set.size) {
      lookup.set(String(modelId), set);
    }
  }

  const box = new THREE.Box3();

  scene.traverse?.((obj: Any) => {
    const ud = obj?.userData || {};

    const mid = String(
      ud.modelID ??
        ud.modelId ??
        ud.model ??
        ud.fragmentModelID ??
        ud.ownerModelID ??
        "",
    );

    const lid = String(
      ud.expressID ??
        ud.localID ??
        ud.localId ??
        ud.id ??
        ud.elementID ??
        ud.instanceID ??
        "",
    );

    if (!mid || !lid) return;

    const set = lookup.get(mid);

    if (set?.has(lid)) {
      includeObject(obj, box);
    }
  });

  return box.isEmpty() ? null : box;
}

function getCurrentTarget(cam: Any, controls: Any): THREE.Vector3 {
  const t = new THREE.Vector3();

  try {
    if (typeof controls?.getTarget === "function") {
      controls.getTarget(t);

      if (Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.z)) {
        return t;
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    t.copy(cam.position).addScaledVector(dir, 10);
  } catch {
    t.set(0, 0, 0);
  }

  return t;
}

function focusBox(box: THREE.Box3): boolean {
  const cont = c();
  const cam = cont.world?.camera?.three;
  const controls = cont.world?.camera?.controls;

  if (!cam) return false;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.001);

  const target = center.clone();
  const currentTarget = getCurrentTarget(cam, controls);

  const dir = new THREE.Vector3().subVectors(cam.position, currentTarget);

  if (!Number.isFinite(dir.lengthSq()) || dir.lengthSq() < 1e-8) {
    dir.set(0, 0.35, 1);
  }

  dir.normalize();

  let distance: number;

  if (cam.isOrthographicCamera) {
    distance = Math.max(maxDim * 2.5, 1);

    const height = Math.abs(cam.top - cam.bottom);
    const zoom = Math.max(
      0.0001,
      Math.min(100000, height / Math.max(maxDim * 1.35, 0.0001)),
    );

    cam.zoom = zoom;
    cam.updateProjectionMatrix();
  } else {
    const fov = THREE.MathUtils.degToRad(Number(cam.fov) || 50);
    distance = (maxDim / 2) / Math.tan(fov / 2) * 1.75;
    distance = Math.max(distance, maxDim * 0.85);
  }

  const pos = target.clone().addScaledVector(dir, distance);

  try {
    if (typeof controls?.setLookAt === "function") {
      controls.setLookAt(
        pos.x,
        pos.y,
        pos.z,
        target.x,
        target.y,
        target.z,
        true,
      );

      controls.update?.(0);
    } else {
      cam.position.copy(pos);
      cam.lookAt(target);
    }
  } catch {
    cam.position.copy(pos);

    try {
      cam.lookAt(target);
    } catch {
      /* ignore */
    }
  }

  try {
    window.dispatchEvent(new CustomEvent("obs:camera-changed"));
  } catch {
    /* ignore */
  }

  return true;
}

export async function focusSelected(): Promise<boolean> {
  const authIds = getAuthoredSelection();
  const frag = getFragmentSelection();

  const box = new THREE.Box3();

  const ab = authIds.length ? getAuthoredBox(authIds) : null;
  if (ab) box.union(ab);

  const fb = Object.keys(frag).length ? getFragmentBox(frag) : null;
  if (fb) box.union(fb);

  if (box.isEmpty()) {
    return false;
  }

  return focusBox(box);
}

(w() as Any).__obsFocusSelected = focusSelected;
`;

async function writeFocusService() {
  const rel = "src/features/focus-service.ts";
  const full = path.join(root, rel);

  await backup(rel);
  await write(rel, focusService);

  console.log("PATCHED: src/features/focus-service.ts");
}

async function patchContextMenu() {
  const rel = "src/features/context-menu.ts";
  const full = path.join(root, rel);

  if (!(await existsFile(full))) {
    console.log("SKIP: context-menu.ts not found");
    return;
  }

  let src = await read(rel);
  const original = src;

  const rIcons1 = cleanIcons(src);
  src = rIcons1.src;

  const rFocus = patchFocusItems(src);
  src = rFocus.src;

  const rRmb = patchRmbHandler(src);
  src = rRmb.src;

  const rIcons2 = cleanIcons(src);
  src = rIcons2.src;

  if (src !== original) {
    await backup(rel);
    await write(rel, src);
    console.log("PATCHED: src/features/context-menu.ts");
  } else {
    console.log("NO CHANGE: src/features/context-menu.ts");
  }
}

async function patchBootOptional() {
  const rel = "src/critical-gaps-boot.ts";
  const full = path.join(root, rel);

  if (!(await existsFile(full))) {
    console.log("SKIP: critical-gaps-boot.ts not found");
    return;
  }

  let src = await read(rel);

  if (src.includes("focus-service")) {
    console.log("NO CHANGE: src/critical-gaps-boot.ts");
    return;
  }

  const anchor = 'console.log("[critical-gaps-boot] professional input patch ready");';

  if (!src.includes(anchor)) {
    console.log("SKIP: boot anchor not found");
    return;
  }

  const insertion =
    'await safe("focus-service", async () => {\n' +
    '    await import("./features/focus-service");\n' +
    "  });\n\n  " +
    anchor;

  src = src.replace(anchor, insertion);

  await backup(rel);
  await write(rel, src);

  console.log("PATCHED: src/critical-gaps-boot.ts");
}

async function main() {
  console.log("");
  console.log("Running Focus selected-object V4 patch...");
  console.log("");

  await writeFocusService();
  await patchContextMenu();
  await patchBootOptional();

  console.log("");
  console.log("Focus selected-object V4 patch completed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});