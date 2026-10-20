/**
 * Family-from-CSV plugin
 *
 * Generates a parametric family + named types from a CSV type catalog.
 * Mirrors BIM's "type catalog" pattern: a .txt file with parameter
 * column headers and one row per type.
 *
 * CSV format (first column is the type name):
 *   TypeName,width,height,thickness
 *   800x1000,0.8,1.0,0.05
 *   900x1200,0.9,1.2,0.05
 *   1200x1500,1.2,1.5,0.07
 */
(function () {
  if (!window.__obsRegisterPlugin) return;

  const manifest = {
    id: "family-from-csv",
    name: "Family Generator from CSV",
    version: "1.0.0",
    sdkVersion: 1,
    capabilities: ["family.read", "family.write", "ui.command", "ui.notification", "fs.local"],
  };

  window.__obsRegisterPlugin(manifest, function (api) {
    const { obs, log } = api;

    function parseCSV(text) {
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length < 2) {
        throw new Error("CSV must have a header row and at least one data row");
      }
      const split = (line) => line.split(",").map((c) => c.trim());
      const headers = split(lines[0]);
      const rows = lines.slice(1).map((line) => {
        const cells = split(line);
        const obj = {};
        headers.forEach((h, i) => { obj[h] = cells[i] ?? ""; });
        return obj;
      });
      return { headers, rows };
    }

    function buildFamilyFromCSV(familyName, csvText, ifcEntity) {
      const { headers, rows } = parseCSV(csvText);
      const typeCol = headers[0];

      const parameters = headers.slice(1).map((name) => {
        let type = "length";
        if (/count|qty|num/i.test(name)) type = "integer";
        else if (/^is[A-Z]|^has[A-Z]/i.test(name)) type = "boolean";
        return {
          name,
          type,
          scope: "instance",
          default: 0.1,
          editable: true,
          step: 0.01,
          unit: type === "length" ? "m" : undefined,
          group: "Dimensions",
        };
      });

      const types = rows.map((row, idx) => ({
        id: `${familyName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-type-${idx + 1}`,
        name: String(row[typeCol]),
        values: headers.slice(1).reduce((acc, h) => {
          const v = parseFloat(row[h]);
          acc[h] = isNaN(v) ? row[h] : v;
          return acc;
        }, {}),
      }));

      const ref = (n) => ({ ref: n });
      const c = (n) => ({ const: n });
      const wRef = parameters[0] ? ref(parameters[0].name) : c(1);
      const hRef = parameters[1] ? ref(parameters[1].name) : c(1);
      const dRef = parameters[2] ? ref(parameters[2].name) : c(1);

      const familyDef = {
        id: `csv-${familyName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`,
        name: familyName,
        category: "generic",
        ifcEntity: ifcEntity || "IfcBuildingElementProxy",
        schemaVersion: 1,
        builtIn: false,
        parameters,
        geometry: { kind: "box", w: wRef, d: dRef, h: hRef },
        types,
      };

      const newId = obs.family.create(familyDef);
      return { newId, typeCount: types.length };
    }

    function promptAndBuild() {
      const familyName = window.prompt("Family name (e.g. 'Casement Window'):");
      if (!familyName) return;

      const ifcEntity = window.prompt(
        "IFC entity (e.g. IfcWindow, IfcDoor, IfcBuildingElementProxy):",
        "IfcBuildingElementProxy",
      ) || "IfcBuildingElementProxy";

      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".csv,text/csv";
      input.onchange = async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          const text = await file.text();
          const result = buildFamilyFromCSV(familyName, text, ifcEntity);
          obs.notify.success(
            `Family "${familyName}" created with ${result.typeCount} type(s).`,
          );
          log.info(`Created family ${result.newId} with ${result.typeCount} types`);
        } catch (err) {
          obs.notify.error(`Family creation failed: ${err.message || err}`);
          log.error("Family creation failed:", err);
        }
      };
      input.click();
    }

    return {
      activate() {
        log.info("Activated");
        obs.ui.registerCommand({
          id: "family-from-csv.generate",
          label: "Generate Family from CSV…",
          hint: "Build a parametric family + types from a CSV type catalog",
          run: promptAndBuild,
        });
      },
      deactivate() {
        log.info("Deactivated");
        obs.ui.unregisterCommand("family-from-csv.generate");
      },
    };
  });
})();
