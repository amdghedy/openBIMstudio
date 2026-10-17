import * as THREE from "three";
import { familyStore } from "../modules/families/store";
import type { FamilyDefinition } from "../modules/families/types";

let dialog: HTMLDivElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let previewCanvas: HTMLCanvasElement | null = null;
let drawMode: "rect" | "circle" = "rect";
let startPt: { x: number; y: number } | null = null;
let currentShape: { type: "rect" | "circle"; x: number; y: number; w: number; h: number } | null = null;

const SCALE = 100;

export function openFamilyEditor() {
  if (!dialog) buildDialog();
  if (dialog) dialog.style.display = "flex";
}

export function closeFamilyEditor() {
  if (dialog) dialog.style.display = "none";
}

function buildDialog() {
  dialog = document.createElement("div");
  dialog.style.cssText = `position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;`;
  dialog.onclick = (e) => { if (e.target === dialog) closeFamilyEditor(); };

  const card = document.createElement("div");
  card.style.cssText = `width:900px;height:640px;background:#1e293b;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;border:1px solid #334155;`;

  const header = document.createElement("div");
  header.style.cssText = "padding:12px 16px;border-bottom:1px solid #334155;display:flex;gap:8px;align-items:center;";
  header.innerHTML = `<h2 style="margin:0;font-size:16px;flex:1;color:#e2e8f0">Family Editor — Sketch Profile</h2>`;

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "💾 Save Family";
  saveBtn.style.cssText = "background:#16a34a;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-weight:600;";
  saveBtn.onclick = saveFamily;

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  closeBtn.style.cssText = "background:transparent;color:#94a3b8;border:1px solid #334155;border-radius:4px;padding:4px 10px;cursor:pointer;";
  closeBtn.onclick = closeFamilyEditor;

  header.append(saveBtn, closeBtn);

  const body = document.createElement("div");
  body.style.cssText = "flex:1;display:flex;gap:12px;padding:12px;overflow:hidden;";

  const canvasWrap = document.createElement("div");
  canvasWrap.style.cssText = "flex:1;background:#f8fafc;border-radius:8px;position:relative;overflow:hidden;";
  canvas = document.createElement("canvas");
  canvas.width = 500;
  canvas.height = 500;
  canvas.style.cssText = "width:100%;height:100%;cursor:crosshair;";
  canvasWrap.appendChild(canvas);

  const previewWrap = document.createElement("div");
  previewWrap.style.cssText = "width:320px;background:#0f172a;border-radius:8px;";
  previewCanvas = document.createElement("canvas");
  previewCanvas.width = 320;
  previewCanvas.height = 500;
  previewCanvas.style.cssText = "width:100%;height:100%;";
  previewWrap.appendChild(previewCanvas);

  body.append(canvasWrap, previewWrap);

  const toolbar = document.createElement("div");
  toolbar.style.cssText = "padding:8px 16px;border-top:1px solid #334155;display:flex;gap:8px;";
  toolbar.innerHTML = `
    <button data-tool="rect" style="background:#2563eb;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;">▭ Rectangle</button>
    <button data-tool="circle" style="background:#334155;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;">○ Circle</button>
    <button id="clear-btn" style="margin-left:auto;background:#dc2626;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;">Clear</button>
  `;

  card.append(header, body, toolbar);
  dialog.appendChild(card);
  document.body.appendChild(dialog);

  wireCanvas();
  wireToolbar(toolbar);
}

function wireCanvas() {
  if (!canvas) return;
  const ctx2d = canvas.getContext("2d")!;

  function redraw() {
    ctx2d.fillStyle = "#f8fafc";
    ctx2d.fillRect(0, 0, canvas!.width, canvas!.height);

    ctx2d.strokeStyle = "#e2e8f0";
    ctx2d.lineWidth = 1;
    for (let x = 0; x < canvas!.width; x += SCALE) {
      ctx2d.beginPath(); ctx2d.moveTo(x, 0); ctx2d.lineTo(x, canvas!.height); ctx2d.stroke();
    }
    for (let y = 0; y < canvas!.height; y += SCALE) {
      ctx2d.beginPath(); ctx2d.moveTo(0, y); ctx2d.lineTo(canvas!.width, y); ctx2d.stroke();
    }

    ctx2d.strokeStyle = "#94a3b8";
    ctx2d.beginPath();
    ctx2d.moveTo(canvas!.width / 2, 0); ctx2d.lineTo(canvas!.width / 2, canvas!.height);
    ctx2d.moveTo(0, canvas!.height / 2); ctx2d.lineTo(canvas!.width, canvas!.height / 2);
    ctx2d.stroke();

    if (currentShape) {
      ctx2d.strokeStyle = "#2563eb";
      ctx2d.fillStyle = "rgba(37,99,235,0.15)";
      ctx2d.lineWidth = 2;
      if (currentShape.type === "rect") {
        ctx2d.beginPath();
        ctx2d.rect(currentShape.x, currentShape.y, currentShape.w, currentShape.h);
        ctx2d.fill(); ctx2d.stroke();
      } else {
        const cx = currentShape.x + currentShape.w / 2;
        const cy = currentShape.y + currentShape.h / 2;
        const r = Math.min(Math.abs(currentShape.w), Math.abs(currentShape.h)) / 2;
        ctx2d.beginPath();
        ctx2d.arc(cx, cy, r, 0, Math.PI * 2);
        ctx2d.fill(); ctx2d.stroke();
      }
    }
  }

  canvas.addEventListener("mousedown", (e) => {
    const rect = canvas!.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas!.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas!.height / rect.height);
    startPt = { x, y };
    currentShape = { type: drawMode, x, y, w: 0, h: 0 };
    redraw();
  });

  canvas.addEventListener("mousemove", (e) => {
    if (!startPt || !currentShape) return;
    const rect = canvas!.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas!.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas!.height / rect.height);
    currentShape.w = x - startPt.x;
    currentShape.h = y - startPt.y;
    redraw();
    renderPreview();
  });

  canvas.addEventListener("mouseup", () => {
    if (currentShape) {
      if (currentShape.w < 0) { currentShape.x += currentShape.w; currentShape.w = -currentShape.w; }
      if (currentShape.h < 0) { currentShape.y += currentShape.h; currentShape.h = -currentShape.h; }
    }
    startPt = null;
    redraw();
    renderPreview();
  });

  redraw();
}

function wireToolbar(toolbar: HTMLElement) {
  toolbar.querySelectorAll("[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      drawMode = (btn as HTMLElement).dataset.tool as "rect" | "circle";
      toolbar.querySelectorAll("[data-tool]").forEach((b) => {
        (b as HTMLElement).style.background = "#334155";
      });
      (btn as HTMLElement).style.background = "#2563eb";
    });
  });
  toolbar.querySelector("#clear-btn")?.addEventListener("click", () => {
    currentShape = null;
    if (canvas) {
      canvas.dispatchEvent(new MouseEvent("mousedown", { clientX: 0, clientY: 0 }));
      canvas.dispatchEvent(new MouseEvent("mouseup"));
    }
    renderPreview();
  });
}

function renderPreview() {
  if (!previewCanvas || !currentShape) return;

  const renderer = new THREE.WebGLRenderer({ canvas: previewCanvas, antialias: true });
  renderer.setSize(320, 500, false);
  renderer.setClearColor(0x0f172a);

  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(45, 320 / 500, 0.1, 100);
  cam.position.set(2, 2, 2);
  cam.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(5, 10, 7);
  scene.add(sun);

  const w = currentShape.w / SCALE;
  const h = currentShape.h / SCALE;

  let geo: THREE.BufferGeometry;
  if (currentShape.type === "rect") {
    geo = new THREE.BoxGeometry(w, 0.3, h);
  } else {
    const r = Math.min(w, h) / 2;
    geo = new THREE.CylinderGeometry(r, r, 0.3, 32);
  }

  const mat = new THREE.MeshLambertMaterial({ color: 0x38bdf8 });
  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);

  const grid = new THREE.GridHelper(3, 10, 0x334155, 0x1e293b);
  scene.add(grid);

  let t = 0;
  function animate() {
    if (!previewCanvas || !previewCanvas.isConnected) return;
    t += 0.01;
    cam.position.set(2 * Math.cos(t), 1.5, 2 * Math.sin(t));
    cam.lookAt(0, 0, 0);
    renderer.render(scene, cam);
    requestAnimationFrame(animate);
  }
  animate();
}

function saveFamily() {
  if (!currentShape) { alert("Draw a shape first."); return; }
  const name = prompt("Family name:", "Custom Column");
  if (!name) return;

  const w = currentShape.w / SCALE;
  const h = currentShape.h / SCALE;

  const family: Omit<FamilyDefinition, "id" | "schemaVersion" | "builtIn"> = {
    name,
    category: "generic",
    ifcEntity: "IfcBuildingElementProxy",
    parameters: [
      { name: "width",  type: "length", scope: "instance", default: w, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "depth",  type: "length", scope: "instance", default: h, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "height", type: "length", scope: "instance", default: 3.0, editable: true, step: 0.1, unit: "m", group: "Dimensions" },
    ],
    geometry: currentShape.type === "rect"
      ? { kind: "box", w: { ref: "width" }, d: { ref: "depth" }, h: { ref: "height" } }
      : { kind: "cylinder", r: { expr: "width / 2" }, h: { ref: "height" } },
    types: [
      { id: "default", name: "Default", values: { width: w, depth: h, height: 3.0 } },
    ],
    group: "Custom",
  };

  familyStore.create(family);

  window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: `Family "${name}" saved!`, kind: "success" } }));
  closeFamilyEditor();
}