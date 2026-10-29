/**
 * Revision Compare & Delta Toolbar.
 *
 * Provides a floating pill in the viewport to compare revision stages.
 */

import { listAllRevisions } from "../modules/revisions/model";
import { getElementsChangedBetween, applyRevisionFilter, clearRevisionFilter } from "../modules/revisions/filter";

let toolbarEl: HTMLElement | null = null;

export function showRevisionFilterToolbar(): void {
  if (toolbarEl) toolbarEl.remove();

  const revs = listAllRevisions();
  if (revs.length < 2) {
    window.dispatchEvent(
      new CustomEvent("obs-toast", {
        detail: { message: "Define at least 2 revisions to enable compare mode.", kind: "info" },
      })
    );
    return;
  }

  toolbarEl = document.createElement("div");
  toolbarEl.id = "obs-revision-filter-pill";
  toolbarEl.style.cssText = `
    position: fixed; top: 70px; left: 50%; transform: translateX(-50%);
    z-index: 8000; background: #0f172a; color: white; border: 1px solid #38bdf8;
    border-radius: 9999px; padding: 6px 16px; display: flex; align-items: center;
    gap: 10px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.5); font-family: system-ui, sans-serif;
    font-size: 13px;
  `;

  toolbarEl.innerHTML = `
    <span style="color: #38bdf8; font-weight: 600;">Compare:</span>
    <select id="obs-rev-from" style="background: #1e293b; color: white; border: 1px solid #475569; padding: 2px 6px; border-radius: 4px;">
      ${revs.map((r, i) => `<option value="${r.id}" ${i === 0 ? "selected" : ""}>${r.sequenceLabel}</option>`).join("")}
    </select>
    <span>&rarr;</span>
    <select id="obs-rev-to" style="background: #1e293b; color: white; border: 1px solid #475569; padding: 2px 6px; border-radius: 4px;">
      ${revs.map((r, i) => `<option value="${r.id}" ${i === revs.length - 1 ? "selected" : ""}>${r.sequenceLabel}</option>`).join("")}
    </select>
    <button id="obs-rev-compare-btn" style="background: #0284c7; color: white; border: none; padding: 4px 10px; border-radius: 9999px; cursor: pointer; font-size: 12px; font-weight: 600;">Highlight Delta</button>
    <button id="obs-rev-close-btn" style="background: transparent; border: none; color: #94a3b8; font-size: 16px; cursor: pointer; padding: 0 4px;">&times;</button>
  `;

  document.body.appendChild(toolbarEl);

  toolbarEl.querySelector("#obs-rev-close-btn")?.addEventListener("click", () => {
    clearRevisionFilter();
    toolbarEl?.remove();
    toolbarEl = null;
  });

  toolbarEl.querySelector("#obs-rev-compare-btn")?.addEventListener("click", () => {
    const fromId = (toolbarEl?.querySelector("#obs-rev-from") as HTMLSelectElement).value;
    const toId = (toolbarEl?.querySelector("#obs-rev-to") as HTMLSelectElement).value;
    const changed = getElementsChangedBetween(fromId, toId);
    applyRevisionFilter(changed);
    window.dispatchEvent(
      new CustomEvent("obs-toast", {
        detail: { message: `Highlighted ${changed.length} altered elements between selected revisions.`, kind: "info" },
      })
    );
  });
}
