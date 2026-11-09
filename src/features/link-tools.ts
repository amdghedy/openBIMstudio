/**
 * Insert / Link tools — professional federation & import helpers.
 *
 * Activates every Insert-tab action with stable, production behaviour:
 * Link IFC, Link drawing, Link BIM, Point cloud, Topography, Family, Library.
 */
import { pickFiles, loadIfcFiles, loadFragFiles } from "./importer";
import { pickAndImport, importFiles } from "./file-interop";


// DWG conversion using libredwg-web for full geometry support
// Dynamic import to avoid loading if not needed



import { togglePlanView } from "./plan-view-panel";
import { toggleSheetsPanel } from "./sheets-panel";
import { ensureDefaultMaterials, listMaterials } from "../modules/materials/materials";
import { markDirty } from "../modules/projects/projects";
import { openToolWindow } from "./tool-windows";
import { uiAlert } from "../core/notify";
import { confirmDialog } from "./form-modal";
import { fmtNumber } from "../core/region";

function pickAccept(accept: string, multiple: boolean, onFiles: (files: File[]) => void | Promise<void>) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.multiple = multiple;
  input.onchange = () => {
    const files = input.files ? Array.from(input.files) : [];
    if (files.length) void Promise.resolve(onFiles(files)).catch((e) => {
      console.error("[link-tools]", e);
      uiAlert(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  input.click();
}

function toast(msg: string, kind: "info" | "warn" | "success" = "info", _ms = 2400) {
  // Prefer ribbon toast if available
  try {
    const ev = new CustomEvent("obs-toast", { detail: { message: msg, kind } });
    window.dispatchEvent(ev);
  } catch { /* */ }
  console.log(`[link] ${kind}: ${msg}`);
}

/**
 * Federate additional IFC models (Link IFC).
 * Sequence taken from working Old OpenBIMStudio:
 *   pick → loadIfcFiles → queue convert → core.load (no offset when recenter OFF)
 *   → apply positioning / alignOriginToOrigin → fitAll
 * Same as BIM: origin-to-origin links stay coordinated.
 */
export function linkIfc() {
  // Reveal the importer queue so the user can see progress and failures.
  openToolWindow("import");
  // Use a dedicated picker and enqueue directly into the visible IFC task queue.
  // This avoids the universal import router and makes each selected model observable.
  pickAccept(".ifc,.ifczip,application/x-step,application/octet-stream", true, async (selected) => {
    const ifcFiles: File[] = [];

    for (const file of selected) {
      if (/\.ifc$/i.test(file.name)) {
        ifcFiles.push(file);
        continue;
      }

      if (/\.ifczip$/i.test(file.name) || /\.zip$/i.test(file.name)) {
        try {
          toast(`Unpacking ${file.name} (${(file.size / (1024 * 1024)).toFixed(0)} MB)…`, "info");
          const JSZip = (await import("jszip")).default;
          const archive = await JSZip.loadAsync(file, { createFolders: false });
          const entries: string[] = [];
          archive.forEach((path, entry) => {
            if (!entry.dir && /\.ifc$/i.test(path)) entries.push(path);
          });

          if (!entries.length) {
            throw new Error(`No IFC model was found inside "${file.name}".`);
          }
          entries.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));

          for (const path of entries) {
            const entry = archive.file(path);
            if (!entry) continue;
            const bytes = await entry.async("uint8array");
            if (!bytes.byteLength) {
              console.warn(`[link-ifc] empty entry ${path}`);
              continue;
            }
            const name = path.split("/").pop() || `${file.name}.ifc`;
            const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
            ifcFiles.push(new File([blob], name, { type: "application/octet-stream" }));
          }
          if (!ifcFiles.length) {
            throw new Error(`All IFC entries inside "${file.name}" were empty.`);
          }
        } catch (err: any) {
          toast(err?.message || String(err), "warn");
          throw err;
        }
        continue;
      }

      throw new Error(`Unsupported file type: ${file.name}`);
    }

    if (!ifcFiles.length) {
      toast("No IFC models were selected.", "warn");
      return;
    }

    // enqueueIfc() runs synchronously inside loadIfcFiles(), creating queue rows immediately.
    loadIfcFiles(ifcFiles);
    toast(`Queued ${ifcFiles.length} IFC model(s) for linking…`, "success");
  });
}

/** Link / load pre-converted FRAG (old FRAG linker path). */
export function linkFrag() {
  pickFiles(".frag", true, (files) => {
    const list = Array.from(files as FileList | File[]);
    void loadFragFiles(list);
    toast(`Loading ${list.length} FRAG model(s) — coordinates preserved…`, "info");
  });
}

/**
 * Link drawing underlay / reference.
 * - DXF/SVG/images → open Plan view and prompt underlay workflow
 * - Also accepts OBJ/GLB as 3D model reference via universal importer
 */
export function linkCad() {
  pickAccept(".dxf,.dwg,.svg,.png,.jpg,.jpeg,.webp,.gif,.pdf,.obj,.glb,.gltf", true, async (files) => {
    const file = files[0];
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();

    if (ext === "dwg" || ext === "dxf") {
      const m = await import("../modules/cad-link");
      m.setupCadLinks();
      await m.linkCadFilesBatch(files.filter((f) => ["dwg", "dxf"].includes((f.name.split(".").pop() ?? "").toLowerCase())));
      return;
    }

    if (["svg", "png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
      // Open plan view — user clicks Link drawing there, or we stash file for plan
      try {
        (window as any).__obsPendingCadFile = file;
      } catch { /* */ }
      togglePlanView();
      toast(
        `CAD file ready: ${file.name}. In Plan view click “Link drawing” or the underlay will attach if auto-linked.`,
        "success",
      );
      // Try auto-link into plan if handler exists
      try {
        const auto = (window as any).__obsAutoLinkCad;
        if (typeof auto === "function") await auto(file);
      } catch (e) {
        console.warn("[link-cad] auto underlay", e);
      }
      return;
    }

    // 3D model references
    await importFiles(files);
    markDirty();
    toast(`Linked CAD reference: ${file.name}`, "success");
  });
}

/** Link BIM models via IFC export guidance + IFC picker. */
export async function linkBIM() {
  const go = await confirmDialog(
    "Link BIM model",
    "BIM files (.rvt) cannot open directly in the browser.\n\n" +
    "Professional workflow:\n" +
    "1. In BIM: File → Export → IFC\n" +
    "2. Use IFC 2x3 or IFC4 Coordination View\n" +
    "3. Click OK to pick the exported .ifc now\n\n" +
    "Cancel to dismiss.",
  );
  if (!go) return;
  // Same sequence as Link IFC (old OpenBIMStudio path)
  linkIfc();
}

/**
 * Scan / Point cloud → BIM.
 * RWCX/RWP files open the Trimble conversion assistant; converted LAS/PTX/PTS
 * files are passed through the same validated point-cloud import pipeline.
 */
export function linkPointCloud() {
  pickAccept(
    ".las,.ptx,.ply,.xyz,.pts,.txt,.csv,.pcd,.laz,.e57,.rcp,.rcs,.rwcx,.rwp,.fls,.fws,.lsproj,.zfs,.cpe,.imp,.pod",
    true,
    async (files) => {
      const trimbleSources = files.filter((file) => {
        const ext = (file.name.split(".").pop() ?? "").toLowerCase();
        return ext === "rwcx" || ext === "rwp";
      });
      const directFiles = files.filter((file) => !trimbleSources.includes(file));
      if (directFiles.length) await importPointCloudFiles(directFiles);
      if (trimbleSources.length) {
        const { showTrimbleImportAssistant } = await import("../modules/point-cloud/trimble-import-assistant");
        await showTrimbleImportAssistant(trimbleSources, importPointCloudFiles);
      }
    },
  );
}

/** Import formats that the browser pipeline currently decodes and validates. */
async function importPointCloudFiles(files: File[]) {
  const { UNSUPPORTED_POINT_CLOUD, parseLas, parsePtx } = await import("../modules/point-cloud/parsers");
  let loaded = 0;
  const unsupported: string[] = [];
  for (const file of files) {
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    const bad = UNSUPPORTED_POINT_CLOUD[ext];
    if (bad) { unsupported.push(`- ${file.name}  (${bad.name})\n  ${bad.how}`); continue; }
    try {
      if (ext === "las" || ext === "ptx") {
        const parsed = ext === "las" ? parseLas(await file.arrayBuffer(), 2_000_000) : parsePtx(await file.text(), 2_000_000);
        const far = parsed.origin.some((v) => Math.abs(v) > 5000);
        // Survey coordinates (UTM etc.) are far from the model origin: offer to bring the cloud to the origin.
        const recentre = far && await confirmDialog(
          "Survey coordinates",
          `${file.name} uses survey coordinates (centre ${parsed.origin.map((v) => v.toFixed(0)).join(", ")}).\n\n` +
          "OK = move the cloud to the model origin (recommended)\nCancel = keep the survey coordinates (the model must use the same coordinates)",
        );
        await addPointsToScene(file.name, parsed.positions, parsed.colors, parsed.kept > 500_000 ? 0.03 : 0.05, far && !recentre ? parsed.origin : [0, 0, 0]);
        toast(`${file.name}: ${parsed.info}, ${fmtNumber(parsed.kept)} of ${fmtNumber(parsed.total)} points`, "success");
      } else if (["xyz", "pts", "txt", "csv", "pcd"].includes(ext)) {
        await loadAsciiPointCloud(file);
      } else if (ext === "ply") {
        await loadPlyAsPoints(file);
      } else {
        unsupported.push(`- ${file.name}  (Unsupported point-cloud format)\n  This format is not decoded by the current browser importer.`);
        continue;
      }
      loaded++;
    } catch (e) {
      console.error(e);
      uiAlert(`Could not load point cloud “${file.name}”: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (unsupported.length) {
    uiAlert(
      "These point-cloud formats are not decoded by the current browser importer:\n\n" +
      unsupported.join("\n\n") +
      "\n\nCurrently decoded: LAS (uncompressed), PTX, PLY, XYZ, PTS, TXT and CSV. " +
      "PCD support is currently limited to ASCII data.",
    );
  }
  if (loaded > 0) toast(`${loaded} scan(s) in scene — use Architecture tools to model over the cloud (Scan-to-BIM)`, "info", 4500);
}

async function addPointsToScene(
  name: string,
  positions: number[] | Float32Array,
  colors: number[] | Float32Array | null,
  pointSize = 0.04,
  position: [number, number, number] = [0, 0, 0],
) {
  const count = positions.length / 3;
  if (count < 10) throw new Error("No valid points found in file.");

  const THREE = await import("three");
  const { ctx } = await import("../core/context");
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (colors) geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.computeBoundingSphere();
  const mat = new THREE.PointsMaterial({
    size: pointSize,
    vertexColors: !!colors,
    color: colors ? 0xffffff : 0x9aa7b8,
    sizeAttenuation: true,
  });
  const pts = new THREE.Points(geo, mat);
  pts.name = name;
  pts.position.set(position[0], position[1], position[2]);
  pts.userData.isPointCloud = true;
  pts.userData.pointCount = count;
  pts.userData.scanToBim = true;
  ctx.world.scene.three.add(pts);
  markDirty();
  try {
    const { computeSceneBounds, fitAll } = await import("./camera-tools");
    computeSceneBounds();
    fitAll();
  } catch { /* */ }
  return count;
}

/** XYZ / PTS / TXT / PCD (ASCII) with optional RGB and auto subsample. */
async function loadAsciiPointCloud(file: File) {
  const text = await file.text();
  const lines = text.split(/\r?\n/);
  const positions: number[] = [];
  const colors: number[] = [];
  let count = 0;
  const maxPoints = 1_500_000;
  // Uniform subsample if file is huge (estimate from line count)
  const step = lines.length > maxPoints * 1.2
    ? Math.ceil(lines.length / maxPoints)
    : 1;
  let lineIdx = 0;

  for (const line of lines) {
    lineIdx++;
    if (lineIdx % step !== 0) continue;
    if (count >= maxPoints) break;
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("//") || t.startsWith("VERSION") ||
        t.startsWith("FIELDS") || t.startsWith("SIZE") || t.startsWith("TYPE") ||
        t.startsWith("COUNT") || t.startsWith("WIDTH") || t.startsWith("HEIGHT") ||
        t.startsWith("VIEWPOINT") || t.startsWith("POINTS") || t.startsWith("DATA")) {
      continue;
    }
    const parts = t.split(/[\s,;]+/).map(Number);
    if (parts.length < 3 || !isFinite(parts[0]) || !isFinite(parts[1]) || !isFinite(parts[2])) {
      continue;
    }
    // Store as X, Y-up, Z (swap Y/Z from many survey XYZ files: X Y Z → X Z Y)
    const x = parts[0];
    const ySurvey = parts[1];
    const zSurvey = parts[2];
    // Heuristic: if |Y| >> |Z| treat as Y-up already; else survey Z-up → Three Y-up
    const yUp = Math.abs(ySurvey) > Math.abs(zSurvey) * 3
      ? ySurvey
      : zSurvey;
    const zOut = Math.abs(ySurvey) > Math.abs(zSurvey) * 3
      ? zSurvey
      : ySurvey;
    positions.push(x, yUp, zOut);

    if (parts.length >= 6) {
      const r = parts[3], g = parts[4], b = parts[5];
      const scale = r > 1.5 || g > 1.5 || b > 1.5 ? 1 / 255 : 1;
      colors.push(r * scale, g * scale, b * scale);
    } else {
      colors.push(0.55, 0.62, 0.72);
    }
    count++;
  }

  await addPointsToScene(file.name, positions, colors, count > 500_000 ? 0.03 : 0.05);
}

/** PLY as true point cloud (vertices only) for Scan-to-BIM. */
async function loadPlyAsPoints(file: File) {
  const buf = await file.arrayBuffer();
  const THREE = await import("three");
  const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
  const geo = new PLYLoader().parse(buf);
  const posAttr = geo.getAttribute("position");
  if (!posAttr || posAttr.count < 10) {
    // Fallback: mesh import
    await importFiles([file]);
    return;
  }

  const maxPoints = 1_500_000;
  const total = posAttr.count;
  const step = total > maxPoints ? Math.ceil(total / maxPoints) : 1;
  const positions: number[] = [];
  const colors: number[] = [];
  const colAttr = geo.getAttribute("color");

  for (let i = 0; i < total; i += step) {
    positions.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
    if (colAttr) {
      colors.push(colAttr.getX(i), colAttr.getY(i), colAttr.getZ(i));
    } else {
      colors.push(0.55, 0.62, 0.72);
    }
  }

  await addPointsToScene(file.name, positions, colors, total > 500_000 ? 0.03 : 0.05);
}

/** Topography / mesh site model. */
export function linkTopography() {
  pickAccept(".obj,.stl,.ply,.glb,.gltf,.tif,.tiff,.png", true, async (files) => {
    const file = files[0];
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    if (["tif", "tiff", "png"].includes(ext)) {
      uiAlert(
        "Raster DEM / contour images:\n" +
        "Convert to mesh (OBJ/STL) in Civil 3D, QGIS or Blender, then link again.\n\n" +
        "For 2D site plans use Link drawing with DXF/PNG in Plan view.",
      );
      return;
    }
    await importFiles(files);
    toast(`Topography / site mesh linked: ${file.name}`, "success");
  });
}

/** Family / type library — open materials + types foundation. */
export function openFamilyLibrary() {
  ensureDefaultMaterials();
  const mats = listMaterials();
  const names = mats.slice(0, 12).map((m) => `• ${m.name}`).join("\n");
  uiAlert(
    "Element Types & Materials library\n\n" +
    `${mats.length} materials loaded:\n${names}\n\n` +
    "Use Architecture / Structure / Mechanical tools to place elements.\n" +
    "Type parameters and shared parameters are available on the project document.\n" +
    "Sheets → Manage for production documentation.",
  );
  toast("Materials library ready", "info");
}

/** Component library shortcut. */
export function openComponentLibrary() {
  openFamilyLibrary();
  try { toggleSheetsPanel(); } catch { /* */ }
}

/** Autodesk format bridge. */
export async function linkAutodesk() {
  const go = await confirmDialog(
    "Autodesk formats (RVT, RFA, NWD, DWG)",
    "Browser cannot open proprietary Autodesk binaries.\n\n" +
    "Recommended open workflow:\n" +
    "• BIM → Export IFC → Link IFC here\n" +
    "• Navisworks → Export IFC or exchange via BCF\n" +
    "• desktop drafting application → DXF / IFC → Link drawing or Link IFC\n\n" +
    "OK = pick an IFC / FRAG / model file now.",
  );
  if (go) pickAndImport();
}

export function setupLinkTools() {
  // no-op registry; functions are called from ribbon
}
