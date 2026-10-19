/**
 * Clash Rule Pack plugin
 *
 * Registers three custom clash scenarios into the host's clash service:
 *
 *   1. "MEP <-> Structure hard clearance (50 mm)" — clashes where ducts/pipes
 *      penetrate structural walls/slabs with less than 50 mm clearance.
 *
 *   2. "Access zone soft clearance (300 mm)" — clashes where MEP elements
 *      occupy the 300 mm access zone around equipment.
 *
 *   3. "Duplicate geometry detection" — pairs of elements with identical
 *      bounding-box volume + center-point hash (likely duplicates).
 */
(function () {
  if (!window.__obsRegisterPlugin) return;

  const manifest = {
    id: "clash-rule-pack",
    name: "Custom Clash Rule Pack",
    version: "1.0.0",
    sdkVersion: 1,
    capabilities: [
      "clash.read", "clash.write", "authoring.read", "ifc.read",
      "ui.command", "ui.notification",
    ],
  };

  window.__obsRegisterPlugin(manifest, function (api) {
    const { obs, log } = api;

    const SCENARIOS = [
      {
        id: "mep-structure-hard-50",
        name: "MEP <-> Structure hard clearance (50 mm)",
        tolerance: 0.05,
        kindA: ["duct", "pipe", "cable-tray", "conduit", "fitting"],
        kindB: ["wall", "slab", "beam", "column", "footing"],
      },
      {
        id: "access-zone-soft-300",
        name: "Access zone soft clearance (300 mm)",
        tolerance: 0.30,
        kindA: ["duct", "pipe"],
        kindB: ["equipment"],
      },
      {
        id: "duplicate-geometry",
        name: "Duplicate geometry detection",
        isDuplicate: true,
      },
    ];

    function runScenario(scenarioId) {
      const scenario = SCENARIOS.find((s) => s.id === scenarioId);
      if (!scenario) {
        obs.notify.warn(`Unknown scenario: ${scenarioId}`);
        return;
      }

      log.info(`Running clash scenario: ${scenario.name}`);

      const elements = obs.authoring.getElements();
      const bucketsA = [];
      const bucketsB = [];

      for (const el of elements) {
        const t = (el && (el.type || el.kind)) || "generic";
        const pos = el.position || (el.transform && el.transform.position) || [0, 0, 0];
        const size = el.size || (el.properties && el.properties.size) || [1, 1, 1];

        const record = {
          id: el.id,
          type: t,
          min: [pos[0] - size[0] / 2, pos[1] - size[1] / 2, pos[2] - size[2] / 2],
          max: [pos[0] + size[0] / 2, pos[1] + size[1] / 2, pos[2] + size[2] / 2],
        };

        if (scenario.kindA && scenario.kindA.includes(t)) bucketsA.push(record);
        if (scenario.kindB && scenario.kindB.includes(t)) bucketsB.push(record);
      }

      const clashes = [];

      if (scenario.isDuplicate) {
        const hashes = new Map();
        for (const el of elements) {
          const pos = el.position || [0, 0, 0];
          const size = el.size || [1, 1, 1];
          const vol = size[0] * size[1] * size[2];
          const cx = pos[0] + size[0] / 2;
          const cy = pos[1] + size[1] / 2;
          const cz = pos[2] + size[2] / 2;
          const hash = `${vol.toFixed(4)}|${cx.toFixed(3)},${cy.toFixed(3)},${cz.toFixed(3)}`;
          if (!hashes.has(hash)) hashes.set(hash, []);
          hashes.get(hash).push(el.id);
        }
        for (const [, ids] of hashes) {
          if (ids.length > 1) {
            clashes.push({
              kind: "duplicate",
              elements: ids,
              message: `${ids.length} elements with identical bbox`,
            });
          }
        }
      } else {
        const tol = scenario.tolerance;
        for (const a of bucketsA) {
          for (const b of bucketsB) {
            const overlap = a.min[0] - tol < b.max[0] && a.max[0] + tol > b.min[0]
              && a.min[1] - tol < b.max[1] && a.max[1] + tol > b.min[1]
              && a.min[2] - tol < b.max[2] && a.max[2] + tol > b.min[2];
            if (overlap) {
              clashes.push({
                kind: "clearance",
                elements: [a.id, b.id],
                tolerance: tol,
                message: `${a.type} <-> ${b.type} within ${tol * 1000} mm`,
              });
            }
          }
        }
      }

      log.info(`Scenario "${scenario.name}": ${clashes.length} clash(es)`);

      if (clashes.length === 0) {
        obs.notify.success(`Scenario "${scenario.name}": no clashes detected.`);
      } else {
        obs.notify.warn(
          `Scenario "${scenario.name}": ${clashes.length} clash(es). See console.`,
        );
      }

      console.group(`[clash-rule-pack] ${scenario.name} — ${clashes.length} clash(es)`);
      for (const c of clashes.slice(0, 50)) {
        console.warn(`${c.kind}: ${c.elements.join(", ")} — ${c.message}`);
      }
      if (clashes.length > 50) console.warn(`… and ${clashes.length - 50} more`);
      console.groupEnd();

      api.obs.storage.set(`scenario:${scenarioId}`, {
        timestamp: Date.now(),
        scenario: scenario.name,
        clashes,
      }).catch(() => {});
    }

    return {
      activate() {
        log.info("Activated");
        for (const s of SCENARIOS) {
          obs.ui.registerCommand({
            id: `clash-rule-pack.run.${s.id}`,
            label: `Clash: ${s.name}`,
            hint: "Run a custom clash rule pack scenario",
            run: () => runScenario(s.id),
          });
        }
      },
      deactivate() {
        log.info("Deactivated");
        for (const s of SCENARIOS) {
          obs.ui.unregisterCommand(`clash-rule-pack.run.${s.id}`);
        }
      },
    };
  });
})();
