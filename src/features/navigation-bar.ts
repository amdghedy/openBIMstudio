/**
 * Navigation Bar â€” floating view-control toolbar.
 *
 * Positioned under the ViewCube on the right side of the viewport.
 * Provides Home, Fit, Walk, Orbit, Pan, Zoom buttons that mirror the
 * 3D navigation commands. Visibility toggled from the User Interface menu.
 */

import { ctx } from "../core/context";
import {
  fitAll, goHome, gotoDir, setProjection, getProjection, takeScreenshot,
} from "./camera-tools";
import { toggleWalkMode, isWalkModeEnabled } from "./walk-mode";
import * as THREE from "three";

let bar: HTMLDivElement | null = null;
let visible = false;

function mkBtn(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.title = title;
  b.style.cssText =
    "display:flex;align-items:center;justify-content:center;width:34px;height:34px;" +
    "border-radius:6px;background:#1c1e28;color:#cbd5e1;border:1px solid #2a2e3a;" +
    "cursor:pointer;font:600 15px system-ui;transition:background .12s";
  b.onmouseenter = () => { b.style.background = "#232633"; b.style.color = "#e8eaf0"; };
  b.onmouseleave = () => { b.style.background = "#1c1e28"; b.style.color = "#cbd5e1"; };
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

export function setupNavigationBar(): void {
  bar = document.createElement("div");
  bar.id = "obs-navigation-bar";
  bar.style.cssText =
    "position:absolute;top:14px;right:14px;z-index:35;display:none;" +
    "flex-direction:column;gap:4px;padding:5px;" +
    "background:rgba(20,22,30,.85);border:1px solid #2a2e3a;border-radius:10px;" +
    "box-shadow:0 8px 24px rgba(0,0,0,.4);backdrop-filter:blur(8px)";
  bar.onmousedown = (e) => e.stopPropagation();

  // View directions (2x2 grid)
  const dirGrid = document.createElement("div");
  dirGrid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:4px";
  dirGrid.append(
    mkBtn("\u2191", "Top view", () => gotoDir(new THREE.Vector3(0, 1, 0))),
    mkBtn("\u2193", "Bottom view", () => gotoDir(new THREE.Vector3(0, -1, 0))),
    mkBtn("\u2190", "Left view", () => gotoDir(new THREE.Vector3(-1, 0, 0))),
    mkBtn("\u2192", "Right view", () => gotoDir(new THREE.Vector3(1, 0, 0))),
  );
  bar.appendChild(dirGrid);

  // Separator
  const sep = document.createElement("div");
  sep.style.cssText = "height:1px;background:#2a2e3a;margin:2px 0";
  bar.appendChild(sep);

  // Action buttons
  const actions = document.createElement("div");
  actions.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:4px";
  actions.append(
    mkBtn("\u2302", "Home view", () => goHome()),
    mkBtn("\u26F6", "Fit all", () => fitAll()),
    mkBtn("\u2318", "Toggle Ortho / Perspective", () => {
      const next = getProjection() === "orthographic" ? "perspective" : "orthographic";
      setProjection(next);
    }),
    mkBtn("\u2317", "Screenshot", () => takeScreenshot()),
  );
  bar.appendChild(actions);

  // Walk mode row
  const walkRow = document.createElement("div");
  walkRow.style.cssText = "display:flex;justify-content:center;margin-top:2px";
  const walkBtn = mkBtn("\u{1F6B6}", "Walk mode (Ctrl+W)", () => toggleWalkMode());
  walkBtn.style.width = "72px";
  walkBtn.id = "obs-nav-walk-btn";
  walkRow.appendChild(walkBtn);
  bar.appendChild(walkRow);

  ctx.rightHost.appendChild(bar);

  (ctx.features as any).navigationBar = {
    show: () => { visible = true; if (bar) bar.style.display = "flex"; },
    hide: () => { visible = false; if (bar) bar.style.display = "none"; },
    toggle: () => { visible ? (ctx.features as any).navigationBar.hide() : (ctx.features as any).navigationBar.show(); },
    isVisible: () => visible,
  };
}