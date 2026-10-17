import { ctx } from "../core/context";

let modalEl: HTMLDivElement | null = null;

export function setupSchedulesUI() {
  console.log("[schedules-ui] Module loaded.");
  (window as any).__obsOpenSchedules = openSchedulesModal;
}

export function openSchedulesModal() {
  if (modalEl) modalEl.remove();

  modalEl = document.createElement("div");
  modalEl.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;font:13px system-ui,sans-serif;";
  
  const win = document.createElement("div");
  win.style.cssText = "background:#1e2029;border:1px solid #2a2e3a;border-radius:8px;width:800px;max-width:95vw;max-height:85vh;display:flex;flex-direction:column;color:#e8eaf0;box-shadow:0 20px 50px rgba(0,0,0,.5);";
  
  const header = document.createElement("div");
  header.style.cssText = "padding:12px 16px;border-bottom:1px solid #2a2e3a;display:flex;justify-content:space-between;align-items:center;background:#161a22;border-radius:8px 8px 0 0;";
  header.innerHTML = "<div style='font-weight:700;font-size:15px'>Element Schedule</div>";
  
  const closeBtn = document.createElement("button");
  closeBtn.innerHTML = "&#x2715;";
  closeBtn.style.cssText = "background:transparent;border:none;color:#8b949e;font-size:18px;cursor:pointer;";
  closeBtn.onclick = () => { modalEl?.remove(); modalEl = null; };
  header.appendChild(closeBtn);
  win.appendChild(header);

  const contentArea = document.createElement("div");
  contentArea.style.cssText = "flex:1;overflow-y:auto;padding:16px;background:#0f1117;";

  const renderTable = () => {
    contentArea.innerHTML = "";
    const table = document.createElement("table");
    table.style.cssText = "width:100%;border-collapse:collapse;text-align:left;font-size:12px;";
    
    table.innerHTML = `
      <thead>
        <tr style="border-bottom:1px solid #2a2e3a;color:#8b949e;background:#14141c;">
          <th style="padding:10px;font-weight:600;">Category</th>
          <th style="padding:10px;font-weight:600;">Count</th>
          <th style="padding:10px;font-weight:600;">Total Area / Length</th>
          <th style="padding:10px;font-weight:600;">Total Volume</th>
          <th style="padding:10px;font-weight:600;text-align:right;">Action</th>
        </tr>
      </thead>
      <tbody id="obs-schedule-body"></tbody>
    `;
    contentArea.appendChild(table);

    const tbody = table.querySelector("#obs-schedule-body")!;
    const auth = (ctx.features as any).authoring;
    const authEls = auth?.getElements?.() ?? [];

    // Aggregate data by type
    const stats: Record<string, { count: number, areaLength: number, volume: number }> = {};

    for (const el of authEls) {
      const type = el.type || "unknown";
      if (!stats[type]) stats[type] = { count: 0, areaLength: 0, volume: 0 };
      stats[type].count++;

      // Simple geometry math for native elements
      const p = el.params || {};
      const L = (p.start && p.end) ? Math.hypot(p.end[0]-p.start[0], p.end[1]-p.start[1]) : 0;
      const W = p.thickness || 0;
      const H = p.height || 0;

      if (type === "wall" || type === "duct" || type === "cable-tray" || type === "pipe") {
        stats[type].areaLength += L;
        stats[type].volume += L * W * H;
      } else if (type === "slab" || type === "roof" || type === "ceiling") {
         if (Array.isArray(p.polygon) && p.polygon.length >= 3) {
            let area = 0;
            for (let i=0; i<p.polygon.length; i++) {
              const a = p.polygon[i], b = p.polygon[(i+1)%p.polygon.length];
              area += a[0]*b[1] - b[0]*a[1];
            }
            area = Math.abs(area/2);
            stats[type].areaLength += area;
            stats[type].volume += area * H;
         }
      }
    }

    const sortedKeys = Object.keys(stats).sort();
    if (sortedKeys.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="padding:20px;text-align:center;color:#6b7280;">No elements found. Draw something first!</td></tr>`;
      return;
    }

    for (const type of sortedKeys) {
      const data = stats[type];
      const tr = document.createElement("tr");
      tr.style.cssText = "border-bottom:1px solid #1e2029;";
      
      // Capitalize first letter
      const catName = type.charAt(0).toUpperCase() + type.slice(1);

      tr.innerHTML = `
        <td style="padding:10px;color:#e8eaf0;">${catName}</td>
        <td style="padding:10px;color:#22c55e;font-weight:bold;">${data.count}</td>
        <td style="padding:10px;color:#8b949e;">${data.areaLength.toFixed(2)} m / m²</td>
        <td style="padding:10px;color:#8b949e;">${data.volume.toFixed(2)} m³</td>
        <td style="padding:10px;text-align:right;">
          <button style="padding:4px 8px;background:#2563eb;color:#fff;border:none;border-radius:4px;cursor:pointer;" onclick="window.dispatchEvent(new CustomEvent('obs-select-category', {detail: '${type}'}))">Select</button>
        </td>
      `;
      tbody.appendChild(tr);
    }
  };

  // Add listener for select button
  window.addEventListener("obs-select-category", (e: any) => {
    const type = e.detail;
    const auth = (ctx.features as any).authoring;
    if (auth && auth.getElements) {
      const ids = auth.getElements().filter((el: any) => el.type === type).map((el: any) => el.id);
      auth.setSelectedAuthored(ids);
    }
  });

  const toolbar = document.createElement("div");
  toolbar.style.cssText = "padding:10px 16px;border-bottom:1px solid #2a2e3a;display:flex;justify-content:flex-start;background:#181a23;";
  const btnRefresh = document.createElement("button");
  btnRefresh.textContent = "⟳ Refresh Data";
  btnRefresh.style.cssText = "padding:6px 12px;background:#2a2e3a;color:#e8eaf0;border:none;border-radius:4px;cursor:pointer;";
  btnRefresh.onclick = renderTable;
  toolbar.appendChild(btnRefresh);
  win.appendChild(toolbar);

  renderTable();
  win.appendChild(contentArea);
  
  const footer = document.createElement("div");
  footer.style.cssText = "padding:12px 16px;border-top:1px solid #2a2e3a;display:flex;justify-content:flex-end;background:#161a22;border-radius:0 0 8px 8px;";
  const closeFooterBtn = document.createElement("button");
  closeFooterBtn.textContent = "Close";
  closeFooterBtn.style.cssText = "padding:6px 16px;background:#2a2e3a;color:#e8eaf0;border:none;border-radius:4px;cursor:pointer;";
  closeFooterBtn.onclick = () => { modalEl?.remove(); modalEl = null; };
  footer.appendChild(closeFooterBtn);
  win.appendChild(footer);

  modalEl.appendChild(win);
  document.body.appendChild(modalEl);
}