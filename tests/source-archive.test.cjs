const assert = require("assert");

function discoverPaths(value, prefix = "", depth = 0, out = [], maxDepth = 6, maxPaths = 2000) {
  if (out.length >= maxPaths || depth > maxDepth) return out;
  if (value == null) { out.push(prefix || "(root)"); return out; }
  if (typeof value !== "object") { out.push(prefix); return out; }
  if (Array.isArray(value)) {
    out.push(prefix + "[]");
    if (value.length && depth < maxDepth) discoverPaths(value[0], prefix + "[0]", depth + 1, out, maxDepth, maxPaths);
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "function") continue;
    const path = prefix ? `${prefix}.${k}` : k;
    out.push(path);
    if (v && typeof v === "object") discoverPaths(v, path, depth + 1, out, maxDepth, maxPaths);
    if (out.length >= maxPaths) break;
  }
  return out;
}

function buildArchive(rawItem, identity, sourceDimensions) {
  const propertySets = rawItem.psets && typeof rawItem.psets === "object" ? rawItem.psets : {};
  const quantities = rawItem.qtos && typeof rawItem.qtos === "object" ? rawItem.qtos : {};
  const discoveredPaths = discoverPaths(rawItem);
  const fieldMap = [];
  if (identity.globalId) fieldMap.push({ sourcePath: "GlobalId", nativePath: "ifc.globalId", status: "synchronized" });
  for (const key of Object.keys(propertySets)) {
    fieldMap.push({ sourcePath: `psets.${key}`, nativePath: `ifc.propertySets.${key}`, status: "synchronized" });
  }
  for (const key of Object.keys(quantities)) {
    fieldMap.push({ sourcePath: `qtos.${key}`, nativePath: `ifc.quantities.${key}`, status: "synchronized" });
  }
  if (sourceDimensions) {
    for (const k of Object.keys(sourceDimensions)) {
      fieldMap.push({ sourcePath: `sourceDimensions.${k}`, nativePath: `params.${k}`, status: "synchronized" });
    }
  }
  for (const path of discoveredPaths) {
    if (path.includes(".") || path.includes("[")) continue;
    if (fieldMap.some((f) => f.sourcePath === path || f.sourcePath.startsWith(path))) continue;
    fieldMap.push({ sourcePath: path, status: "preserved-unmapped" });
  }
  return { rawItem, propertySets, quantities, discoveredPaths, fieldMap, sourceDimensions };
}

function markNative(archive, paramKey) {
  for (const f of archive.fieldMap) {
    if (f.nativePath === `params.${paramKey}` || f.sourcePath === `sourceDimensions.${paramKey}`) {
      f.status = "native-modified";
    }
  }
}

const raw = {
  GlobalId: "abc-123",
  Name: "Wall-A",
  CustomOrgAttr: { code: "X-99", note: "keep me" },
  psets: { Pset_WallCommon: { IsExternal: true, FireRating: "2HR" } },
  qtos: { Qto_WallBaseQuantities: { Height: 3.5, GrossArea: 12.4 } },
  UnknownExtension: [1, 2, 3],
};

const archive = buildArchive(raw, { globalId: "abc-123" }, { height: 3.5, width: 0.2 });
assert.ok(archive.propertySets.Pset_WallCommon);
assert.ok(archive.quantities.Qto_WallBaseQuantities);
assert.ok(archive.discoveredPaths.some((p) => p.includes("CustomOrgAttr")));
assert.ok(archive.fieldMap.some((f) => f.status === "preserved-unmapped" && f.sourcePath === "CustomOrgAttr"));
assert.strictEqual(archive.sourceDimensions.height, 3.5);

// Edit native height — source height retained
markNative(archive, "height");
assert.strictEqual(archive.sourceDimensions.height, 3.5);
assert.ok(archive.fieldMap.some((f) => f.sourcePath === "sourceDimensions.height" && f.status === "native-modified"));

// Unknown attrs still present after "edit"
assert.deepStrictEqual(archive.rawItem.CustomOrgAttr, { code: "X-99", note: "keep me" });
assert.deepStrictEqual(archive.rawItem.UnknownExtension, [1, 2, 3]);

console.log("source-archive.test.cjs: ok");
