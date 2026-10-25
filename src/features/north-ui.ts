/**
 * Project North / True North UI: the "Rotate True North" dialog and the 3D-view compass.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { notify } from "../core/notify";
import { formatNorthAngle, getNorthState, onNorthChanged, parseNorthInput, setNorthState } from "../modules/north/north";
import { escapeHtml } from "../core/html-escape";

/** Ask for the angle between project north and true north. Resolves true when it was changed. */
export function promptTrueNorth(): Promise<boolean> {
  return new Promise((resolve) => {
    const cur = getNorthState().trueNorthAngle;
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center";
    wrap.innerHTML = `
      <form style="background:#141821;color:#e8eaf0;border:1px solid #2a2e3a;border-radius:10px;padding:18px 20px;width:380px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.6)">
        <div style="font-weight:700;font-size:14px;margin-bottom:6px">Rotate True North</div>
        <div style="opacity:.8;margin-bottom:10px">Project North is the top of your plan. Enter how far True North lies from it,
        measured clockwise (E) or counter-clockwise (W) as seen on the plan.</div>
        <input id="tn-in" value="${escapeHtml(cur === 0 ? "0" : formatNorthAngle(cur).replace("°", ""))}" autocomplete="off"
          style="width:100%;box-sizing:border-box;padding:8px;background:#0e1017;border:1px solid #2a2e3a;border-radius:6px;color:#e8eaf0" />
        <div style="opacity:.6;font-size:11.5px;margin:6px 0 4px">Examples: <code>30</code> or <code>30 E</code> = true north 30° clockwise of project north · <code>30 W</code> = 30° counter-clockwise.</div>
        <div id="tn-err" style="color:#fca5a5;min-height:16px;font-size:12px"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
          <button type="button" id="tn-cancel" style="padding:7px 14px;border-radius:6px;border:1px solid #2a2e3a;background:#1e2430;color:#e8eaf0;cursor:pointer">Cancel</button>
          <button type="submit" style="padding:7px 14px;border-radius:6px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer">Apply</button>
        </div>
      </form>`;
    const done = (v: boolean) => { wrap.remove(); resolve(v); };
    const input = wrap.querySelector("#tn-in") as HTMLInputElement;
    wrap.querySelector("#tn-cancel")!.addEventListener("click", () => done(false));
    wrap.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") done(false); e.stopPropagation(); });
    wrap.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = parseNorthInput(input.value);
      if (v == null) { (wrap.querySelector("#tn-err") as HTMLElement).textContent = "Enter a number of degrees, optionally followed by E or W."; return; }
      setNorthState({ trueNorthAngle: v });
      notify("info", `True North set to ${formatNorthAngle(v)} from Project North`);
      done(true);
    });
    document.body.appendChild(wrap);
    input.focus(); input.select();
  });
}

/* ── 3D compass ─────────────────────────────────────────────────────────── */
let compass: HTMLDivElement | null = null;
let projNeedle: SVGGElement | null = null;
let trueNeedle: SVGGElement | null = null;
let label: HTMLDivElement | null = null;
let raf: number | null = null;

function build(): HTMLDivElement | null {
  if (compass) return compass;
  const host = ctx.rightHost as HTMLElement | undefined;
  if (!host) return null;
  const NS = "http://www.w3.org/2000/svg";
  compass = document.createElement("div");
  compass.id = "obs-north-compass";
  compass.title = "Red = True North · Blue = Project North (the top of the plan)";
  compass.style.cssText =
    "position:absolute;left:12px;bottom:52px;width:76px;z-index:30;pointer-events:none;text-align:center;" +
    "font:700 9px system-ui,sans-serif;color:#cbd5e1;text-shadow:0 1px 2px rgba(0,0,0,.9)";
  compass.innerHTML =
    `<svg width="76" height="76" viewBox="-38 -38 76 76" xmlns="${NS}">` +
    `<circle r="35" fill="rgba(14,16,23,.55)" stroke="rgba(148,163,184,.55)" stroke-width="1"/>` +
    `<g id="obs-nc-proj"><polygon points="0,-30 4,-8 -4,-8" fill="#38bdf8"/><text y="-32" x="0" font-size="7" text-anchor="middle" fill="#38bdf8" font-family="system-ui">PN</text></g>` +
    `<g id="obs-nc-true"><polygon points="0,-27 6,0 0,-5 -6,0" fill="#ef4444" stroke="#fff" stroke-width=".8"/><polygon points="0,27 4,0 0,5 -4,0" fill="rgba(148,163,184,.6)"/>` +
    `<text y="-17" x="0" font-size="9" text-anchor="middle" fill="#fff" font-family="system-ui" font-weight="700">N</text></g>` +
    `</svg><div id="obs-nc-label"></div>`;
  projNeedle = compass.querySelector("#obs-nc-proj");
  trueNeedle = compass.querySelector("#obs-nc-true");
  label = compass.querySelector("#obs-nc-label");
  host.appendChild(compass);
  return compass;
}

/** Clockwise screen angle (deg from "up") of a horizontal world direction, relative to where the camera looks. */
function screenAngle(vx: number, vz: number, fx: number, fz: number): number {
  // camera right (horizontal) = forward × up = (-fz, 0, fx)
  const rx = -fz, rz = fx;
  const x = vx * rx + vz * rz;
  const y = vx * fx + vz * fz;
  return (Math.atan2(x, y) * 180) / Math.PI;
}

function tick(): void {
  raf = null;
  const c = build();
  if (!c) return;
  let hidden = false;
  try { hidden = !!(ctx.features as any).walkMode?.isEnabled?.(); } catch { /* */ }
  c.style.display = hidden ? "none" : "block";
  if (!hidden) {
    try {
      const cam: any = ctx.world.camera.three;
      const f = new THREE.Vector3();
      cam.getWorldDirection(f);
      let fx = f.x, fz = f.z;
      const len = Math.hypot(fx, fz);
      if (len < 0.02) {           // looking straight down/up: use the camera's up vector as "forward"
        fx = cam.up?.x ?? 0; fz = cam.up?.z ?? -1;
        const l2 = Math.hypot(fx, fz) || 1; fx /= l2; fz /= l2;
        // a camera looking down has its screen-up along its own "up" projected on the ground
        const u = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
        const ul = Math.hypot(u.x, u.z);
        if (ul > 1e-4) { fx = u.x / ul; fz = u.z / ul; }
      } else { fx /= len; fz /= len; }
      const st = getNorthState();
      const th = (st.trueNorthAngle * Math.PI) / 180;
      const pn = screenAngle(0, 1, fx, fz);
      const tn = screenAngle(Math.sin(th), Math.cos(th), fx, fz);
      projNeedle?.setAttribute("transform", `rotate(${pn.toFixed(1)})`);
      trueNeedle?.setAttribute("transform", `rotate(${tn.toFixed(1)})`);
      if (label) label.textContent = st.trueNorthAngle === 0 ? "True = Project N" : `True N ${formatNorthAngle(st.trueNorthAngle)}`;
    } catch { /* camera not ready yet */ }
  }
  raf = requestAnimationFrame(tick);
}

export function setupNorthCompass(): void {
  if (raf != null) return;
  raf = requestAnimationFrame(tick);
  onNorthChanged(() => {
    // sun / shadow direction follows the real compass
    try { void import("../modules/sun-settings/types").then((m) => m.setSunSettings({ northOffset: getNorthState().trueNorthAngle })); } catch { /* */ }
  });
}
