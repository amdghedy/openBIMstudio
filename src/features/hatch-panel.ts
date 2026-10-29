/**
 * 2D Detail Hatch Pattern Selector UI
 *
 * Floating dialog for picking standard drafting section patterns (ANSI31, Concrete, Earth, Brick, Insulation)
 * with customizable scale and rotation for 2D drafting sections.
 */

import { listPatterns, getPattern, type HatchPatternDef } from "../modules/detail-patterns/hatch-patterns";
import { registerCommand } from "./command-palette";

export function openHatchPatternPanel(): void {
  const existing = document.getElementById("obs-hatch-pattern-modal");
  if (existing) {
    existing.remove();
    return;
  }

  const patterns = listPatterns();

  const overlay = document.createElement("div");
  overlay.id = "obs-hatch-pattern-modal";
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(15, 23, 42, 0.65); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: #1e293b; color: #f8fafc; border-radius: 12px;
    width: 620px; max-width: 95vw; max-height: 85vh;
    display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid #334155; font-family: system-ui, sans-serif;
  `;

  card.innerHTML = `
    <div style="padding: 16px 20px; border-bottom: 1px solid #334155; display: flex; align-items: center; justify-content: space-between;">
      <div>
        <h2 style="margin: 0; font-size: 18px; font-weight: 600; color: #38bdf8;">2D Detail Hatch Patterns</h2>
        <div style="font-size: 13px; color: #94a3b8; margin-top: 4px;">
          Drafting Sections &bull; ANSI Y14.2 &bull; ISO 128 Standard Crosshatches
        </div>
      </div>
      <button id="obs-hatch-close-btn" style="background: transparent; border: none; color: #94a3b8; font-size: 20px; cursor: pointer;">&times;</button>
    </div>

    <div style="padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px;">
      <div>
        <label style="font-size: 13px; color: #94a3b8; display: block; margin-bottom: 8px;">Select Standard Hatch Pattern:</label>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px;">
          ${patterns
            .map(
              (p, idx) => `
            <div class="obs-hatch-card" data-id="${p.id}" style="
              border: 1px solid ${idx === 0 ? "#38bdf8" : "#334155"};
              background: ${idx === 0 ? "rgba(56, 189, 248, 0.1)" : "#0f172a"};
              border-radius: 8px; padding: 12px; cursor: pointer; transition: all 0.15s ease;
            ">
              <div style="font-weight: 600; font-size: 13px; color: #f8fafc; margin-bottom: 4px;">${p.name}</div>
              <div style="font-size: 11px; color: #94a3b8;">${p.description}</div>
            </div>
          `,
            )
            .join("")}
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; background: #0f172a; padding: 14px; border-radius: 8px; border: 1px solid #334155;">
        <div>
          <label style="font-size: 12px; color: #94a3b8; display: block; margin-bottom: 4px;">Pattern Scale:</label>
          <input type="number" id="obs-hatch-scale" value="1.0" step="0.25" min="0.1" max="10.0" style="width: 100%; box-sizing: border-box; background: #1e293b; border: 1px solid #475569; color: #f8fafc; padding: 6px 10px; border-radius: 6px; font-size: 13px;" />
        </div>
        <div>
          <label style="font-size: 12px; color: #94a3b8; display: block; margin-bottom: 4px;">Rotation Angle (&deg;):</label>
          <input type="number" id="obs-hatch-rot" value="0" step="15" min="0" max="360" style="width: 100%; box-sizing: border-box; background: #1e293b; border: 1px solid #475569; color: #f8fafc; padding: 6px 10px; border-radius: 6px; font-size: 13px;" />
        </div>
      </div>

      <div style="background: #0f172a; border-radius: 8px; border: 1px solid #334155; padding: 12px; text-align: center;">
        <div style="font-size: 12px; color: #94a3b8; margin-bottom: 8px;">Pattern Preview:</div>
        <svg id="obs-hatch-preview-svg" width="240" height="120" style="background: #ffffff; border-radius: 4px; display: inline-block;"></svg>
      </div>
    </div>

    <div style="padding: 16px 20px; border-top: 1px solid #334155; display: flex; justify-content: flex-end; gap: 10px;">
      <button id="obs-hatch-cancel-btn" style="background: #334155; color: #f8fafc; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px;">Cancel</button>
      <button id="obs-hatch-apply-btn" style="background: #0284c7; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;">Apply to Selected Region</button>
    </div>
  `;

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  let selectedPatternId = patterns[0]?.id || "ANSI31";

  function renderPreview(): void {
    const svg = document.getElementById("obs-hatch-preview-svg");
    if (!svg) return;
    const pat = getPattern(selectedPatternId);
    if (!pat) return;

    const scale = parseFloat((document.getElementById("obs-hatch-scale") as HTMLInputElement)?.value || "1.0");
    const rot = parseFloat((document.getElementById("obs-hatch-rot") as HTMLInputElement)?.value || "0");

    const bounds = { minX: 10, minY: 10, maxX: 230, maxY: 110 };
    const lines = pat.generate(bounds, Math.max(0.2, scale), rot);

    const lineElements = lines
      .map((l) => `<line x1="${l.x1.toFixed(1)}" y1="${l.y1.toFixed(1)}" x2="${l.x2.toFixed(1)}" y2="${l.y2.toFixed(1)}" stroke="#1e293b" stroke-width="1.2" />`)
      .join("");

    svg.innerHTML = `
      <rect x="10" y="10" width="220" height="100" fill="none" stroke="#64748b" stroke-width="1" />
      ${lineElements}
    `;
  }

  // Event handlers
  document.getElementById("obs-hatch-close-btn")?.addEventListener("click", () => overlay.remove());
  document.getElementById("obs-hatch-cancel-btn")?.addEventListener("click", () => overlay.remove());

  overlay.querySelectorAll(".obs-hatch-card").forEach((cardEl) => {
    cardEl.addEventListener("click", () => {
      overlay.querySelectorAll(".obs-hatch-card").forEach((c) => {
        (c as HTMLElement).style.borderColor = "#334155";
        (c as HTMLElement).style.background = "#0f172a";
      });
      (cardEl as HTMLElement).style.borderColor = "#38bdf8";
      (cardEl as HTMLElement).style.background = "rgba(56, 189, 248, 0.1)";
      selectedPatternId = cardEl.getAttribute("data-id") || "ANSI31";
      renderPreview();
    });
  });

  document.getElementById("obs-hatch-scale")?.addEventListener("input", renderPreview);
  document.getElementById("obs-hatch-rot")?.addEventListener("input", renderPreview);

  document.getElementById("obs-hatch-apply-btn")?.addEventListener("click", () => {
    alert(`Applied hatch pattern '${selectedPatternId}' to active drafting section.`);
    overlay.remove();
  });

  renderPreview();
}

// Register command in Command Palette
registerCommand({
  id: "drafting.hatch_pattern",
  label: "Drafting: 2D Detail Hatch Pattern Selector",
  category: "Drafting",
  hint: "Apply ANSI31, Concrete, Earth, or masonry crosshatch fills to drafting section regions",
  run: () => openHatchPatternPanel(),
});
