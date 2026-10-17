import { ctx } from "../core/context";

let modalEl: HTMLDivElement | null = null;

export function setupClashCategories() {
  // Expose globally so commands and ribbon can call it
  (window as any).__obsOpenClashCategories = openClashCategoriesModal;
}

export function openClashCategoriesModal() {
  if (modalEl) modalEl.remove();

  modalEl = document.createElement("div");
  modalEl.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;font:13px system-ui,sans-serif;";
  
  const win = document.createElement("div");
  win.style.cssText = "background:#1e2029;border:1px solid #2a2e3a;border-radius:8px;width:500px;max-width:90vw;display:flex;flex-direction:column;color:#e8eaf0;box-shadow:0 20px 50px rgba(0,0,0,.5);";
  
  // Header
  const header = document.createElement("div");
  header.style.cssText = "padding:12px 16px;border-bottom:1px solid #2a2e3a;display:flex;justify-content:space-between;align-items:center;background:#161a22;border-radius:8px 8px 0 0;";
  header.innerHTML = "<div style='font-weight:700;font-size:15px'>Category Clash Rules</div>";
  
  const closeBtn = document.createElement("button");
  closeBtn.innerHTML = "&#x2715;";
  closeBtn.style.cssText = "background:transparent;border:none;color:#8b949e;font-size:18px;cursor:pointer;";
  closeBtn.onclick = () => { modalEl?.remove(); modalEl = null; };
  header.appendChild(closeBtn);
  win.appendChild(header);

  // Body
  const body = document.createElement("div");
  body.style.cssText = "padding:16px;background:#0f1117;";
  
  const btnRefresh = document.createElement("button");
  btnRefresh.textContent = "⟳ Refresh List";
  btnRefresh.style.cssText = "padding:4px 8px; font-size:11px; background:#2a2e3a; color:#a5b4fc; border:1px solid #3a3e4a; border-radius:4px; cursor:pointer; margin-bottom:10px; float:right;";
  
  const lblA = document.createElement("div");
  lblA.textContent = "Selection A (e.g. Structure)";
  lblA.style.cssText = "font-size:11px; margin-bottom:4px; color:#a5b4fc;";
  const selA = document.createElement("select");
  selA.multiple = true;
  selA.style.cssText = "width:100%; height:100px; background:#0b0d12; color:#e6e8ee; margin-bottom:12px; border:1px solid #2a2e3a; border-radius:4px;";

  const lblB = document.createElement("div");
  lblB.textContent = "Selection B (e.g. MEP)";
  lblB.style.cssText = "font-size:11px; margin-bottom:4px; color:#fca5a5;";
  const selB = document.createElement("select");
  selB.multiple = true;
  selB.style.cssText = "width:100%; height:100px; background:#0b0d12; color:#e6e8ee; margin-bottom:12px; border:1px solid #2a2e3a; border-radius:4px;";

  const btnRun = document.createElement("button");
  btnRun.textContent = "Run Clash by Category";
  btnRun.style.cssText = "width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:4px; cursor:pointer; font-weight:bold; font-size:14px;";

  body.appendChild(btnRefresh);
  body.appendChild(lblA);
  body.appendChild(selA);
  body.appendChild(lblB);
  body.appendChild(selB);
  body.appendChild(btnRun);
  win.appendChild(body);

  // Footer
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

  // Populate logic
  const populateCategories = async () => {
    const cats = new Set<string>();
    const auth = (ctx.features as any).authoring;
    const authEls = auth?.getElements?.() ?? [];
    for (const el of authEls) if (el.type) cats.add(`NATIVE_${el.type.toLowerCase()}`);

    for (const [, model] of ctx.fragments.list) {
      try {
        const items = await (model as any).getItemsOfCategories([/.+/]);
        if (items) Object.keys(items).forEach(k => cats.add(k));
      } catch { /* */ }
    }

    const sorted = Array.from(cats).sort();
    selA.innerHTML = ""; selB.innerHTML = "";
    if (sorted.length === 0) {
       selA.appendChild(new Option("No categories found...", ""));
       selB.appendChild(new Option("No categories found...", ""));
       return;
    }

    for (const c of sorted) {
      let label = c;
      if (c.startsWith("NATIVE_")) label = `🏠 [Native] ${c.replace("NATIVE_", "").replace(/-/g, " ")}`;
      else label = `📦 [IFC] ${c.replace(/^IFC/i, "")}`;
      selA.appendChild(new Option(label, c));
      selB.appendChild(new Option(label, c));
    }
  };

  populateCategories();
  btnRefresh.onclick = () => populateCategories();

  btnRun.onclick = async () => {
     const catsA = Array.from(selA.selectedOptions).map(o => o.value);
     const catsB = Array.from(selB.selectedOptions).map(o => o.value);
     if (!catsA.length || !catsB.length) { alert("Select at least one category in A and B."); return; }

     const clash: any = (ctx.features as any).clash;
     if (!clash) { alert("Clash engine not ready"); return; }

     if (typeof clash.clearSelectionA === "function") clash.clearSelectionA();
     if (typeof clash.clearSelectionB === "function") clash.clearSelectionB();

     const mapA: Record<string, any> = {};
     const mapB: Record<string, any> = {};

     const auth = (ctx.features as any).authoring;
     const authEls = auth?.getElements?.() ?? [];
     const nativeA = new Set<string>(); const nativeB = new Set<string>();
     for (const el of authEls) {
       const fullType = `NATIVE_${el.type.toLowerCase()}`;
       if (catsA.includes(fullType)) nativeA.add(el.id);
       if (catsB.includes(fullType)) nativeB.add(el.id);
     }
     if (nativeA.size) mapA["authored"] = nativeA;
     if (nativeB.size) mapB["authored"] = nativeB;

     const ifcCatsA = catsA.filter(c => !c.startsWith("NATIVE_"));
     const ifcCatsB = catsB.filter(c => !c.startsWith("NATIVE_"));

     for (const [modelId, model] of ctx.fragments.list) {
       try {
         if (ifcCatsA.length) {
           const itemsA = await (model as any).getItemsOfCategories(ifcCatsA.map(c => new RegExp("^" + c + "$", "i")));
           if (itemsA) {
              for (const [cat, ids] of Object.entries(itemsA)) {
                 if (ifcCatsA.some(c => c.toUpperCase() === cat.toUpperCase())) {
                   if (!mapA[modelId]) mapA[modelId] = new Set();
                   (ids as number[]).forEach(id => mapA[modelId].add(id));
                 }
              }
           }
         }
         if (ifcCatsB.length) {
           const itemsB = await (model as any).getItemsOfCategories(ifcCatsB.map(c => new RegExp("^" + c + "$", "i")));
           if (itemsB) {
              for (const [cat, ids] of Object.entries(itemsB)) {
                 if (ifcCatsB.some(c => c.toUpperCase() === cat.toUpperCase())) {
                   if (!mapB[modelId]) mapB[modelId] = new Set();
                   (ids as number[]).forEach(id => mapB[modelId].add(id));
                 }
              }
           }
         }
       } catch (e) { console.warn(e); }
     }

     if (typeof clash.setSelectionA === "function") clash.setSelectionA(mapA);
     if (typeof clash.setSelectionB === "function") clash.setSelectionB(mapB);
     if (typeof clash.runElementClashDetection === "function") await clash.runElementClashDetection();
     
     // Optionally close modal after run
     // modalEl?.remove(); modalEl = null;
  };
}