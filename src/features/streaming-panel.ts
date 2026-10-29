/**
 * Out-of-Core Streaming & Memory Optimizer Panel UI
 *
 * Real-time monitoring and control of spatial octree streaming, LOD transitions,
 * and client memory budget enforcement for massive BIM models.
 */

import { getMemoryBudgetManager } from "../modules/streaming/memory-budget-manager";
import { registerCommand } from "./command-palette";

export function openStreamingOptimizerPanel(): void {
  const existing = document.getElementById("obs-streaming-modal");
  if (existing) existing.remove();

  const manager = getMemoryBudgetManager();
  const metrics = manager.getMetrics();

  const overlay = document.createElement("div");
  overlay.id = "obs-streaming-modal";
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(15, 23, 42, 0.65); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: #1e293b; color: #f8fafc; border-radius: 12px;
    width: 680px; max-width: 95vw; max-height: 85vh;
    display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid #334155; font-family: system-ui, sans-serif;
  `;

  const memPercent = Math.min(100, metrics.memoryUsagePercent);
  const memBarColor = memPercent > 85 ? "#ef4444" : memPercent > 60 ? "#f59e0b" : "#10b981";

  card.innerHTML = `
    <div style="padding: 16px 20px; border-bottom: 1px solid #334155; display: flex; align-items: center; justify-content: space-between;">
      <div>
        <h2 style="margin: 0; font-size: 18px; font-weight: 600; color: #38bdf8;">Out-of-Core Streaming &amp; LOD Engine</h2>
        <div style="font-size: 13px; color: #94a3b8; margin-top: 4px;">
          Dynamic spatial octree partitioning &bull; Memory budget enforcement
        </div>
      </div>
      <button id="obs-stream-close-btn" style="background: transparent; border: none; color: #94a3b8; font-size: 20px; cursor: pointer;">&times;</button>
    </div>

    <div style="padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px;">
      <!-- Memory Budget Meter -->
      <div style="background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 16px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span style="font-size: 13px; font-weight: 600; color: #cbd5e1;">Client RAM Budget Allocation</span>
          <span style="font-size: 13px; font-weight: 600; color: ${memBarColor};">
            ${metrics.currentMemoryMb} MB / ${metrics.maxMemoryMb} MB (${metrics.memoryUsagePercent}%)
          </span>
        </div>
        <div style="background: #1e293b; border-radius: 6px; height: 10px; overflow: hidden; margin-bottom: 12px;">
          <div style="width: ${memPercent}%; height: 100%; background: ${memBarColor}; border-radius: 6px; transition: width 0.3s ease;"></div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <label style="font-size: 12px; color: #94a3b8; white-space: nowrap;">Max Budget Limit:</label>
          <input type="range" id="obs-stream-budget-slider" min="128" max="2048" step="64" value="${metrics.maxMemoryMb}" style="flex: 1; cursor: pointer;" />
          <span id="obs-stream-budget-label" style="font-size: 13px; font-weight: 600; min-width: 60px; text-align: right;">${metrics.maxMemoryMb} MB</span>
        </div>
      </div>

      <!-- Streaming Diagnostics Grid -->
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
        <div style="background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 14px;">
          <div style="font-size: 12px; color: #94a3b8;">Active Model Chunks</div>
          <div style="font-size: 22px; font-weight: 700; color: #f8fafc; margin-top: 4px;">
            ${metrics.residentChunks} <span style="font-size: 13px; color: #64748b; font-weight: 400;">/ ${metrics.totalChunks} total</span>
          </div>
          <div style="font-size: 11px; color: #34d399; margin-top: 4px;">
            ${metrics.visibleChunks} chunks inside view frustum
          </div>
        </div>

        <div style="background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 14px;">
          <div style="font-size: 12px; color: #94a3b8;">Cumulative Evictions (Freed)</div>
          <div style="font-size: 22px; font-weight: 700; color: #f8fafc; margin-top: 4px;">
            ${metrics.evictedCount}
          </div>
          <div style="font-size: 11px; color: #94a3b8; margin-top: 4px;">
            Distant high-poly meshes culled to proxy impostors
          </div>
        </div>
      </div>

      <!-- LOD Distribution Breakdown -->
      <div style="background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 16px;">
        <div style="font-size: 13px; font-weight: 600; color: #cbd5e1; margin-bottom: 12px;">
          Real-Time LOD Distribution
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px; font-size: 12px;">
          <div style="display: flex; justify-content: space-between;">
            <span style="color: #38bdf8;">LOD 0 (Full High-Fidelity Geometry):</span>
            <strong>${metrics.lodDistribution[0]} chunks</strong>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span style="color: #34d399;">LOD 1 (Medium / Decimated Meshes):</span>
            <strong>${metrics.lodDistribution[1]} chunks</strong>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span style="color: #f59e0b;">LOD 2 (Low-Poly Convex Hulls):</span>
            <strong>${metrics.lodDistribution[2]} chunks</strong>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span style="color: #94a3b8;">LOD 3 (Bounding Box Impostors):</span>
            <strong>${metrics.lodDistribution[3]} chunks</strong>
          </div>
        </div>
      </div>
    </div>

    <!-- Actions Footer -->
    <div style="padding: 12px 20px; background: #0f172a; border-top: 1px solid #334155; display: flex; justify-content: space-between; align-items: center;">
      <button id="obs-stream-purge-btn" style="background: #334155; color: #f8fafc; border: none; padding: 7px 14px; border-radius: 6px; cursor: pointer; font-size: 13px;">
        Force Garbage Collect &amp; Cull
      </button>
      <div id="obs-stream-msg" style="font-size: 12px; color: #38bdf8;"></div>
    </div>
  `;

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Handlers
  document.getElementById("obs-stream-close-btn")?.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const slider = document.getElementById("obs-stream-budget-slider") as HTMLInputElement | null;
  const label = document.getElementById("obs-stream-budget-label");
  const msg = document.getElementById("obs-stream-msg");

  slider?.addEventListener("input", () => {
    const val = parseInt(slider.value, 10);
    if (label) label.textContent = `${val} MB`;
    manager.setMaxMemoryMb(val);
  });

  document.getElementById("obs-stream-purge-btn")?.addEventListener("click", () => {
    const res = manager.enforceBudget();
    if (msg) {
      msg.textContent = `Purged ${res.evictedCount} distant chunks, freed ${res.memoryFreedMb.toFixed(1)} MB RAM.`;
      setTimeout(() => openStreamingOptimizerPanel(), 1000);
    }
  });
}

// Register palette command
registerCommand({
  id: "view.streaming_optimizer",
  label: "Performance: Model Streaming & Memory Budget",
  category: "Performance",
  hint: "Monitor spatial octree streaming, LOD transitions, and client RAM limits",
  run: () => openStreamingOptimizerPanel(),
});
