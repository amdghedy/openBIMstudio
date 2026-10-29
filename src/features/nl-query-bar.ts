/**
 * Natural Language BIM Query Bar UI.
 *
 * Provides a spotlight / command bar interface for natural language BIM querying.
 */

import { parseNLQuery } from "../modules/nl-query/parser";
import { executeNLQuery } from "../modules/nl-query/executor";
import { QUICK_QUERIES, saveQuery } from "../modules/nl-query/saved-queries";
import { registerCommand } from "./command-palette";

export function openNLQueryModal(): void {
  const existing = document.getElementById("obs-nl-query-spotlight");
  if (existing) {
    existing.remove();
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = "obs-nl-query-spotlight";
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(15, 23, 42, 0.65); backdrop-filter: blur(4px);
    display: flex; align-items: flex-start; justify-content: center;
    padding-top: 15vh;
  `;

  const box = document.createElement("div");
  box.style.cssText = `
    background: #1e293b; color: #f8fafc; border-radius: 12px;
    width: 640px; max-width: 95vw; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.7);
    border: 1px solid #38bdf8; overflow: hidden; font-family: system-ui, sans-serif;
  `;

  box.innerHTML = `
    <div style="padding: 16px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #334155;">
      <span style="font-size: 20px;">🔍</span>
      <input id="obs-nl-input" type="text" placeholder="Ask your model... (e.g. 'show walls thicker than 200mm')"
        style="flex: 1; background: transparent; border: none; outline: none; font-size: 16px; color: white;">
      <kbd style="background: #334155; padding: 2px 6px; border-radius: 4px; font-size: 11px; color: #94a3b8;">ESC</kbd>
    </div>

    <div id="obs-nl-preview" style="padding: 10px 16px; background: #0f172a; font-size: 13px; color: #38bdf8; border-bottom: 1px solid #334155; display: none;">
      <!-- Real-time AST interpretation preview -->
    </div>

    <div style="padding: 12px 16px; max-height: 260px; overflow-y: auto;">
      <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: #64748b; margin-bottom: 8px;">
        Quick Query Presets
      </div>
      <div style="display: flex; flex-direction: column; gap: 4px;">
        ${QUICK_QUERIES.map(
          (q) => `
          <div class="obs-nl-preset" data-query="${q.query}" style="padding: 8px 12px; border-radius: 6px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; background: #1e293b;">
            <span style="font-size: 14px; color: #f8fafc;">${q.label}</span>
            <span style="font-size: 11px; color: #94a3b8; background: #334155; padding: 2px 6px; border-radius: 4px;">${q.category}</span>
          </div>
        `
        ).join("")}
      </div>
    </div>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const input = box.querySelector("#obs-nl-input") as HTMLInputElement;
  const preview = box.querySelector("#obs-nl-preview") as HTMLElement;

  input.focus();

  // Esc to close
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") overlay.remove();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  // Live preview as user types
  input.addEventListener("input", () => {
    const val = input.value.trim();
    if (!val) {
      preview.style.display = "none";
      return;
    }
    const parsed = parseNLQuery(val);
    preview.style.display = "block";
    preview.innerHTML = `<strong>Interpreted:</strong> ${parsed.interpretedSummary}`;
  });

  // Enter to execute
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const val = input.value.trim();
      if (val) {
        saveQuery(val);
        executeNLQuery(val);
        overlay.remove();
      }
    }
  });

  // Click on presets
  box.querySelectorAll(".obs-nl-preset").forEach((el) => {
    el.addEventListener("mouseenter", () => ((el as HTMLElement).style.background = "#334155"));
    el.addEventListener("mouseleave", () => ((el as HTMLElement).style.background = "#1e293b"));
    el.addEventListener("click", () => {
      const q = el.getAttribute("data-query");
      if (q) {
        executeNLQuery(q);
        overlay.remove();
      }
    });
  });
}

try {
  registerCommand({
    id: "ai.nlQuery",
    label: "AI — Natural Language Model Query (Spotlight)",
    category: "AI",
    run: () => openNLQueryModal(),
  });
} catch {
  /* command palette deferred */
}
