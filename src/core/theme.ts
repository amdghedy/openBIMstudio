import { ctx } from "./context";

export type ThemeMode = "dark" | "light";

const THEME_KEY = "obs.theme.mode";

function injectThemeCSS() {
  if (document.getElementById("obs-theme-css")) return;
  const style = document.createElement("style");
  style.id = "obs-theme-css";
  style.textContent = `
    /* LIGHT THEME OVERRIDES */
    [data-theme="light"] {
      --bg-base: #f8fafc !important;
      --bg-elevated: #ffffff !important;
      --bg-floating: #ffffff !important;
      --bg-inset: #f1f5f9 !important;
      --text-primary: #0f172a !important;
      --text-secondary: #475569 !important;
      --text-tertiary: #94a3b8 !important;
      --border-default: #cbd5e1 !important;
      --border-subtle: #e2e8f0 !important;
      --accent: #2563eb !important;
      --accent-dim: rgba(37,99,235,0.1) !important;
    }
    
    [data-theme="light"] .obs-ribbon { background: #ffffff !important; border-bottom: 1px solid #cbd5e1 !important; }
    [data-theme="light"] .obs-ribbon__tabs { background: #f1f5f9 !important; }
    [data-theme="light"] .obs-ribbon__strip { background: #ffffff !important; }
    [data-theme="light"] .obs-panel { background: #ffffff !important; border-color: #cbd5e1 !important; }
    [data-theme="light"] .obs-panel-header { background: #f8fafc !important; color: #0f172a !important; border-bottom: 1px solid #cbd5e1 !important; }
    [data-theme="light"] .bb-status { background: #f8fafc !important; border-top: 1px solid #cbd5e1 !important; color: #475569 !important; }
    [data-theme="light"] input, [data-theme="light"] select { background: #ffffff !important; color: #0f172a !important; border-color: #cbd5e1 !important; }
  `;
  document.head.appendChild(style);
}

export function setTheme(mode: ThemeMode) {
  injectThemeCSS();
  document.documentElement.setAttribute("data-theme", mode);
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* */ }

  // Update 3D Background
  if (ctx.world?.scene?.three) {
    import("../features/view-graphics").then((m) => {
      m.setSceneBackground(mode === "light" ? "paper" : "studio");
    });
  }
}

export function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  setTheme(next);
  window.dispatchEvent(new CustomEvent("obs-toast", {
    detail: { message: `Switched to ${next.toUpperCase()} mode`, kind: "info" }
  }));
}

export function bootTheme() {
  const saved = (localStorage.getItem(THEME_KEY) as ThemeMode) || "dark";
  setTheme(saved);
}
