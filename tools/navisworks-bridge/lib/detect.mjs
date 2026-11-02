/**
 * Detection of the local conversion stack: Autodesk Navisworks installs and
 * the BIMCamel IFC exporter plug-in (MIT, https://github.com/mrshoma99-rgb/
 * bimcamel-ifc-exporter — the only free open-source exporter that reads
 * NWD/NWF/NWC inside Navisworks 2024–2027 Manage/Simulate).
 *
 * Navisworks itself has NO built-in IFC export (confirmed by Autodesk
 * support), so a plug-in is mandatory for the local workflow.
 *
 * Detection is written as pure functions over injected directory listings so
 * the unit tests can simulate arbitrary machines without touching the disk.
 */

/** "Navisworks Manage 2025" / "Navisworks Simulate 2024" … (Freedom cannot host plug-ins). */
export const NAVISWORKS_DIR_RE = /^Navisworks (Manage|Simulate) (20\d\d)$/;

/**
 * Classify one directory name. Returns {sku, year} or null.
 */
export function classifyNavisworksDir(name) {
  const m = NAVISWORKS_DIR_RE.exec(String(name || "").trim());
  if (!m) return null;
  return { sku: m[1], year: Number(m[2]) };
}

/**
 * Find Navisworks installs from the names of an Autodesk program-files root.
 * `exists` is an injected predicate (path) => boolean used to verify that
 * Navisworks.exe actually exists inside the candidate folder.
 * Returns [{ dirName, sku, year, exePath }] sorted newest first.
 */
export function findNavisworksInstalls(rootDir, dirNames, exists, join) {
  const j = join || ((a, b) => `${a}\\${b}`);
  const found = [];
  for (const name of dirNames || []) {
    const cls = classifyNavisworksDir(name);
    if (!cls) continue;
    const exePath = j(j(rootDir, name), "Navisworks.exe");
    let ok = true;
    try { ok = typeof exists === "function" ? exists(exePath) : true; } catch { ok = false; }
    if (!ok) continue;
    found.push({ dirName: name, sku: cls.sku, year: cls.year, exePath });
  }
  found.sort((a, b) => b.year - a.year);
  return found;
}

/**
 * Locate the BIMCamel exporter.
 *  - ribbon plug-in (per-user install): %AppData%\Autodesk\ApplicationPlugins\BIMCamel*
 *  - optional headless harness built from the MIT repo:
 *      BIMCamelHeadlessRunner.exe + the headless export plug-in DLL
 *
 * `listDir` and `exists` are injected for testability.
 */
export function detectBimCamel({ appData, homeDir, listDir, exists, join }) {
  const j = join || ((a, b) => `${a}\\${b}`);
  const result = {
    pluginInstalled: false,
    pluginDirs: [],
    headlessRunner: null,
    headlessPlugin: null,
    mode: null, // "headless" | "guided" | null
  };

  // Ribbon plug-in per-user install root.
  const appPlugins = j(j(appData, "Autodesk"), "ApplicationPlugins");
  let entries = [];
  try { entries = listDir(appPlugins) || []; } catch { entries = []; }
  result.pluginDirs = entries.filter((e) => /^BIMCamel/i.test(e)).map((e) => j(appPlugins, e));
  result.pluginInstalled = result.pluginDirs.length > 0;

  // Headless harness: explicit config wins, then the repo's default output path.
  const runnerCandidates = [
    j(j(j(j(homeDir, "bimcamel-ifc-exporter"), "out"), "runner"), "BIMCamelHeadlessRunner.exe"),
    j(j(j(j(appData, "openBIMstudio"), "navisworks-bridge"), ""), "BIMCamelHeadlessRunner.exe"),
  ];
  for (const candidate of runnerCandidates) {
    try {
      if (exists(candidate)) { result.headlessRunner = candidate; break; }
    } catch { /* ignore */ }
  }
  const pluginCandidates = [
    j(j(j(j(homeDir, "bimcamel-ifc-exporter"), "out"), "harness"), "BIMCamelHeadlessExport.dll"),
    j(j(j(j(appData, "openBIMstudio"), "navisworks-bridge"), ""), "BIMCamelHeadlessExport.dll"),
  ];
  for (const candidate of pluginCandidates) {
    try {
      if (exists(candidate)) { result.headlessPlugin = candidate; break; }
    } catch { /* ignore */ }
  }

  if (result.headlessRunner && result.headlessPlugin) result.mode = "headless";
  else if (result.pluginInstalled) result.mode = "guided";
  return result;
}

/**
 * Combine install + exporter detection into the health payload's
 * navisworks/exporter/ready/modes block.
 */
export function buildCapability({ installs, exporter }) {
  const modes = [];
  if (exporter.mode === "headless") modes.push("headless");
  if (installs.length > 0 && exporter.pluginInstalled) modes.push("guided");
  return {
    navisworks: installs.map((i) => ({ sku: i.sku, year: i.year, exePath: i.exePath })),
    exporter: {
      pluginInstalled: exporter.pluginInstalled,
      pluginDirs: exporter.pluginDirs,
      headlessRunner: exporter.headlessRunner || null,
      headlessPlugin: exporter.headlessPlugin || null,
    },
    modes,
    // "ready" = at least one conversion mode can actually run on this machine.
    ready: modes.length > 0,
  };
}
