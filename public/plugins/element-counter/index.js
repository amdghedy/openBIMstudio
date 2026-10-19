/**
 * Element Counter plugin
 *
 * Registers a dockable panel showing live element counts grouped by type.
 * Updates when the authoring model changes or the user's selection changes.
 */
(function () {
  if (!window.__obsRegisterPlugin) return;

  const manifest = {
    id: "element-counter",
    name: "Element Counter",
    version: "1.0.0",
    sdkVersion: 1,
    capabilities: ["authoring.read", "selection.read", "ui.panel", "ui.notification"],
  };

  window.__obsRegisterPlugin(manifest, function (api) {
    const { obs, log } = api;

    let unsubscribeAuthoring = null;
    let unsubscribeSelection = null;
    let rootEl = null;

    function render(container) {
      rootEl = container;
      container.innerHTML = `
        <div style="font-family: Inter, system-ui, sans-serif; font-size: 13px; color: #151513; padding: 12px;">
          <div style="font-weight: 700; margin-bottom: 8px; letter-spacing: 0.3px; text-transform: uppercase; font-size: 11px; color: #7e7c74;">
            Element Counter
          </div>
          <div id="element-counter-stats" style="display: grid; grid-template-columns: 1fr auto; gap: 4px 12px;">
            <div style="color: #7e7c74;">Loading…</div>
          </div>
          <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #e5e5e2; font-size: 11px; color: #7e7c74;">
            Selection: <span id="element-counter-selection">0</span>
          </div>
        </div>
      `;

      update();
      unsubscribeAuthoring = obs.authoring.onChange(update);
      unsubscribeSelection = obs.selection.onChange(updateSelection);
    }

    function update() {
      if (!rootEl) return;
      const statsEl = rootEl.querySelector("#element-counter-stats");
      if (!statsEl) return;

      const elements = obs.authoring.getElements();
      const counts = new Map();
      for (const el of elements) {
        const t = (el && (el.type || el.kind)) || "unknown";
        counts.set(t, (counts.get(t) || 0) + 1);
      }

      if (counts.size === 0) {
        statsEl.innerHTML = `<div style="color: #7e7c74; grid-column: 1 / -1;">No elements in scene.</div>`;
        return;
      }

      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      statsEl.innerHTML = sorted.map(function (entry) {
        const type = entry[0];
        const n = entry[1];
        return (
          "<div style='text-transform: capitalize;'>" + type + "</div>" +
          "<div style='text-align: right; font-variant-numeric: tabular-nums; font-weight: 600;'>" + n + "</div>"
        );
      }).join("");

      updateSelection();
    }

    function updateSelection() {
      if (!rootEl) return;
      const selEl = rootEl.querySelector("#element-counter-selection");
      if (selEl) selEl.textContent = String(obs.selection.size());
    }

    return {
      activate: function () {
        log.info("Activated");
        obs.ui.registerPanel("element-counter", {
          id: "element-counter",
          title: "Element Counter",
          icon: "#",
          render: render,
          destroy: function () {
            if (unsubscribeAuthoring) unsubscribeAuthoring();
            if (unsubscribeSelection) unsubscribeSelection();
            unsubscribeAuthoring = null;
            unsubscribeSelection = null;
            rootEl = null;
          },
        });
      },
      deactivate: function () {
        log.info("Deactivated");
        obs.ui.unregisterPanel("element-counter");
        if (unsubscribeAuthoring) unsubscribeAuthoring();
        if (unsubscribeSelection) unsubscribeSelection();
        rootEl = null;
      },
    };
  });
})();
