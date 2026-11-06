import { dwgDatabaseToDxfDocument } from "../drawings/dwg-convert";
import { parseWithAcadEngine } from "../drawings/acad-engine";
import { DwgParseError, sniffDwgVersion } from "./dwg-reader-protocol";
/** Reader singleton (wasm instantiation is expensive; reuse across parses). */
let readerPromise = null;
async function loadReaderModule() {
    let mod;
    try {
        mod = await import("@mlightcad/libredwg-web");
    }
    catch {
        throw new DwgParseError("init-failed", "the DWG reader (@mlightcad/libredwg-web) is not installed - run npm install");
    }
    const LibreDwg = mod.LibreDwg ?? mod.default?.LibreDwg;
    const FileType = mod.Dwg_File_Type ?? mod.default?.Dwg_File_Type;
    if (!LibreDwg?.create) {
        throw new DwgParseError("init-failed", "the installed libredwg-web has an unexpected API (LibreDwg.create missing)");
    }
    return { LibreDwg, FileType };
}
async function startReader(LibreDwg) {
    const attempts = [
        () => LibreDwg.create(),
        // Copied next to the app by scripts/copy-libredwg-wasm.mjs (npm postinstall).
        () => LibreDwg.create("/libredwg/"),
    ];
    let last;
    for (const a of attempts) {
        try {
            return await a();
        }
        catch (e) {
            last = e;
        }
    }
    throw new DwgParseError("init-failed", `could not start the DWG reader (WASM failed to load): ${last instanceof Error ? last.message : String(last)}`);
}
async function getReader() {
    if (!readerPromise) {
        readerPromise = (async () => {
            const { LibreDwg, FileType } = await loadReaderModule();
            const lib = await startReader(LibreDwg);
            return { lib, FileType };
        })();
        readerPromise.catch(() => { readerPromise = null; }); // allow retry after failure
    }
    return readerPromise;
}
/**
 * Parse DWG bytes into a DxfDocument. Coordinates, units, layers, colors,
 * linetypes and block relationships are preserved by the converter exactly as
 * before — only the execution context changed (worker instead of main thread).
 */
export async function parseDwgBytes(buffer, fileName) {
    // Total worker-turn budget: wasm read + JS conversion must finish before the
    // main-thread parse timeout (DWG_PARSE_TIMEOUT_MS = 120s) terminates the worker.
    const t0 = Date.now();
    const CONVERT_DEADLINE_MS = 115000;
    const bytes = new Uint8Array(buffer);
    const sniff = sniffDwgVersion(bytes);
    if (!sniff) {
        throw new DwgParseError("invalid-file", `${fileName} is not a DWG file (missing DWG version stamp such as AC1032). If this is a DXF, import it with the DXF path.`);
    }
    // Primary path: the acadrust engine reads every DWG version R12–R2018+ with
    // full entity coverage and returns structured read statistics.
    try {
        const acad = await parseWithAcadEngine(bytes, fileName);
        if (acad && acad.entityCount > 0) {
            return {
                doc: acad.doc,
                summary: acad.summary,
                version: acad.version || sniff.code,
                entityCount: acad.entityCount,
            };
        }
        if (acad && acad.entityCount === 0 && acad.stats?.entities === 0 && !acad.stats.streamCompleted) {
            // Engine started but could not decode the stream at all — fall through.
            console.warn("[dwg-reader] acadrust produced no entities, falling back to libredwg", acad.summary);
        }
    }
    catch (e) {
        console.warn("[dwg-reader] acadrust path failed, falling back to libredwg:", e);
    }
    const { lib, FileType } = await getReader();
    let dwg = null;
    const errors = [];
    for (const input of [bytes, bytes.buffer]) {
        try {
            dwg = lib.dwg_read_data(input, FileType?.DWG ?? 0);
            if (dwg)
                break;
        }
        catch (e) {
            errors.push(e instanceof Error ? e.message : String(e));
        }
    }
    if (!dwg) {
        const detail = errors.length ? errors[0] : "dwg_read_data returned no data";
        throw new DwgParseError("parse-failed", "libredwg could not read this DWG (very new AutoCAD version, encrypted or damaged file)", `${sniff.label} (${sniff.code}) - ${detail}`);
    }
    let db;
    try {
        db = lib.convert ? lib.convert(dwg) : dwg;
    }
    finally {
        try {
            lib.dwg_free?.(dwg);
        }
        catch { /* */ }
    }
    const res = dwgDatabaseToDxfDocument(db, { deadlineMs: t0 + CONVERT_DEADLINE_MS });
    if (!res.doc.entities.length) {
        // Help diagnose converter/field-name mismatches: what did the file actually contain?
        try {
            const raw = Array.isArray(db?.entities) ? db.entities : [];
            const hist = {};
            for (const e of raw) {
                const k = String(e?.type ?? e?.entityType ?? e?.name ?? "?");
                hist[k] = (hist[k] ?? 0) + 1;
            }
            const keys = Object.keys(db ?? {}).join(", ");
            res.summary += ` | raw model entities: ${raw.length}${raw.length ? " (" + Object.entries(hist).map(([k, v]) => `${v}x${k}`).join(", ") + ")" : ""} | database keys: ${keys}`;
            console.warn("[dwg-reader] DWG produced no drawable entities", { hist, keys });
        }
        catch { /* */ }
    }
    return { doc: res.doc, summary: res.summary, version: sniff.code, entityCount: res.doc.entities.length };
}
/** Map any thrown value to a structured code (worker boundary + tests). */
export function toDwgParseError(e) {
    if (e && typeof e === "object" && "code" in e && typeof e.code === "string") {
        const err = e;
        return { code: err.code, message: err.message, detail: err.detail };
    }
    return { code: "internal", message: e instanceof Error ? e.message : String(e) };
}
/**
 * Independent DWG validation entry point. This deliberately bypasses acadrust
 * and invokes the separately implemented LibreDWG reader directly. Keep this
 * exported so export acceptance tests can verify writer interoperability
 * without allowing the writer to validate its own output.
 */
export async function parseDwgBytesWithLibreDwg(buffer, fileName) {
    const t0 = Date.now();
    const bytes = new Uint8Array(buffer);
    const sniff = sniffDwgVersion(bytes);
    if (!sniff) {
        throw new DwgParseError("invalid-file", `${fileName} is not a DWG file (missing DWG version stamp such as AC1032).`);
    }
    const { lib, FileType } = await getReader();
    let dwg = null;
    const errors = [];
    for (const input of [bytes, bytes.buffer]) {
        try {
            dwg = lib.dwg_read_data(input, FileType?.DWG ?? 0);
            if (dwg)
                break;
        }
        catch (e) {
            errors.push(e instanceof Error ? e.message : String(e));
        }
    }
    if (!dwg) {
        const detail = errors.length ? errors[0] : "dwg_read_data returned no data";
        throw new DwgParseError("parse-failed", "LibreDWG could not read this DWG (unsupported version, encrypted or damaged file)", `${sniff.label} (${sniff.code}) - ${detail}`);
    }
    let db;
    try {
        db = lib.convert ? lib.convert(dwg) : dwg;
    }
    finally {
        try {
            lib.dwg_free?.(dwg);
        }
        catch { /* best-effort native cleanup */ }
    }
    const res = dwgDatabaseToDxfDocument(db, { deadlineMs: t0 + 115000 });
    return {
        doc: res.doc,
        summary: `Independently parsed by LibreDWG: ${res.summary}`,
        version: sniff.code,
        entityCount: res.doc.entities.length,
    };
}
