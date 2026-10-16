/**
 * Lightweight dockable panels for Rooms, Phases, Design Options, Groups.
 * Opened via obs-open-panel custom events from the UI registry patch.
 */

import { roomsStore } from "../../modules/rooms/rooms";
import { phasesStore } from "../../modules/phases/phases";
import { designOptionsStore } from "../../modules/design-options/design-options";
import { groupsStore } from "../../modules/groups/groups";
import { copyMonitorStore } from "../../modules/copy-monitor/copy-monitor";

type PanelId = "rooms" | "phases" | "design-options" | "groups" | "copy-monitor";

const panels = new Map<PanelId, HTMLDivElement>();

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c],
  );
}

function shell(title: string, bodyHtml: string): HTMLDivElement {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;top:100px;right:16px;width:320px;max-height:calc(100vh - 140px);" +
    "overflow:auto;z-index:8500;background:var(--bg-floating,#1c1e28);" +
    "border:1px solid var(--border-default,#2a2e3a);border-radius:10px;" +
    "box-shadow:0 12px 36px rgba(0,0,0,.5);color:var(--text-primary,#e8eaf0);" +
    "font:12px/1.4 system-ui;display:none;";
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;
      padding:10px 12px;border-bottom:1px solid var(--border-subtle,#1e2029);
      background:var(--bg-elevated,#181a23);cursor:grab;user-select:none;">
      <b style="font-size:13px">${esc(title)}</b>
      <button data-close style="background:transparent;border:1px solid var(--border-default);
        color:var(--text-secondary);border-radius:5px;padding:2px 8px;cursor:pointer">-</button>
    </div>
    <div data-body style="padding:10px 12px">${bodyHtml}</div>
  `;
  el.querySelector("[data-close]")?.addEventListener("click", () => {
    el.style.display = "none";
  });
  // Drag
  const hdr = el.firstElementChild as HTMLElement;
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  hdr.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    const r = el.getBoundingClientRect();
    ox = r.left; oy = r.top;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  });
  hdr.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    el.style.left = `${ox + e.clientX - sx}px`;
    el.style.top = `${oy + e.clientY - sy}px`;
    el.style.right = "auto";
  });
  hdr.addEventListener("pointerup", () => { dragging = false; });
  document.body.appendChild(el);
  return el;
}

function renderRooms(): string {
  const rooms = roomsStore.listRooms();
  const areas = roomsStore.listAreas();
  if (!rooms.length && !areas.length) {
    return `<p style="color:var(--text-tertiary)">No rooms or areas yet.</p>
      <button data-action="add-room" style="margin-top:8px;padding:6px 10px;border-radius:6px;
        background:var(--accent-dim);color:var(--accent);border:1px solid var(--accent);cursor:pointer">
        + Sample Room</button>`;
  }
  let html = `<div style="font:700 10px monospace;color:var(--text-tertiary);margin-bottom:6px">ROOMS (${rooms.length})</div>`;
  for (const r of rooms) {
    html += `<div style="padding:6px 8px;margin-bottom:4px;background:var(--bg-inset);border-radius:6px;border:1px solid var(--border-subtle)">
      <b>${esc(r.number)}</b> ${esc(r.name)}
      <div style="color:var(--text-tertiary);font-size:11px">${r.area.toFixed(1)} m- - ${r.perimeter.toFixed(1)} m</div>
    </div>`;
  }
  if (areas.length) {
    html += `<div style="font:700 10px monospace;color:var(--text-tertiary);margin:10px 0 6px">AREAS (${areas.length})</div>`;
    for (const a of areas) {
      html += `<div style="padding:6px 8px;margin-bottom:4px;background:var(--bg-inset);border-radius:6px">
        <b>${esc(a.number)}</b> ${esc(a.name)} <span style="opacity:.6">(${a.areaType})</span>
        <div style="color:var(--text-tertiary);font-size:11px">${a.area.toFixed(1)} m-</div>
      </div>`;
    }
  }
  html += `<button data-action="add-room" style="margin-top:8px;padding:6px 10px;border-radius:6px;
    background:var(--bg-hover);border:1px solid var(--border-default);color:var(--text-primary);cursor:pointer">
    + Room</button>`;
  return html;
}

function renderPhases(): string {
  const phases = phasesStore.list();
  const cur = phasesStore.getCurrent();
  const filter = phasesStore.getFilter();
  let html = `<div style="margin-bottom:8px">
    <label style="font-size:11px;color:var(--text-tertiary)">Active phase</label>
    <select data-phase style="width:100%;margin-top:4px;padding:6px;background:var(--bg-inset);
      border:1px solid var(--border-default);border-radius:6px;color:var(--text-primary)">
      ${phases.map((p) => `<option value="${p.id}" ${p.id === cur?.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
    </select>
  </div>
  <div style="margin-bottom:8px">
    <label style="font-size:11px;color:var(--text-tertiary)">Phase filter</label>
    <select data-filter style="width:100%;margin-top:4px;padding:6px;background:var(--bg-inset);
      border:1px solid var(--border-default);border-radius:6px;color:var(--text-primary)">
      <option value="show-complete" ${filter === "show-complete" ? "selected" : ""}>Show Complete</option>
      <option value="show-new" ${filter === "show-new" ? "selected" : ""}>Show New</option>
      <option value="show-previous" ${filter === "show-previous" ? "selected" : ""}>Show Previous</option>
      <option value="show-previous-and-new" ${filter === "show-previous-and-new" ? "selected" : ""}>Previous + New</option>
      <option value="show-demo" ${filter === "show-demo" ? "selected" : ""}>Show Demolished</option>
      <option value="show-all" ${filter === "show-all" ? "selected" : ""}>Show All</option>
    </select>
  </div>
  <div style="font:700 10px monospace;color:var(--text-tertiary);margin:8px 0 4px">PHASES</div>`;
  for (const p of phases) {
    html += `<div style="padding:5px 8px;margin-bottom:3px;border-radius:5px;
      background:${p.id === cur?.id ? "var(--accent-dim)" : "var(--bg-inset)"}">
      ${esc(p.name)} <span style="opacity:.5">#${p.order}</span>
    </div>`;
  }
  html += `<button data-action="add-phase" style="margin-top:8px;padding:6px 10px;border-radius:6px;
    background:var(--bg-hover);border:1px solid var(--border-default);cursor:pointer">+ Phase</button>`;
  return html;
}

function renderDesignOptions(): string {
  const sets = designOptionsStore.listSets();
  if (!sets.length) {
    return `<p style="color:var(--text-tertiary)">No design option sets.</p>
      <button data-action="add-set" style="margin-top:8px;padding:6px 10px;border-radius:6px;
        background:var(--accent-dim);color:var(--accent);border:1px solid var(--accent);cursor:pointer">
        + Option Set</button>`;
  }
  let html = "";
  for (const s of sets) {
    html += `<div style="margin-bottom:10px;padding:8px;border:1px solid var(--border-subtle);border-radius:8px">
      <b>${esc(s.name)}</b>
      <div style="margin-top:6px">`;
    for (const o of s.options) {
      const active = s.activeOptionId === o.id;
      html += `<button data-set="${s.id}" data-opt="${o.id}" style="display:block;width:100%;text-align:left;
        padding:5px 8px;margin-bottom:3px;border-radius:5px;cursor:pointer;
        background:${active ? "var(--accent-dim)" : "var(--bg-inset)"};
        border:1px solid ${active ? "var(--accent)" : "var(--border-subtle)"};
        color:var(--text-primary)">
        ${esc(o.name)}${o.isPrimary ? " (Primary)" : ""}${active ? " -" : ""}
      </button>`;
    }
    html += `</div></div>`;
  }
  html += `<button data-action="add-set" style="padding:6px 10px;border-radius:6px;
    background:var(--bg-hover);border:1px solid var(--border-default);cursor:pointer">+ Option Set</button>`;
  return html;
}

function renderGroups(): string {
  const types = groupsStore.listTypes();
  const instances = groupsStore.listInstances();
  if (!types.length) {
    return `<p style="color:var(--text-tertiary)">No groups. Select elements and create a group from the ribbon.</p>`;
  }
  let html = `<div style="font:700 10px monospace;color:var(--text-tertiary);margin-bottom:6px">TYPES (${types.length})</div>`;
  for (const t of types) {
    const count = instances.filter((i) => i.typeId === t.id).length;
    html += `<div style="padding:6px 8px;margin-bottom:4px;background:var(--bg-inset);border-radius:6px">
      <b>${esc(t.name)}</b> ${t.shared ? "- shared" : ""}
      <div style="color:var(--text-tertiary);font-size:11px">${t.memberIds.length} members - ${count} instance(s)</div>
    </div>`;
  }
  return html;
}

function renderCopyMonitor(): string {
  const rules = copyMonitorStore.listRules();
  const summary = copyMonitorStore.summary();
  let html = `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:10px">
    <div style="text-align:center;padding:6px;background:var(--bg-inset);border-radius:6px"><b>${summary.total}</b><div style="font-size:9px;opacity:.6">Total</div></div>
    <div style="text-align:center;padding:6px;background:var(--bg-inset);border-radius:6px"><b style="color:#38bdf8">${summary.new}</b><div style="font-size:9px;opacity:.6">New</div></div>
    <div style="text-align:center;padding:6px;background:var(--bg-inset);border-radius:6px"><b style="color:#f59e0b">${summary.modified}</b><div style="font-size:9px;opacity:.6">Mod</div></div>
    <div style="text-align:center;padding:6px;background:var(--bg-inset);border-radius:6px"><b style="color:#ef4444">${summary.deleted}</b><div style="font-size:9px;opacity:.6">Del</div></div>
  </div>`;
  if (!rules.length) {
    html += `<p style="color:var(--text-tertiary)">No monitoring rules. Add a rule for a linked model.</p>`;
  } else {
    for (const r of rules) {
      html += `<div style="padding:6px 8px;margin-bottom:4px;background:var(--bg-inset);border-radius:6px">
        <b>${esc(r.name)}</b>
        <div style="font-size:11px;color:var(--text-tertiary)">${esc(r.sourceModelId)} ${r.categoryFilter ? "- " + esc(r.categoryFilter) : ""}</div>
      </div>`;
    }
  }
  html += `<button data-action="ack-all" style="margin-top:8px;padding:6px 10px;border-radius:6px;
    background:var(--bg-hover);border:1px solid var(--border-default);cursor:pointer">Acknowledge All</button>`;
  return html;
}

function bindPanel(id: PanelId, el: HTMLDivElement): void {
  const body = el.querySelector("[data-body]") as HTMLElement;

  body.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const action = t.getAttribute("data-action");
    if (action === "add-room") {
      roomsStore.createRoom({
        name: "Room",
        boundary: [
          { x: 0, z: 0 },
          { x: 4, z: 0 },
          { x: 4, z: 3 },
          { x: 0, z: 3 },
        ],
      });
      refresh(id);
    }
    if (action === "add-phase") {
      const name = window.prompt("Phase name:", "Phase") ?? "";
      if (name) {
        phasesStore.create(name);
        refresh(id);
      }
    }
    if (action === "add-set") {
      const name = window.prompt("Option set name:", "Design Options") ?? "";
      if (name) {
        designOptionsStore.createSet(name);
        refresh(id);
      }
    }
    if (action === "ack-all") {
      copyMonitorStore.acknowledgeAll();
      refresh(id);
    }
    const setId = t.getAttribute("data-set");
    const optId = t.getAttribute("data-opt");
    if (setId && optId) {
      designOptionsStore.setActive(setId, optId);
      refresh(id);
    }
  });

  body.addEventListener("change", (e) => {
    const t = e.target as HTMLSelectElement;
    if (t.matches("[data-phase]")) {
      phasesStore.setCurrent(t.value);
      refresh(id);
    }
    if (t.matches("[data-filter]")) {
      phasesStore.setFilter(t.value as any);
      refresh(id);
    }
  });
}

function refresh(id: PanelId): void {
  const el = panels.get(id);
  if (!el) return;
  const body = el.querySelector("[data-body]") as HTMLElement;
  if (id === "rooms") body.innerHTML = renderRooms();
  if (id === "phases") body.innerHTML = renderPhases();
  if (id === "design-options") body.innerHTML = renderDesignOptions();
  if (id === "groups") body.innerHTML = renderGroups();
  if (id === "copy-monitor") body.innerHTML = renderCopyMonitor();
}

function openPanel(id: PanelId): void {
  let el = panels.get(id);
  if (!el) {
    const titles: Record<PanelId, string> = {
      rooms: "Rooms & Areas",
      phases: "Phasing",
      "design-options": "Design Options",
      groups: "Model Groups",
      "copy-monitor": "Copy / Monitor",
    };
    el = shell(titles[id], "");
    panels.set(id, el);
    bindPanel(id, el);
  }
  refresh(id);
  el.style.display = "block";
}

export function setupGapPanels(): void {
  window.addEventListener("obs-open-panel", ((e: CustomEvent) => {
    const id = e.detail?.id as PanelId;
    if (id && ["rooms", "phases", "design-options", "groups", "copy-monitor"].includes(id)) {
      openPanel(id);
    }
  }) as EventListener);
  console.log("[gap-panels] ready");
}
