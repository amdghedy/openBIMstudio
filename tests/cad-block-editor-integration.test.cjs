/* Source-level contract for native BLOCK/INSERT wiring in the standalone 2D editor.
 * Pure resolver behaviour is exercised by cad-block-refs.test.cjs; this guards the live editor integration points. */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const viewer = read("src", "features", "cad-viewer.ts");
const link = read("src", "modules", "cad-link", "index.ts");
const math = read("src", "modules", "cad-viewer", "viewer-math.ts");
const modify = read("src", "modules", "cad-viewer", "modify-math.ts");
const writer = read("src", "modules", "drawings", "dxf-writer.ts");

const loadAt = viewer.indexOf("async function load(file: File): Promise<void>");
if (loadAt < 0) throw new Error("CAD editor load(file) not found");
const load = viewer.slice(loadAt, loadAt + 7000);
const readerCall = load.indexOf("readCadFile(file, { nativeBlocks: /\\.dxf$/i.test(file.name) })");
const docAssign = load.indexOf("doc = r.doc;");
const bind = load.indexOf("bindDocumentBlocks(doc);");
if (readerCall < 0 || docAssign < readerCall || bind < docAssign) throw new Error("ASCII DXF native read and document binding must happen before geometry indexing");
if (!link.includes("nativeBlocks?: boolean") || !link.includes("parseDxf(await file.text(), options.nativeBlocks ? { nativeBlocks: true } : {})")) throw new Error("readCadFile nativeBlocks opt-in is missing");
if (!viewer.includes('import { bindDocumentBlocks, resolvedOf } from "../modules/drawings/block-refs";')) throw new Error("CAD editor block resolver imports missing");
if (!viewer.includes('case "INSERT":') || !viewer.includes("const children = resolvedOf(e)")) throw new Error("Canvas drawEntity does not render a resolved INSERT");
const p0=viewer.indexOf("function paintEntities("), paint=viewer.slice(p0,p0+7000);
for (const s of ["const blockChildren = e.type === \"INSERT\" ? resolvedOf(e) : null","showBlockChild","paintStyled(child, parentAlpha)","M.entityBBox(child)"]) if (!paint.includes(s)) throw new Error("Block paint path missing: "+s);
if (!math.includes("resolvedOf(e).flatMap((child) => entitySegments(child))") || !math.includes("case \"INSERT\": {")) throw new Error("INSERT pick/snap math path incomplete");
if (!modify.includes("bindInsert(result, table)") || !modify.includes("blocksOf(src)")) throw new Error("Affine transforms drop block-table binding");
if (!writer.includes('e.type === "INSERT"') || !writer.includes("doc.blocks")) throw new Error("DXF writer does not serialize native block definitions/references");
const saveAt=viewer.indexOf("function saveDxf(): void"), save=viewer.slice(saveAt,saveAt+2500);
if (saveAt<0 || !save.includes("writeDxf({ ...doc, entities: stampInvisibleForSave(entities) })")) throw new Error("CAD editor save path does not serialize the live document and block table");
console.log("PASS ASCII-DXF opt-in + block-table binding in live editor load");
console.log("PASS INSERT canvas rendering and per-child style/visibility/culling");
console.log("PASS spatial extents, entity distance, nearest and intersection snapping path");
console.log("PASS affine transforms preserve weak block-table binding");
console.log("PASS native block definitions and INSERT refs pass through DXF save");
console.log("5 editor integration contracts passed (source-level; browser E2E remains separate).");
