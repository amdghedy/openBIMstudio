import * as THREE from "three";
import { ctx } from "../core/context";
import { notify } from "../core/notify";
import { planeForAxis } from "./section-plane-math";

let modalEl: HTMLDivElement | null = null;
let activePlane: THREE.Plane | null = null;
let activeHelper: THREE.Mesh | null = null;
let reversed = false;

export function setupSectionModal() {
  console.log("[section-modal] Module loaded.");
  (window as any).__obsOpenSectionModal = openSectionModal;
}

export function openSectionModal() {
  if (modalEl) modalEl.remove();

  // Reset any existing section
  clearSection();
  reversed = false;

  modalEl = document.createElement("div");
  modalEl.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;font:13px system-ui,sans-serif;";
  
  const win = document.createElement("div");
  win.style.cssText = "background:#1e2029;border:1px solid #2a2e3a;border-radius:8px;width:500px;max-width:90vw;display:flex;flex-direction:column;color:#e8eaf0;box-shadow:0 20px 50px rgba(0,0,0,.5);";
  
  const header = document.createElement("div");
  header.style.cssText = "padding:12px 16px;border-bottom:1px solid #2a2e3a;display:flex;justify-content:space-between;align-items:center;background:#161a22;border-radius:8px 8px 0 0;";
  header.innerHTML = "<div style='font-weight:700;font-size:15px'>Section Cut</div>";
  
  const closeBtn = document.createElement("button");
  closeBtn.innerHTML = "&#x2715;";
  closeBtn.style.cssText = "background:transparent;border:none;color:#8b949e;font-size:18px;cursor:pointer;";
  closeBtn.onclick = () => { modalEl?.remove(); modalEl = null; };
  header.appendChild(closeBtn);
  win.appendChild(header);

  const body = document.createElement("div");
  body.style.cssText = "padding:16px;background:#0f1117;display:flex;flex-direction:column;gap:12px;";
  
  // ── Axis Selection
  const axisRow = document.createElement("div");
  axisRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;";
  axisRow.innerHTML = "<span style='color:#8b949e;'>Axis</span>";
  
  const axisSel = document.createElement("select");
  axisSel.style.cssText = "padding:4px 8px;background:#0b0d12;color:#e6e8ee;border:1px solid #2a2e3a;border-radius:4px;";
  axisSel.innerHTML = `<option value="x">X (East/West)</option><option value="y">Y (Up/Down)</option><option value="z">Z (North/South)</option>`;
  axisRow.appendChild(axisSel);
  body.appendChild(axisRow);

  // ── Position Slider
  const posRow = document.createElement("div");
  posRow.style.cssText = "display:flex;flex-direction:column;gap:4px;";
  
  const posLabel = document.createElement("div");
  posLabel.style.cssText = "display:flex;justify-content:space-between;color:#8b949e;";
  posLabel.innerHTML = "<span>Position</span><span id='obs-sec-pos-val'>0.00 m</span>";
  
  const posSlider = document.createElement("input");
  posSlider.type = "range";
  posSlider.min = "-50";
  posSlider.max = "50";
  posSlider.step = "0.1";
  posSlider.value = "0";
  posSlider.style.cssText = "width:100%;cursor:pointer;";
  
  posRow.appendChild(posLabel);
  posRow.appendChild(posSlider);

  // Exact dimension: type the cut position, and reverse the cut direction.
  const exactRow = document.createElement("div");
  exactRow.style.cssText = "display:flex;gap:8px;align-items:center;margin-top:4px";
  const exactInp = document.createElement("input");
  exactInp.type = "number"; exactInp.step = "0.01"; exactInp.value = "0.00";
  exactInp.title = "Exact cut position in metres";
  exactInp.style.cssText = "flex:1;padding:5px 8px;background:#0b0d12;color:#e6e8ee;border:1px solid #2a2e3a;border-radius:4px;font:12px ui-monospace,monospace";
  const revBtn = document.createElement("button");
  const paintRev = () => { revBtn.textContent = reversed ? "\u21c4 Reversed (keeps lower side)" : "\u21c4 Reverse direction"; revBtn.style.borderColor = reversed ? "#ef4444" : "#3d4250"; };
  revBtn.style.cssText = "padding:5px 10px;background:#2a2e3a;color:#e8eaf0;border:1px solid #3d4250;border-radius:4px;cursor:pointer;white-space:nowrap";
  paintRev();
  exactRow.append(exactInp, revBtn);
  posRow.appendChild(exactRow);
  body.appendChild(posRow);

  // ── Apply buttons
  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;justify-content:space-between;margin-top:8px;";
  
  const btnClear = document.createElement("button");
  btnClear.textContent = "Clear Section";
  btnClear.style.cssText = "padding:8px 12px;background:#3b0d0d;color:#fca5a5;border:1px solid #7f1d1d;border-radius:4px;cursor:pointer;font-weight:bold;";
  btnClear.onclick = () => { clearSection(); posSlider.value = "0"; exactInp.value = "0.00"; reversed = false; paintRev(); updatePosLabel(); };
  
  const btnApply = document.createElement("button");
  btnApply.textContent = "Apply Section";
  btnApply.style.cssText = "padding:8px 12px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:bold;";
  btnApply.onclick = () => applySection(axisSel.value as "x"|"y"|"z", Number.isFinite(parseFloat(exactInp.value)) ? parseFloat(exactInp.value) : parseFloat(posSlider.value));

  btnRow.appendChild(btnClear);
  btnRow.appendChild(btnApply);
  body.appendChild(btnRow);
  win.appendChild(body);

  const footer = document.createElement("div");
  footer.style.cssText = "padding:12px 16px;border-top:1px solid #2a2e3a;display:flex;justify-content:flex-end;background:#161a22;border-radius:0 0 8px 8px;";
  const closeFooterBtn = document.createElement("button");
  closeFooterBtn.textContent = "Close";
  closeFooterBtn.style.cssText = "padding:6px 16px;background:#2a2e3a;color:#e8eaf0;border:none;border-radius:4px;cursor:pointer;";
  closeFooterBtn.onclick = () => { modalEl?.remove(); modalEl = null; };
  footer.appendChild(closeFooterBtn);
  win.appendChild(footer);

  const updatePosLabel = (v?: number) => {
    const el = document.getElementById("obs-sec-pos-val");
    if (el) el.textContent = `${(v ?? parseFloat(posSlider.value)).toFixed(2)} m`;
  };

  const currentPos = () => parseFloat(exactInp.value);
  exactInp.onkeydown = (e) => e.stopPropagation();
  exactInp.oninput = () => {
    const v = currentPos();
    if (!Number.isFinite(v)) return;
    posSlider.value = String(Math.max(-50, Math.min(50, v)));
    updatePosLabel(v);
    applySection(axisSel.value as "x"|"y"|"z", v);
  };
  revBtn.onclick = () => {
    reversed = !reversed; paintRev();
    const v = currentPos();
    applySection(axisSel.value as "x"|"y"|"z", Number.isFinite(v) ? v : parseFloat(posSlider.value));
  };
  posSlider.oninput = () => {
    exactInp.value = parseFloat(posSlider.value).toFixed(2);
    updatePosLabel();
    applySection(axisSel.value as "x"|"y"|"z", parseFloat(posSlider.value));
  };
  
  axisSel.onchange = () => {
    applySection(axisSel.value as "x"|"y"|"z", Number.isFinite(currentPos()) ? currentPos() : parseFloat(posSlider.value));
  };

  modalEl.appendChild(win);
  document.body.appendChild(modalEl);
}

function applySection(axis: "x"|"y"|"z", pos: number) {
  clearSection();

  // Plane keeps n.p + c >= 0. Reversed flips the normal so the opposite side is kept.
  const pl = planeForAxis(axis, pos, reversed);
  activePlane = new THREE.Plane(new THREE.Vector3(pl.normal.x, pl.normal.y, pl.normal.z), pl.constant);

  // Apply to the global Three.js renderer (clipping)
  const renderer = ctx.world.renderer.three as THREE.WebGLRenderer;
  if (renderer) {
    renderer.localClippingEnabled = true;
    renderer.clippingPlanes = [activePlane];
  }

  // Also apply to fragments materials if possible (OBC may handle this natively)
  try {
    const clipper: any = ctx.clipper;
    if (clipper && typeof clipper.addPlane === "function") {
      clipper.addPlane(activePlane);
    }
  } catch { /* ignore */ }

  // Add a visual helper box to show the cut
  const helperGeo = new THREE.PlaneGeometry(100, 100);
  const helperMat = new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.2, side: THREE.DoubleSide });
  activeHelper = new THREE.Mesh(helperGeo, helperMat);
  
  if (axis === "x") activeHelper.rotation.y = Math.PI / 2;
  else if (axis === "y") activeHelper.rotation.x = -Math.PI / 2;
  else activeHelper.rotation.y = 0; // z

  activeHelper.position[axis] = pos;
  ctx.world.scene.three.add(activeHelper);
}

function clearSection() {
  const renderer = ctx.world.renderer.three as THREE.WebGLRenderer;
  if (renderer) {
    renderer.clippingPlanes = [];
  }

  try {
    const clipper: any = ctx.clipper;
    if (clipper && typeof clipper.deleteAll === "function") clipper.deleteAll();
  } catch { /* ignore */ }

  if (activeHelper) {
    ctx.world.scene.three.remove(activeHelper);
    activeHelper.geometry.dispose();
    (activeHelper.material as THREE.Material).dispose();
    activeHelper = null;
  }
}