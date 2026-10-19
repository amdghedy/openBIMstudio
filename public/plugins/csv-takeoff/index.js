/**
 * CSV Take-Off plugin
 *
 * Builds a quantity take-off table grouped by IFC class and exports to CSV.
 * Combines:
 *   - Authored elements (from authoring service) — exact parametric
 *   - IFC entities (from loaded models) — Qto_*BaseQuantities psets
 *
 * Output CSV columns:
 *   IfcClass, Count, Length (m), Area (m^2), Volume (m^3), Notes
 */
(function () {
  if (!window.__obsRegisterPlugin) return;

  const manifest = {
    id: "csv-takeoff",
    name: "CSV Quantity Take-Off",
    version: "1.0.0",
    sdkVersion: 1,
    capabilities: [
      "cost.read", "authoring.read", "ifc.read",
      "ui.command", "ui.notification", "fs.local",
    ],
  };

  window.__obsRegisterPlugin(manifest, function (api) {
    const { obs, log } = api;

    function classifyElementType(type) {
      const t = (type || "").toLowerCase();
      if (t.includes("wall")) return "IfcWall";
      if (t.includes("slab") || t.includes("floor")) return "IfcSlab";
      if (t.includes("column")) return "IfcColumn";
      if (t.includes("beam")) return "IfcBeam";
      if (t.includes("door")) return "IfcDoor";
      if (t.includes("window")) return "IfcWindow";
      if (t.includes("roof")) return "IfcRoof";
      if (t.includes("duct")) return "IfcDuctSegment";
      if (t.includes("pipe")) return "IfcPipeSegment";
      if (t.includes("fitting")) return "IfcFlowFitting";
      return "IfcBuildingElement";
    }

    function buildTakeoff() {
      log.info("Building take-off…");

      const buckets = new Map(); // ifcClass -> {count, length, area, volume, notes}

      function bucket(cls) {
        if (!buckets.has(cls)) {
          buckets.set(cls, { count: 0, length: 0, area: 0, volume: 0, notes: [] });
        }
        return buckets.get(cls);
      }

      const authored = obs.authoring.getElements();
      for (const el of authored) {
        const t = (el && (el.type || el.kind)) || "generic";
        const cls = classifyElementType(t);
        const b = bucket(cls);
        b.count++;
        const props = (el && el.properties) || {};
        if (typeof props.length === "number") b.length += props.length;
        if (typeof props.height === "number" && typeof props.thickness === "number") {
          b.area += (props.length || 0) * props.height;
          b.volume += (props.length || 0) * props.height * props.thickness;
        }
        if (typeof props.area === "number") b.area += props.area;
        if (typeof props.volume === "number") b.volume += props.volume;
      }

      const models = obs.ifc.getModels();
      for (const model of models) {
        const modelId = model.id ?? model.expressId ?? String(model);
        const entities = obs.ifc.getEntities(modelId);
        for (const ent of entities) {
          const cls = ent.type || ent.Type || "IfcBuildingElement";
          if (!/^Ifc/.test(cls)) continue;
          const b = bucket(cls);
          b.count++;
          const qto = ent.QtoBaseQuantities || ent.qto || {};
          if (typeof qto.Length === "number") b.length += qto.Length;
          if (typeof qto.Area === "number") b.area += qto.Area;
          if (typeof qto.Volume === "number") b.volume += qto.Volume;
          if (typeof qto.NetVolume === "number") b.volume += qto.NetVolume;
        }
      }

      const rows = [["IfcClass", "Count", "Length (m)", "Area (m^2)", "Volume (m^3)", "Notes"]];
      const sorted = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count);
      for (const [cls, agg] of sorted) {
        rows.push([
          cls,
          String(agg.count),
          agg.length.toFixed(3),
          agg.area.toFixed(3),
          agg.volume.toFixed(3),
          agg.notes.join("; "),
        ]);
      }

      const csv = rows
        .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
        .join("\r\n");

      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `takeoff-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      api.obs.storage.set("last-takeoff", {
        timestamp: Date.now(),
        buckets: sorted.map(([cls, agg]) => ({ cls, ...agg })),
      }).catch(() => {});

      const total = sorted.reduce((s, [, agg]) => s + agg.count, 0);
      obs.notify.success(`Take-off exported: ${sorted.length} IFC class(es), ${total} element(s).`);
      log.info(`Exported ${rows.length - 1} rows, ${total} elements`);
    }

    return {
      activate() {
        log.info("Activated");
        obs.ui.registerCommand({
          id: "csv-takeoff.export",
          label: "Export Quantity Take-Off (CSV)",
          hint: "Group elements by IFC class and export count, length, area, volume to CSV",
          run: buildTakeoff,
        });
      },
      deactivate() {
        log.info("Deactivated");
        obs.ui.unregisterCommand("csv-takeoff.export");
      },
    };
  });
})();
