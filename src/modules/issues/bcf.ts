/**
 * BCF 2.1 / 3.0 export and import (JSZip).
 *
 * Emits the full Viewpoint schema:
 *   - PerspectiveCamera OR OrthographicCamera (auto-selected from view state)
 *   - CameraUpVector
 *   - Components / Selection / Visibility (IfcGuid-keyed)
 *   - ClippingPlanes
 *   - Snapshot
 *
 * ProjectExtension (project.bcfp) is written when a project is open.
 *
 * Import parses markup.bcf, viewpoint.bcfv (both camera types), Components,
 * and ClippingPlanes. Local fragment IDs are resolved from IfcGuids via a
 * per-model GUID → localId map built lazily and cached.
 */
import JSZip from "jszip";
import * as THREE from "three";
import { ctx } from "../../core/context";
import type {
  ClippingPlaneState,
  Issue,
  IssueComment,
  IssuePriority,
  IssueStatus,
  IssueViewpoint,
} from "./types";
import { getIssues, setIssues } from "./issues";

const xmlEsc = (s: string) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c],
  );
const guid = () =>
  (crypto as any).randomUUID?.() ??
  `g-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const iso = (t: number) => new Date(t || Date.now()).toISOString();
const v = (x: number) => (Number.isFinite(x) ? x.toFixed(6) : "0");

const STATUS_OUT: Record<IssueStatus, string> = {
  open: "Open",
  active: "In Progress",
  resolved: "Resolved",
  closed: "Closed",
};
const PRIORITY_OUT: Record<IssuePriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

function statusIn(s?: string | null): IssueStatus {
  const val = (s ?? "").toLowerCase();
  if (val.includes("progress") || val.includes("active")) return "active";
  if (val.includes("resolv")) return "resolved";
  if (val.includes("clos")) return "closed";
  return "open";
}
function priorityIn(s?: string | null): IssuePriority {
  const val = (s ?? "").toLowerCase();
  if (val.includes("high") || val.includes("critical")) return "high";
  if (val.includes("low")) return "low";
  return "medium";
}

// ── base64 helpers ──
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.split(",")[1] ?? "";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToDataUrl(bytes: Uint8Array, mime = "image/png"): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `data:${mime};base64,${btoa(bin)}`;
}

// ── GUID ↔ localId maps (lazy, per model) ──
const guidCache = new Map<string, Map<number, string>>(); // modelId → (localId → guid)
const guidRevCache = new Map<string, Map<string, number>>(); // modelId → (guid → localId)

async function buildGuidMap(modelId: string): Promise<Map<number, string>> {
  if (guidCache.has(modelId)) return guidCache.get(modelId)!;
  const out = new Map<number, string>();
  const model = ctx.fragments.list.get(modelId);
  if (!model) {
    guidCache.set(modelId, out);
    guidRevCache.set(modelId, new Map());
    return out;
  }
  try {
    const ids = (await (model as any).getItemsIdsWithGeometry()) as number[];
    if (ids?.length) {
      // Batch read GlobalId / Tag
      const data = await (model as any).getItemsData(ids, {
        attributesDefault: false,
        attributes: ["GlobalId", "Tag"],
      });
      for (let i = 0; i < ids.length; i++) {
        const g =
          (data as any)?.[i]?.GlobalId?.value ?? (data as any)?.[i]?.Tag?.value;
        if (typeof g === "string" && g.length) out.set(ids[i], g);
      }
    }
  } catch {
    /* */
  }
  const rev = new Map<string, number>();
  for (const [id, g] of out) rev.set(g, id);
  guidCache.set(modelId, out);
  guidRevCache.set(modelId, rev);
  return out;
}

async function resolveGuids(
  map: Record<string, number[]> | undefined,
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  if (!map) return out;
  for (const [modelId, ids] of Object.entries(map)) {
    const gm = await buildGuidMap(modelId);
    const guids: string[] = [];
    for (const id of ids) {
      const g = gm.get(id);
      if (g) guids.push(g);
    }
    if (guids.length) out[modelId] = guids;
  }
  return out;
}

function guidToLocal(modelId: string, guids: string[]): number[] {
  const rev = guidRevCache.get(modelId);
  if (!rev) return [];
  const out: number[] = [];
  for (const g of guids) {
    const local = rev.get(g);
    if (typeof local === "number") out.push(local);
  }
  return out;
}

// ── XML: viewpoint ──
function viewpointXml(vp: IssueViewpoint, vpGuid: string): string {
  const pos = new THREE.Vector3(...vp.cam);
  const tgt = new THREE.Vector3(...vp.target);
  const dir = new THREE.Vector3().subVectors(tgt, pos).normalize();
  const up = vp.up
    ? new THREE.Vector3(...vp.up).normalize()
    : new THREE.Vector3(0, 1, 0);
  const dist = pos.distanceTo(tgt);

  const cameraXml =
    vp.projection === "orthographic"
      ? `<OrthographicCamera>
<CameraViewPoint><X>${v(pos.x)}</X><Y>${v(pos.y)}</Y><Z>${v(pos.z)}</Z></CameraViewPoint>
<CameraDirection><X>${v(dir.x)}</X><Y>${v(dir.y)}</Y><Z>${v(dir.z)}</Z></CameraDirection>
<CameraUpVector><X>${v(up.x)}</X><Y>${v(up.y)}</Y><Z>${v(up.z)}</Z></CameraUpVector>
<ViewToWorldScale>${v(vp.orthoScale ?? dist)}</ViewToWorldScale>
</OrthographicCamera>`
      : `<PerspectiveCamera>
<CameraViewPoint><X>${v(pos.x)}</X><Y>${v(pos.y)}</Y><Z>${v(pos.z)}</Z></CameraViewPoint>
<CameraDirection><X>${v(dir.x)}</X><Y>${v(dir.y)}</Y><Z>${v(dir.z)}</Z></CameraDirection>
<CameraUpVector><X>${v(up.x)}</X><Y>${v(up.y)}</Y><Z>${v(up.z)}</Z></CameraUpVector>
<FieldOfView>60</FieldOfView>
<TargetDistance>${v(dist)}</TargetDistance>
</PerspectiveCamera>`;

  // Components / Selection — GUIDs filled by caller before serialization.
  const componentsXml = (vp as any)._bcfComponentsXml ?? "";

  const clippingXml =
    vp.clippingPlanes?.length
      ? `<ClippingPlanes>${vp.clippingPlanes
          .map(
            (p) =>
              `<ClippingPlane><Location><X>${v(p.location[0])}</X><Y>${v(
                p.location[1],
              )}</Y><Z>${v(p.location[2])}</Z></Location><Direction><X>${v(
                p.direction[0],
              )}</X><Y>${v(p.direction[1])}</Y><Z>${v(
                p.direction[2],
              )}</Z></Direction></ClippingPlane>`,
          )
          .join("")}</ClippingPlanes>`
      : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<VisualizationInfo Guid="${vpGuid}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
${cameraXml}
${clippingXml}
${componentsXml}
<Snapshot><SnapshotType>png</SnapshotType></Snapshot>
</VisualizationInfo>`;
}

// ── Export ──
export async function exportBCF(
  issueList: Issue[] = getIssues(),
  fileName?: string,
) {
  if (!issueList.length) {
    alert("No issues to export.");
    return;
  }
  const zip = new JSZip();
  zip.file(
    "bcf.version",
    `<?xml version="1.0" encoding="UTF-8"?>
<Version VersionId="2.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>`,
  );

  // Project extension (optional but improves compatibility)
  try {
    const { getCurrentProject } = await import("../projects/projects");
    const proj = getCurrentProject();
    if (proj) {
      zip.file(
        "project.bcfp",
        `<?xml version="1.0" encoding="UTF-8"?>
<ProjectExtension Guid="${proj.id}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Project ProjectId="${xmlEsc(proj.id)}"/>
  <ExtensionSchema>OpenBIMStudio-BCF-3.0</ExtensionSchema>
</ProjectExtension>`,
      );
    }
  } catch {
    /* */
  }

  for (const issue of issueList) {
    const folder = zip.folder(issue.id)!;
    const vpGuid = guid();

    // Prepare selection GUIDs for the viewpoint
    const selectionGuids = await resolveGuids(issue.viewpoint.selection);
    let componentsXml = "";
    if (Object.keys(selectionGuids).length) {
      const allGuids: string[] = [];
      for (const arr of Object.values(selectionGuids)) for (const g of arr) allGuids.push(g);
      if (allGuids.length) {
        componentsXml =
          `<Components><Selection>` +
          allGuids
            .map((g) => `<Component IfcGuid="${xmlEsc(g)}"/>`)
            .join("") +
          `</Selection><Visibility DefaultVisibility="true"/></Components>`;
      }
    }
    (issue.viewpoint as any)._bcfComponentsXml = componentsXml;

    // markup.bcf (Topic + Comments)
    const prioAttr = ` Priority="${PRIORITY_OUT[issue.priority] ?? "Medium"}"`;
    const assigneeAttr = issue.assignee
      ? ` AssignedTo="${xmlEsc(issue.assignee)}"`
      : "";
    const dueAttr = issue.dueDate
      ? ` DueDate="${iso(issue.dueDate)}"`
      : "";

    let markup = `<?xml version="1.0" encoding="UTF-8"?>
<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Topic Guid="${issue.id}" TopicType="Issue" TopicStatus="${xmlEsc(
      STATUS_OUT[issue.status] ?? issue.status,
    )}"${prioAttr}${assigneeAttr}${dueAttr} Title="${xmlEsc(
      issue.title,
    )}" CreationDate="${iso(issue.createdAt)}" ModifiedDate="${iso(
      issue.updatedAt,
    )}" Author="${xmlEsc(issue.author)}">
<DescriptionText>${xmlEsc(issue.description ?? "")}</DescriptionText>
</Topic>
`;
    for (const c of issue.comments) {
      markup += `<Comment Guid="${c.id}" Date="${iso(c.date)}" Author="${xmlEsc(
        c.author,
      )}"><Text>${xmlEsc(c.text)}</Text></Comment>\n`;
    }
    markup += `</Markup>`;
    folder.file("markup.bcf", markup);

    // viewpoint.bcfv
    folder.file("viewpoint.bcfv", viewpointXml(issue.viewpoint, vpGuid));

    // snapshot.png
    if (issue.viewpoint.thumbnail) {
      folder.file("snapshot.png", dataUrlToBytes(issue.viewpoint.thumbnail));
    }
    delete (issue.viewpoint as any)._bcfComponentsXml;
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName ?? "open-bim-studio-issues.bcfzip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ── Import ──
function parseVec(el: Element | null, tag: string): THREE.Vector3 {
  const t = el?.querySelector(tag);
  return new THREE.Vector3(
    parseFloat(t?.querySelector("X")?.textContent ?? "0"),
    parseFloat(t?.querySelector("Y")?.textContent ?? "0"),
    parseFloat(t?.querySelector("Z")?.textContent ?? "0"),
  );
}

function parseComponents(
  vis: Element | null,
): { selection: Record<string, string[]>; hidden: Record<string, string[]> } {
  const selection: Record<string, string[]> = {};
  const hidden: Record<string, string[]> = {};
  if (!vis) return { selection, hidden };

  const readGuids = (root: Element | null): string[] => {
    if (!root) return [];
    return Array.from(root.querySelectorAll("Component"))
      .map((c) => c.getAttribute("IfcGuid") ?? "")
      .filter(Boolean);
  };

  const selComp = vis.querySelector("Components > Selection");
  if (selComp) {
    // All guids go into a synthetic bucket — we resolve them to models below.
    selection["__bcf__"] = readGuids(selComp);
  }
  const visRoot = vis.querySelector("Components > Visibility");
  if (visRoot) {
    const def = visRoot.getAttribute("DefaultVisibility");
    if (def === "true") {
      // Exceptions = hidden
      hidden["__bcf__"] = readGuids(visRoot.querySelector("Exceptions"));
    } else {
      // Exceptions = visible (isolated) — treat as selection
      const visIds = readGuids(visRoot.querySelector("Exceptions"));
      if (visIds.length && !selection["__bcf__"]) selection["__bcf__"] = visIds;
    }
  }
  return { selection, hidden };
}

/**
 * Resolve a flat list of GUIDs to per-model localIds by scanning every loaded
 * model's GUID map. Populates the caches as a side effect.
 */
async function resolveGuidsToModels(
  guids: string[],
): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {};
  if (!guids.length) return out;
  const remaining = new Set(guids);

  for (const [modelId] of ctx.fragments.list) {
    const gm = await buildGuidMap(modelId);
    const rev = guidRevCache.get(modelId)!;
    const locals: number[] = [];
    for (const g of Array.from(remaining)) {
      const id = rev.get(g);
      if (typeof id === "number") {
        locals.push(id);
        remaining.delete(g);
      }
    }
    if (locals.length) out[modelId] = locals;
    if (!remaining.size) break;
  }
  return out;
}

export async function importBCF(file: File): Promise<number> {
  const zip = await JSZip.loadAsync(file);
  const imported: Issue[] = [];
  const existing = new Set(getIssues().map((i) => i.id));

  const markupPaths: string[] = [];
  zip.forEach((path) => {
    if (/markup\.bcf$/i.test(path)) markupPaths.push(path);
  });
  if (!markupPaths.length) {
    alert("No markup.bcf found in this BCF file.");
    return 0;
  }

  for (const path of markupPaths) {
    const folder = path.split("/")[0];
    try {
      const markupXml = await zip.file(path)!.async("string");
      const doc = new DOMParser().parseFromString(markupXml, "text/xml");
      const topic = doc.querySelector("Topic");
      if (!topic) continue;

      let id = topic.getAttribute("Guid") || folder;
      while (existing.has(id)) id = guid();
      existing.add(id);

      // ── Viewpoint ──
      let viewpoint: IssueViewpoint = {
        cam: [0, 10, 10],
        target: [0, 0, 0],
        projection: "perspective",
      };
      const vpFile = zip.file(`${folder}/viewpoint.bcfv`);
      if (vpFile) {
        const vdoc = new DOMParser().parseFromString(
          await vpFile.async("string"),
          "text/xml",
        );
        const vis = vdoc.querySelector("VisualizationInfo");

        const persp = vis?.querySelector("PerspectiveCamera");
        const ortho = vis?.querySelector("OrthographicCamera");
        const camEl = persp ?? ortho;
        if (camEl) {
          const pos = parseVec(camEl, "CameraViewPoint");
          const dir = parseVec(camEl, "CameraDirection").normalize();
          const up = parseVec(camEl, "CameraUpVector");
          const distRaw = camEl.querySelector("TargetDistance")?.textContent;
          const scaleRaw = camEl.querySelector("ViewToWorldScale")?.textContent;
          const dist = Math.max(
            parseFloat(distRaw ?? scaleRaw ?? "10") || 10,
            0.5,
          );
          const tgt = pos.clone().add(dir.multiplyScalar(dist));
          viewpoint = {
            cam: [pos.x, pos.y, pos.z],
            target: [tgt.x, tgt.y, tgt.z],
            up: [up.x || 0, up.y || 1, up.z || 0],
            projection: ortho ? "orthographic" : "perspective",
          };
          if (ortho && scaleRaw) {
            viewpoint.orthoScale = Math.max(parseFloat(scaleRaw) || dist, 0.001);
          }
        }

        // Components
        const { selection, hidden } = parseComponents(vis);
        const selGuids = selection["__bcf__"] ?? [];
        const hidGuids = hidden["__bcf__"] ?? [];
        if (selGuids.length) {
          const resolved = await resolveGuidsToModels(selGuids);
          if (Object.keys(resolved).length) viewpoint.selection = resolved;
        }
        if (hidGuids.length) {
          const resolved = await resolveGuidsToModels(hidGuids);
          if (Object.keys(resolved).length) viewpoint.hidden = resolved;
        }

        // Clipping planes
        const planeEls = Array.from(
          vis?.querySelectorAll("ClippingPlanes > ClippingPlane") ?? [],
        );
        if (planeEls.length) {
          const planes: ClippingPlaneState[] = [];
          for (const p of planeEls) {
            const loc = parseVec(p, "Location");
            const dir = parseVec(p, "Direction").normalize();
            planes.push({
              location: [loc.x, loc.y, loc.z],
              direction: [dir.x, dir.y, dir.z],
            });
          }
          viewpoint.clippingPlanes = planes;
        }
      }

      const snapFile = zip.file(`${folder}/snapshot.png`);
      if (snapFile) {
        viewpoint.thumbnail = bytesToDataUrl(await snapFile.async("uint8array"));
      }

      // ── Comments ──
      const comments: IssueComment[] = [];
      for (const ce of Array.from(doc.querySelectorAll("Comment"))) {
        comments.push({
          id: ce.getAttribute("Guid") || guid(),
          author: ce.getAttribute("Author") || "Unknown",
          date: Date.parse(ce.getAttribute("Date") ?? "") || Date.now(),
          text: ce.querySelector("Text")?.textContent ?? "",
        });
      }

      imported.push({
        id,
        title: topic.getAttribute("Title") || "Imported issue",
        description: doc.querySelector("DescriptionText")?.textContent ?? "",
        status: statusIn(topic.getAttribute("TopicStatus")),
        priority: priorityIn(topic.getAttribute("Priority")),
        author: topic.getAttribute("Author") || "Imported",
        assignee: topic.getAttribute("AssignedTo") || undefined,
        dueDate: Date.parse(topic.getAttribute("DueDate") ?? "") || undefined,
        createdAt: Date.parse(topic.getAttribute("CreationDate") ?? "") || Date.now(),
        updatedAt: Date.parse(topic.getAttribute("ModifiedDate") ?? "") || Date.now(),
        viewpoint,
        comments,
      });
    } catch (e) {
      console.warn("[bcf] failed to import topic folder:", folder, e);
    }
  }

  if (imported.length) setIssues([...imported, ...getIssues()]);
  return imported.length;
}

export function setupBcf() {
  ctx.features.bcf = { exportBCF, importBCF };
}