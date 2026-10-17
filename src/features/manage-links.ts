import { ctx } from "../core/context";
import { notify } from "../core/notify";

let modalEl: HTMLDivElement | null = null;

export function setupManageLinks() {
  console.log("[manage-links] Module loaded. Attaching to window.__obsManageLinks");
  (window as any).__obsManageLinks = openManageLinks;
}

export function openManageLinks() {
  if (modalEl) modalEl.remove();

  modalEl = document.createElement("div");
  modalEl.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;font:13px system-ui,sans-serif;";
  
  const win = document.createElement("div");
  win.style.cssText = "background:#1e2029;border:1px solid #2a2e3a;border-radius:8px;width:800px;max-width:90vw;max-height:85vh;display:flex;flex-direction:column;color:#e8eaf0;box-shadow:0 20px 50px rgba(0,0,0,.5);";
  
  const header = document.createElement("div");
  header.style.cssText = "padding:12px 16px;border-bottom:1px solid #2a2e3a;display:flex;justify-content:space-between;align-items:center;background:#161a22;border-radius:8px 8px 0 0;";
  header.innerHTML = "<div style='font-weight:700;font-size:15px'>Manage Links</div>";
  
  const closeBtn = document.createElement("button");
  closeBtn.innerHTML = "&#x2715;";
  closeBtn.style.cssText = "background:transparent;border:none;color:#8b949e;font-size:18px;cursor:pointer;";
  closeBtn.onclick = () => { modalEl?.remove(); modalEl = null; };
  header.appendChild(closeBtn);
  win.appendChild(header);

  const tabsRow = document.createElement("div");
  tabsRow.style.cssText = "display:flex;border-bottom:1px solid #2a2e3a;background:#181a23;";
  const tabs = ["IFC", "CAD Formats (DWG/DXF)", "Point Clouds", "Topography"];
  let activeTab = "IFC";
  const contentArea = document.createElement("div");
  contentArea.style.cssText = "flex:1;overflow-y:auto;padding:16px;background:#0f1117;";

  const renderTable = () => {
    contentArea.innerHTML = "";
    const table = document.createElement("table");
    table.style.cssText = "width:100%;border-collapse:collapse;text-align:left;";
    
    table.innerHTML = `
      <thead>
        <tr style="border-bottom:1px solid #2a2e3a;color:#8b949e;">
          <th style="padding:8px;font-weight:600;">Link Name</th>
          <th style="padding:8px;font-weight:600;">Status</th>
          <th style="padding:8px;font-weight:600;">Type</th>
          <th style="padding:8px;font-weight:600;text-align:right;">Action</th>
        </tr>
      </thead>
      <tbody id="obs-manage-links-body"></tbody>
    `;
    contentArea.appendChild(table);

    const tbody = table.querySelector("#obs-manage-links-body")!;
    let count = 0;

    for (const [modelId] of ctx.fragments.list) {
      const tr = document.createElement("tr");
      tr.style.cssText = "border-bottom:1px solid #1e2029;";
      
      const nameTd = document.createElement("td");
      nameTd.style.cssText = "padding:8px;";
      nameTd.textContent = modelId;
      
      const statusTd = document.createElement("td");
      statusTd.style.cssText = "padding:8px;color:#22c55e;"; 
      statusTd.textContent = "Loaded";
      
      const typeTd = document.createElement("td");
      typeTd.style.cssText = "padding:8px;color:#8b949e;";
      typeTd.textContent = activeTab === "IFC" ? "IFC Model" : "CAD Underlay";

      const actionTd = document.createElement("td");
      actionTd.style.cssText = "padding:8px;text-align:right;";
      
      const unloadBtn = document.createElement("button");
      unloadBtn.textContent = "Unload";
      unloadBtn.style.cssText = "padding:4px 8px;background:#3b0d0d;color:#fca5a5;border:1px solid #7f1d1d;border-radius:4px;cursor:pointer;font:12px system-ui;";
      
      unloadBtn.onclick = async () => {
        try {
          const m = ctx.fragments.list.get(modelId);
          if (m) {
            if (typeof (m as any).dispose === "function") (m as any).dispose();
            ctx.fragments.list.delete(modelId);
            notify("info", `Unloaded ${modelId}`);
            renderTable(); 
          }
        } catch (e) {
          console.error("Failed to unload model", e);
          notify("error", `Failed to unload ${modelId}`);
        }
      };
      
      actionTd.appendChild(unloadBtn);
      tr.appendChild(nameTd);
      tr.appendChild(statusTd);
      tr.appendChild(typeTd);
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
      count++;
    }

    if (count === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="padding:20px;text-align:center;color:#6b7280;">No links found.</td></tr>`;
    }
  };

  tabs.forEach((tabName, i) => {
    const btn = document.createElement("button");
    btn.textContent = tabName;
    btn.style.cssText = `padding:10px 16px;border:none;background:transparent;color:${i === 0 ? "#e8eaf0" : "#8b949e"};font-weight:600;cursor:pointer;border-bottom:${i === 0 ? "2px solid #38bdf8" : "2px solid transparent"};`;
    btn.onclick = () => {
      activeTab = tabName;
      Array.from(tabsRow.children).forEach((c: any, j) => {
        c.style.color = j === i ? "#e8eaf0" : "#8b949e";
        c.style.borderBottom = j === i ? "2px solid #38bdf8" : "2px solid transparent";
      });
      renderTable();
    };
    tabsRow.appendChild(btn);
  });
  win.appendChild(tabsRow);
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