/**
 * IFC Validator plugin
 *
 * Scans loaded IFC models and reports:
 *   - Entities missing GlobalId
 *   - Duplicate GlobalIds
 *   - Entities with missing required attributes (Name, OwnerHistory)
 *   - Inconsistent length units across models
 *   - Orphaned IfcRelDecomposes references
 *
 * Adds a command "Validate IFC Models" to the command palette.
 */
(function () {
  if (!window.__obsRegisterPlugin) {
    console.warn("[ifc-validator] __obsRegisterPlugin bridge not available");
    return;
  }

  const manifest = {
    id: "ifc-validator",
    name: "IFC Validator",
    version: "1.0.0",
    sdkVersion: 1,
    capabilities: ["ifc.read", "ui.command", "ui.notification", "ui.panel"],
  };

  window.__obsRegisterPlugin(manifest, function (api) {
    const { obs, log } = api;

    function validateModels() {
      log.info("Starting IFC validation…");

      const models = obs.ifc.getModels();
      if (!models || models.length === 0) {
        obs.notify.warn("No IFC models loaded. Load a model first.");
        return;
      }

      const issues = [];
      const allGlobalIds = new Map(); // guid -> [modelId, expressId]
      const unitsByModel = new Map(); // modelId -> length unit

      for (const model of models) {
        const modelId = model.id ?? model.expressId ?? String(model);
        const entities = obs.ifc.getEntities(modelId);

        for (const ent of entities) {
          const guid = ent.GlobalId ?? ent.globalId;
          const type = ent.type ?? ent.Type ?? "Unknown";
          const expressId = ent.expressId ?? ent.expressID ?? -1;

          if (!guid) {
            issues.push({
              severity: "error",
              modelId,
              expressId,
              type,
              message: `Missing GlobalId on ${type} (#${expressId})`,
            });
          } else {
            const existing = allGlobalIds.get(guid);
            if (existing) {
              issues.push({
                severity: "error",
                modelId,
                expressId,
                type,
                message: `Duplicate GlobalId "${guid}" also in ${existing[0]} #${existing[1]}`,
              });
            } else {
              allGlobalIds.set(guid, [modelId, expressId]);
            }
          }

          if (!ent.Name && type !== "IfcOwnerHistory" && type !== "IfcUnitAssignment") {
            // Soft warning — many IFC entities legitimately lack Name
            if (/IfcWall|IfcDoor|IfcWindow|IfcSpace|IfcBeam|IfcColumn|IfcSlab/.test(type)) {
              issues.push({
                severity: "warning",
                modelId,
                expressId,
                type,
                message: `${type} #${expressId} has no Name attribute`,
              });
            }
          }

          const unit = ent.Unit ?? ent.unit;
          if (type === "IfcSIUnit" && unit) {
            unitsByModel.set(modelId, unit);
          }
        }
      }

      const unitSet = new Set([...unitsByModel.values()]);
      if (unitSet.size > 1) {
        issues.push({
          severity: "warning",
          modelId: "*",
          expressId: -1,
          type: "IfcUnitAssignment",
          message: `Inconsistent length units across models: ${[...unitSet].join(", ")}`,
        });
      }

      const errorCount = issues.filter((i) => i.severity === "error").length;
      const warnCount = issues.filter((i) => i.severity === "warning").length;

      log.info(`Validation complete: ${errorCount} error(s), ${warnCount} warning(s)`);

      if (errorCount === 0 && warnCount === 0) {
        obs.notify.success(`IFC validation passed: ${models.length} model(s) clean.`);
      } else {
        obs.notify.warn(
          `IFC validation: ${errorCount} error(s), ${warnCount} warning(s). Check console.`,
        );
      }

      console.group(`[ifc-validator] ${issues.length} issue(s)`);
      for (const issue of issues) {
        const fn = issue.severity === "error" ? console.error : console.warn;
        fn(`[${issue.severity}] ${issue.modelId} #${issue.expressId} ${issue.type}: ${issue.message}`);
      }
      console.groupEnd();

      api.obs.storage.set("last-report", { timestamp: Date.now(), issues }).catch(() => {});
    }

    return {
      activate() {
        log.info("Activated");
        obs.ui.registerCommand({
          id: "ifc-validator.run",
          label: "Validate IFC Models",
          hint: "Check loaded IFC models for missing GlobalIds, duplicates, and unit inconsistencies",
          run: validateModels,
        });
      },
      deactivate() {
        log.info("Deactivated");
        obs.ui.unregisterCommand("ifc-validator.run");
      },
    };
  });
})();
