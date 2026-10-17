/**
 * Parametric ribbon tab + parity tools.
 * Adds a top-level "Parametric" tab to .obs-ribbon with:
 *   Families | Constraints | Architecture generators | CAD 2D | Drawings DXF/DWG
 * Hides bottom parity bars.
 */

type Any = Record<string, any>;

let installed = false;
let stripObserver: MutationObserver | null = null;
let parametricActive = false;
let savedStrip: Node[] | null = null;

function hideBottomBars(): void {
  const hide = (el: Element | null) => {
    if (!el) return;
    const h = el as HTMLElement;
    h.style.display = "none";
    h.setAttribute("data-parity-ribbon-migrated", "1");
  };
  hide(document.getElementById("obs-parity-tabs"));
  hide(document.getElementById("obs-adv-toolbar"));
  document.querySelectorAll(".obs-adv-toolbar").forEach(hide);
  document.querySelectorAll("[id^=obs-][id$=-launch]").forEach(hide);
}

function clickAdv(id: string): void {
  document.getElementById(id)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Any)[c],
  );
}

function makeBtn(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.className = "obs-rb";
  el.type = "button";
  el.title = title || label;
  el.setAttribute("aria-label", label);
  el.dataset.parityInject = "1";
  el.dataset.parametric = "1";
  el.innerHTML =
    `<span class="obs-rb__icon" style="font:700 10px/1 ui-monospace,monospace;opacity:.85">${esc(
      label.slice(0, 2).toUpperCase(),
    )}</span>` + `<span class="obs-rb__label">${esc(label)}</span>`;
  el.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      onClick();
    } catch (err) {
      console.warn("[parametric-tab]", err);
    }
  };
  return el;
}

function sep(): HTMLElement {
  const d = document.createElement("div");
  d.className = "obs-rb-sep";
  d.dataset.parityInject = "1";
  d.dataset.parametric = "1";
  d.style.cssText = "width:1px;align-self:stretch;background:#2a2e3a;margin:4px 6px";
  return d;
}

function groupLabel(text: string): HTMLElement {
  const s = document.createElement("span");
  s.className = "obs-rb-group";
  s.dataset.parityInject = "1";
  s.dataset.parametric = "1";
  s.textContent = text;
  s.style.cssText =
    "font:700 9px/1 Inter,system-ui;letter-spacing:.5px;text-transform:uppercase;color:#6b7280;padding:0 4px;align-self:center";
  return s;
}

function parametricTools(): HTMLElement[] {
  const out: HTMLElement[] = [];

  // Families / parametric engine
  out.push(groupLabel("Families"));
  out.push(
    makeBtn("Family Panel", "Parametric families (Ctrl+Shift+F)", () =>
      (window as Any).__obsParamFamilyPanel?.toggle?.(),
    ),
  );
  out.push(
    makeBtn("Place Door", "Sample parametric door", () =>
      (window as Any).__obsParamFamilyPanel?.placeSample?.() ??
      clickAdv("obs-adv-stair"),
    ),
  );
  out.push(
    makeBtn("Solve", "Constraint / formula solver", () => clickAdv("obs-adv-solve")),
  );
  out.push(
    makeBtn("Hosts", "Recompute hosted openings", () => clickAdv("obs-adv-hosts")),
  );

  out.push(sep());
  out.push(groupLabel("Architecture"));
  out.push(makeBtn("Stair", "Parametric stair", () => clickAdv("obs-adv-stair")));
  out.push(makeBtn("Railing", "Parametric railing", () => clickAdv("obs-adv-rail")));
  out.push(makeBtn("Curtain", "Curtain wall system", () => clickAdv("obs-adv-cw")));
  out.push(makeBtn("Room", "Create room", () => clickAdv("obs-adv-room")));
  out.push(makeBtn("Rooms", "Rooms panel", () => clickAdv("obs-adv-rooms-panel")));
  out.push(makeBtn("Phases", "Phases", () => clickAdv("obs-adv-phases")));
  out.push(makeBtn("Options", "Design options", () => clickAdv("obs-adv-opts")));
  out.push(makeBtn("Group", "Model group", () => clickAdv("obs-adv-group")));
  out.push(makeBtn("Align", "Align", () => clickAdv("obs-adv-align")));

  out.push(sep());
  out.push(groupLabel("2D CAD"));
  out.push(
    makeBtn("CAD Tools", "CAD command panel (Ctrl+Shift+D)", () =>
      (window as Any).__obsCad?.open?.() ?? (window as Any).__obsCad?.toggle?.(),
    ),
  );
  out.push(makeBtn("Line", "CAD line", () => (window as Any).__obsCad?.setTool?.("line")));
  out.push(
    makeBtn("PLine", "Polyline", () => (window as Any).__obsCad?.setTool?.("polyline")),
  );
  out.push(makeBtn("Rect", "Rectangle", () => (window as Any).__obsCad?.setTool?.("rect")));
  out.push(makeBtn("Circle", "Circle", () => (window as Any).__obsCad?.setTool?.("circle")));
  out.push(makeBtn("Offset", "Offset", () => (window as Any).__obsCad?.setTool?.("offset")));
  out.push(makeBtn("Trim", "Trim", () => (window as Any).__obsCad?.setTool?.("trim")));
  out.push(makeBtn("Extend", "Extend", () => (window as Any).__obsCad?.setTool?.("extend")));
  out.push(makeBtn("Fillet", "Fillet", () => (window as Any).__obsCad?.setTool?.("fillet")));
  out.push(makeBtn("Mirror", "Mirror", () => (window as Any).__obsCad?.setTool?.("mirror")));
  out.push(
    makeBtn("Draft 2D", "2D drafting overlay", () => clickAdv("obs-adv-draft")),
  );

  out.push(sep());
  out.push(groupLabel("Drawings"));
  out.push(
    makeBtn("DXF / DWG", "Drawings panel (Ctrl+Shift+G)", () =>
      (window as Any).__obsDrawingsPanel?.toggle?.(),
    ),
  );
  out.push(
    makeBtn("Export DXF", "Export CAD as DXF", () =>
      (window as Any).__obsDrawings?.exportCadAsDxf?.(),
    ),
  );
  out.push(
    makeBtn("Import DXF", "Import DXF drawing", () =>
      (window as Any).__obsDrawingsPanel?.open?.(),
    ),
  );

  out.push(sep());
  out.push(groupLabel("View"));
  out.push(
    makeBtn("3D Ortho", "Toggle orthographic (VO)", () =>
      (window as Any).__obsSelPivot?.toggleOrtho?.(),
    ),
  );
  out.push(
    makeBtn("Zoom Sel", "Zoom to selection (ZO)", () =>
      void (window as Any).__obsSelPivot?.zoomToSelection?.(),
    ),
  );
  out.push(
    makeBtn("Cmd Center", "Revit Command Center", () =>
      (window as Any).__obsRevitCommandCenter?.toggle?.(),
    ),
  );

  return out;
}

function ensureParametricTab(): HTMLButtonElement | null {
  const tabsRow = document.querySelector(".obs-ribbon__tabs") as HTMLElement | null;
  if (!tabsRow) return null;

  let tab = tabsRow.querySelector('[data-tab="parametric"]') as HTMLButtonElement | null;
  if (tab) return tab;

  tab = document.createElement("button");
  tab.type = "button";
  tab.className = "obs-ribbon__tab";
  tab.dataset.tab = "parametric";
  tab.textContent = "Parametric";
  tab.title = "Parametric families, CAD 2D, Drawings DXF/DWG";
  tab.style.cssText = ""; // inherit ribbon tab styles

  // Place after Architecture if present, else append
  const arch = Array.from(tabsRow.querySelectorAll("button")).find((b) =>
    /architecture/i.test(b.textContent || ""),
  );
  if (arch && arch.nextSibling) {
    tabsRow.insertBefore(tab, arch.nextSibling);
  } else {
    tabsRow.appendChild(tab);
  }

  tab.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    activateParametricTab();
  });

  return tab;
}

function clearActiveTabs(): void {
  document.querySelectorAll(".obs-ribbon__tabs button").forEach((b) => {
    const el = b as HTMLElement;
    el.removeAttribute("data-active");
    el.dataset.active = "";
    el.classList.remove("is-active", "active");
  });
}

function activateParametricTab(): void {
  parametricActive = true;
  clearActiveTabs();
  const tab = ensureParametricTab();
  if (tab) {
    tab.dataset.active = "1";
    tab.setAttribute("data-active", "1");
    tab.classList.add("is-active");
  }

  const strip = document.querySelector(".obs-ribbon__strip") as HTMLElement | null;
  if (!strip) return;

  // Clear strip and show parametric tools only
  strip.innerHTML = "";
  for (const el of parametricTools()) strip.appendChild(el);
}

function deactivateParametricIfOtherTab(e: Event): void {
  const t = e.target as HTMLElement;
  if (!t) return;
  const btn = t.closest?.(".obs-ribbon__tabs button") as HTMLElement | null;
  if (!btn) return;
  if (btn.getAttribute("data-tab") === "parametric") return;
  // Other tab clicked - leave parametric mode; ribbon will re-render its strip
  parametricActive = false;
  const tab = document.querySelector('.obs-ribbon__tabs [data-tab="parametric"]') as HTMLElement | null;
  if (tab) {
    tab.removeAttribute("data-active");
    tab.dataset.active = "";
    tab.classList.remove("is-active");
  }
}

function inject(): void {
  hideBottomBars();
  ensureParametricTab();

  if (parametricActive) {
    activateParametricTab();
    return;
  }

  // Do not inject parity tools into other tabs anymore - they live under Parametric
  const strip = document.querySelector(".obs-ribbon__strip") as HTMLElement | null;
  if (strip) {
    strip.querySelectorAll("[data-parity-inject]").forEach((n) => n.remove());
  }
}

function watchRibbon(): void {
  const root = document.querySelector(".obs-ribbon") as HTMLElement | null;
  if (!root) {
    window.setTimeout(watchRibbon, 500);
    return;
  }

  root.addEventListener("click", deactivateParametricIfOtherTab, true);
  root.addEventListener(
    "click",
    () => {
      window.setTimeout(inject, 40);
      window.setTimeout(inject, 150);
    },
    true,
  );

  const strip = root.querySelector(".obs-ribbon__strip");
  if (strip && !stripObserver) {
    stripObserver = new MutationObserver(() => {
      if (parametricActive) {
        // Ribbon may wipe strip on re-render - restore parametric tools
        if (!strip.querySelector("[data-parametric]")) {
          window.setTimeout(() => activateParametricTab(), 20);
        }
      }
    });
    stripObserver.observe(strip, { childList: true });
  }

  inject();
  window.setTimeout(inject, 600);
  window.setTimeout(inject, 1800);
}

export function setupRibbonParityInject(): void {
  if (installed) return;
  installed = true;

  hideBottomBars();
  watchRibbon();

  const mo = new MutationObserver(() => hideBottomBars());
  mo.observe(document.body, { childList: true, subtree: true });

  (window as Any).__obsRibbonParity = {
    inject,
    hideBottomBars,
    openParametric: activateParametricTab,
  };
  (window as Any).__obsParametricTab = { open: activateParametricTab };

  console.log(
    "[ribbon-parity-inject] Parametric tab ready (families + CAD 2D + DXF/DWG)",
  );
}
