/**
 * M4 boot – View Templates + Visibility/Graphics + Auto-Dimensions.
 *
 * Import from critical-gaps-boot (or main) via dynamic import:
 *   await import("./features/m4-view-dims-boot").then(m => m.setupM4ViewDims());
 */

type Any = Record<string, any>;

async function safe(label: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.warn("[m4-view-dims-boot]", label, e);
  }
}

export async function setupM4ViewDims(): Promise<void> {
  await safe("view-templates", async () => {
    const m: Any = await import("../modules/view-templates/setup");
    m.setupViewTemplates?.();
  });

  await safe("auto-dimensions", async () => {
    const m: Any = await import("../modules/auto-dimensions/setup");
    m.setupAutoDimensions?.();
  });

  // Soft-patch Command Center buttons if the panel is already built
  await safe("cc-patch", async () => {
    injectCommandCenterButtons();
  });

  // Soft-patch critical-gaps bottom toolbar
  await safe("toolbar-patch", async () => {
    injectToolbarButtons();
  });

  console.log("[m4-view-dims-boot] View Templates + Auto-Dimensions wired");
}

function injectCommandCenterButtons(): void {
  const tryInject = () => {
    const cc = document.getElementById("obs-revit-cc");
    if (!cc) return false;
    const body = cc.querySelector(".rcc-body");
    if (!body) return false;
    if (body.querySelector("[data-m4-vg]")) return true;

    const sec = document.createElement("div");
    sec.className = "rcc-sec";
    sec.innerHTML = `
      <div class="rcc-sec-title">View · Annotate (M4)</div>
      <div class="rcc-grid">
        <button class="rcc-btn" data-m4-vg type="button">
          Visibility/Graphics
          <small>Ctrl+Shift+V</small>
        </button>
        <button class="rcc-btn" data-m4-tmpl type="button">
          View Templates
          <small>Apply / edit</small>
        </button>
        <button class="rcc-btn" data-m4-adim type="button">
          Auto Dimensions
          <small>Ctrl+Shift+D</small>
        </button>
        <button class="rcc-btn" data-m4-adim-run type="button">
          Auto Dim Plan
          <small>X + Y chain</small>
        </button>
      </div>`;
    body.appendChild(sec);

    sec.querySelector("[data-m4-vg]")?.addEventListener("click", () => {
      (window as Any).__obsOpenVgDialog?.();
    });
    sec.querySelector("[data-m4-tmpl]")?.addEventListener("click", () => {
      (window as Any).__obsOpenVgDialog?.();
    });
    sec.querySelector("[data-m4-adim]")?.addEventListener("click", () => {
      (window as Any).__obsOpenAutoDims?.();
    });
    sec.querySelector("[data-m4-adim-run]")?.addEventListener("click", () => {
      (window as Any).__obsAutoDimPlan?.();
    });
    return true;
  };

  if (!tryInject()) {
    const t = window.setInterval(() => {
      if (tryInject()) window.clearInterval(t);
    }, 600);
    window.setTimeout(() => window.clearInterval(t), 15000);
  }
}

function injectToolbarButtons(): void {
  const tryInject = () => {
    // Prefer existing critical-gaps bottom toolbar if present
    const bar =
      document.getElementById("obs-critical-gaps-bar") ||
      document.querySelector(".obs-bottom-toolbar") ||
      document.querySelector("[data-obs-toolbar]");
    if (!bar) return false;
    if (bar.querySelector("[data-m4-vg-btn]")) return true;

    const mk = (label: string, title: string, attr: string, fn: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.title = title;
      b.setAttribute(attr, "1");
      b.style.cssText =
        "height:28px;padding:0 10px;margin:0 2px;border-radius:6px;border:1px solid #E1DFDD;background:#fff;font:600 11px 'Segoe UI',system-ui;cursor:pointer;color:#201F1E";
      b.addEventListener("click", fn);
      b.addEventListener("mouseenter", () => {
        b.style.background = "#EDEBE9";
      });
      b.addEventListener("mouseleave", () => {
        b.style.background = "#fff";
      });
      return b;
    };

    bar.appendChild(
      mk("VG", "Visibility/Graphics (Ctrl+Shift+V)", "data-m4-vg-btn", () =>
        (window as Any).__obsOpenVgDialog?.()
      )
    );
    bar.appendChild(
      mk("Dims", "Auto Dimensions panel (Ctrl+Shift+D)", "data-m4-adim-btn", () =>
        (window as Any).__obsOpenAutoDims?.()
      )
    );
    return true;
  };

  if (!tryInject()) {
    const t = window.setInterval(() => {
      if (tryInject()) window.clearInterval(t);
    }, 700);
    window.setTimeout(() => window.clearInterval(t), 15000);
  }
}
