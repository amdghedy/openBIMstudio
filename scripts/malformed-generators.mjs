#!/usr/bin/env node
/**
 * Bounded malformed-input generators for IFC, BCF and DXF (issue #99).
 *
 * Deterministic (fixed seed → identical bytes) and bounded:
 *   - every case is at most MAX_CASE_BYTES (64 KiB);
 *   - at most MAX_CASES cases per format (CLI clamps --count into [1, 100]);
 *   - no case allocates in proportion to an attacker-chosen count: the
 *     "huge count" cases only DECLARE a huge number, they do not materialise
 *     it, and the deep-nesting case is capped at 300 levels.
 *
 * The generators build inputs; they do not judge them. The assertions live
 * in tests/malformed-input-generators.test.cjs, which feeds every case to
 * the real guard/parser (STEP pre-flight, file-guard ZIP audit, BCF markup
 * parser, DXF reader) and requires a controlled outcome — a rejection or a
 * bounded result, never a hang or an unbounded allocation.
 *
 * Reuses the §2 fuzz harness's mutation families (bitflip / structural) and
 * the §3 boundary suite's ZIP-audit cases (traversal, ratio, truncation)
 * without duplicating either: the fuzz gate mutates corpus bytes at random,
 * while these generators emit one named, minimal case per failure class so a
 * regression names the mechanism. New parser failures found by these
 * generators belong in tests/fixtures/ifc-corpus/malformed/ (IFC) as
 * minimised regression fixtures — see that folder's README.
 *
 * CLI:
 *   node scripts/malformed-generators.mjs [--format ifc|bcf|dxf|all]
 *     [--seed 42] [--count 8] [--out dir]
 * Without --out it prints a summary table. With --out it writes one file
 * per case plus cases.json (id, format, kind, file, bytes, sha256).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const MAX_CASE_BYTES = 64 * 1024;
export const MAX_CASES = 100;
export const DEFAULT_SEED = 42;

/** Deterministic PRNG (mulberry32). Same seed → same sequence. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rand(n) {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }

/* ── shared minimal STORE zip writer (deterministic, fixed DOS date) ──── */
function storeZip(entries) {
  // entries: [{ name, data: Buffer }]
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosDate = ((2026 - 1980) << 25) | (11 << 21) | (15 << 16);
  for (const { name, data } of entries) {
    const nameB = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt32LE(dosDate, 10); lh.writeUInt32LE(0, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameB, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10); cd.writeUInt32LE(dosDate, 12); cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameB.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...chunks, ...central, eocd]);
}

/** A central-directory-only stub (same shape as the §3 boundary suite's
 * zipBytes helper) for declaring sizes the archive does not contain:
 * traversal names, lying sizes, absurd ratios. No local headers. */
function cdOnlyZip({ entries = 1, comp = 100, raw = 100, name = "model.ifc", flags = 0 } = {}) {
  const nameB = Buffer.from(name, "latin1");
  const cdLen = 46 + nameB.length;
  const cd = Buffer.alloc(cdLen);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flags, 8); cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(comp, 20); cd.writeUInt32LE(raw, 24);
  cd.writeUInt16LE(nameB.length, 28);
  nameB.copy(cd, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries, 8); eocd.writeUInt16LE(entries, 10);
  eocd.writeUInt32LE(cdLen, 12); eocd.writeUInt32LE(0, 16);
  return Buffer.concat([cd, eocd]);
}

/* ── IFC ──────────────────────────────────────────────────────────────── */
// Small valid STEP model (project + site + building + storey + one wall).
// Kept minimal on purpose: mutations must stay attributable to one mechanism.
export const IFC_BASE = [
  "ISO-10303-21;",
  "HEADER;",
  "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
  "FILE_NAME('model.ifc','2026-11-15T00:00:00',('OpenBIMStudio'),('OpenBIMStudio'),'OpenBIMStudio IFC writer','OpenBIMStudio','');",
  "FILE_SCHEMA(('IFC4'));",
  "ENDSEC;",
  "DATA;",
  "#1=IFCPERSON($,'OpenBIMStudio',$,$,$,$,$,$);",
  "#2=IFCORGANIZATION($,'OpenBIMStudio',$,$,$);",
  "#3=IFCPERSONANDORGANIZATION(#1,#2,$);",
  "#4=IFCAPPLICATION(#2,'1.0','OpenBIMStudio IFC writer','OpenBIMStudio');",
  "#5=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,#3,#4,1794700800);",
  "#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);",
  "#7=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);",
  "#8=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);",
  "#9=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);",
  "#10=IFCUNITASSIGNMENT((#6,#7,#8,#9));",
  "#11=IFCCARTESIANPOINT((0.,0.,0.));",
  "#12=IFCAXIS2PLACEMENT3D(#11,$,$);",
  "#13=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#12,$);",
  "#14=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#13,$,.MODEL_VIEW.,$);",
  "#15=IFCPROJECT('2zPxS7FOtC_yNQyoX5C8ZK',#5,'Malformed Corpus',$,$,$,$,(#13),#10);",
  "#16=IFCAXIS2PLACEMENT3D(#11,$,$);",
  "#17=IFCLOCALPLACEMENT($,#16);",
  "#18=IFCSITE('0ZIPbU6AI2NtyiO6L4mNja',#5,'Site',$,$,#17,$,$,.ELEMENT.,$,$,$,$,$);",
  "#19=IFCAXIS2PLACEMENT3D(#11,$,$);",
  "#20=IFCLOCALPLACEMENT(#17,#19);",
  "#21=IFCBUILDING('0qHl5jIHdOrjQy0rMhuohk',#5,'Building',$,$,#20,$,$,.ELEMENT.,$,$,$);",
  "#22=IFCBUILDINGSTOREY('1qNFsAkCE5yepN1jH0I7wi',#5,'Ground',$,$,#20,$,$,.ELEMENT.,0.);",
  "#23=IFCRELAGGREGATES('3xDAlIKKB3UV4bn6nRKwp7',#5,$,$,#15,(#18));",
  "#24=IFCRELAGGREGATES('13rZML5e2h4thJYZilXHIz',#5,$,$,#18,(#21));",
  "#25=IFCRELAGGREGATES('2ffs7KdYcfJbNwkKXYT77I',#5,$,$,#21,(#22));",
  "#26=IFCCARTESIANPOINT((0.,0.,0.));",
  "#27=IFCAXIS2PLACEMENT3D(#26,$,$);",
  "#28=IFCLOCALPLACEMENT(#20,#27);",
  "#29=IFCWALL('387Hj9H6fSVTF4S_HVipJG',#5,'Wall A',$,$,#28,$,$,.STANDARD.);",
  "#30=IFCRELCONTAINEDINSPATIALSTRUCTURE('2DNUka4nrGWdrsn3$ZDdyP',#5,$,$,(#29),#22);",
  "ENDSEC;",
  "END-ISO-10303-21;",
  "",
].join("\n");

const IFC_KINDS = ["bitflip", "truncate", "unterminated-string", "broken-enum",
  "unbalanced-paren", "huge-integer", "deep-nesting", "semicolon-in-parens",
  "non-ascii-outside-string", "missing-tail"];

/** Kinds the structural pre-flight must reject (the rest may be inert). */
export const IFC_MUST_REJECT = new Set(["unterminated-string", "broken-enum",
  "unbalanced-paren", "huge-integer", "deep-nesting", "semicolon-in-parens",
  "non-ascii-outside-string", "missing-tail"]);

function mutateIfc(base, kind, rand) {
  const buf = Buffer.from(base, "latin1");
  const text = base;
  switch (kind) {
    case "bitflip": {
      const pos = rand(buf.length);
      buf[pos] ^= 1 << rand(8);
      return buf;
    }
    case "truncate": {
      const cut = 1 + rand(buf.length - 1);
      return buf.subarray(0, cut);
    }
    case "unterminated-string": {
      // Delete the closing quote of the 'Wall A' string.
      const s = text;
      const i = s.indexOf("'Wall A'");
      return Buffer.from(s.slice(0, i + 7) + s.slice(i + 8), "latin1");
    }
    case "broken-enum": {
      // Leading dot of .MODEL_VIEW. flipped to '/' — the §2 hang mechanism.
      return Buffer.from(text.replace(".MODEL_VIEW.", "/MODEL_VIEW."), "latin1");
    }
    case "unbalanced-paren": {
      const i = text.indexOf("(#6,#7,#8,#9)");
      return Buffer.from(text.slice(0, i + 12) + text.slice(i + 13), "latin1");
    }
    case "huge-integer": {
      return Buffer.from(text.replace("1794700800", "1234567890123456789012345"), "latin1");
    }
    case "deep-nesting": {
      // 300 open parens inside one record (capped — pre-flight depth limit is 256).
      const nested = "(".repeat(300) + ")".repeat(300);
      return Buffer.from(text.replace("(#6,#7,#8,#9)", `(${nested})`), "latin1");
    }
    case "semicolon-in-parens": {
      const i = text.indexOf("(#6,#7,#8,#9)");
      return Buffer.from(text.slice(0, i + 5) + ";" + text.slice(i + 5), "latin1");
    }
    case "non-ascii-outside-string": {
      const b = Buffer.from(text, "latin1");
      const i = text.indexOf("IFCWALL");
      b[i + 3] = 0xe9; // raw non-ASCII byte in an entity name
      return b;
    }
    case "missing-tail": {
      return Buffer.from(text.replace("END-ISO-10303-21;\n", ""), "latin1");
    }
    default: throw new Error(`unknown IFC kind ${kind}`);
  }
}

export function generateMalformedIfc(seed = DEFAULT_SEED, count = 8, base = IFC_BASE) {
  const rand = makeRng(seed);
  const cases = [];
  for (let i = 0; i < count; i++) {
    const kind = IFC_KINDS[i % IFC_KINDS.length];
    const bytes = Buffer.from(mutateIfc(base, kind, rand));
    if (bytes.length > MAX_CASE_BYTES) throw new Error(`IFC case ${kind} exceeds the byte cap`);
    cases.push({ id: `ifc-${kind}-${i}`, format: "ifc", kind, bytes, sha256: sha256(bytes) });
  }
  return cases;
}

/* ── BCF ──────────────────────────────────────────────────────────────── */
const BCF_MARKUP_OK = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Markup><Header><File IfcProject="2zPxS7FOtC_yNQyoX5C8ZK" IfcSpatialStructureElement="1qNFsAkCE5yepN1jH0I7wi" isExternal="false"><Filename>model.ifc</Filename><Date>2026-11-15T00:00:00Z</Date></File></Header>',
  '<Topic Guid="0XScRe4drE$QuCcyMkXutA" TopicType="Clash" TopicStatus="Open"><Title>Wall meets duct</Title><Priority>High</Priority><CreationDate>2026-11-15T00:00:00Z</CreationDate><CreationAuthor>obs@test</CreationAuthor><Description>Test topic</Description></Topic>',
  '</Markup>',
  "",
].join("\n");

const BCF_KINDS = ["valid-bcf", "malformed-xml-unclosed", "malformed-xml-entity",
  "malformed-xml-no-topic", "truncated-zip", "traversal-entry", "zip-bomb-ratio",
  "missing-markup", "not-a-zip", "empty-zip"];

function bcfCase(kind) {
  switch (kind) {
    case "valid-bcf":
      return storeZip([{ name: "bcf/topic-1/markup.bcf", data: Buffer.from(BCF_MARKUP_OK, "utf8") }]);
    case "malformed-xml-unclosed":
      return storeZip([{ name: "bcf/topic-1/markup.bcf",
        data: Buffer.from(BCF_MARKUP_OK.replace("</Markup>\n", ""), "utf8") }]);
    case "malformed-xml-entity":
      return storeZip([{ name: "bcf/topic-1/markup.bcf",
        data: Buffer.from(BCF_MARKUP_OK.replace("<Markup>",
          '<Markup><!DOCTYPE Markup [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Topic Guid="0XScRe4drE$QuCcyMkXutA">&xxe;</Topic>'), "utf8") }]);
    case "malformed-xml-no-topic":
      return storeZip([{ name: "bcf/topic-1/markup.bcf",
        data: Buffer.from('<?xml version="1.0"?><Markup><Header></Header></Markup>\n', "utf8") }]);
    case "truncated-zip": {
      const full = storeZip([{ name: "bcf/topic-1/markup.bcf", data: Buffer.from(BCF_MARKUP_OK, "utf8") }]);
      return full.subarray(0, Math.floor(full.length / 2));
    }
    case "traversal-entry":
      return cdOnlyZip({ name: "../evil.bcf" });
    case "zip-bomb-ratio":
      return cdOnlyZip({ comp: 10, raw: 1000000 });
    case "missing-markup":
      return storeZip([{ name: "bcf/topic-1/viewpoint.bcfv",
        data: Buffer.from("<VisualizationInfo></VisualizationInfo>\n", "utf8") }]);
    case "not-a-zip":
      return Buffer.from("this is not a BCF file, it is plain text\n", "utf8");
    case "empty-zip": {
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      return eocd;
    }
    default: throw new Error(`unknown BCF kind ${kind}`);
  }
}

export function generateMalformedBcf(seed = DEFAULT_SEED, count = 8) {
  // BCF kinds are structural, not random: seed only orders the rotation.
  const rand = makeRng(seed);
  const start = rand(BCF_KINDS.length);
  const cases = [];
  for (let i = 0; i < count; i++) {
    const kind = BCF_KINDS[(start + i) % BCF_KINDS.length];
    const bytes = Buffer.from(bcfCase(kind));
    if (bytes.length > MAX_CASE_BYTES) throw new Error(`BCF case ${kind} exceeds the byte cap`);
    cases.push({ id: `bcf-${kind}-${i}`, format: "bcf", kind, bytes, sha256: sha256(bytes) });
  }
  return cases;
}

/* ── DXF ──────────────────────────────────────────────────────────────── */
const D = (...a) => a.flat().map(String).filter((x) => x !== "").join("\n");
const dxfSec = (name, body) => D("0", "SECTION", "2", name, body, "0", "ENDSEC");
export function dxfBase() {
  return D(
    dxfSec("HEADER", D("9", "$ACADVER", "1", "AC1032")),
    dxfSec("ENTITIES", D("0", "LINE", "8", "A", "10", "0", "20", "0", "30", "0", "11", "5", "21", "0", "31", "0")),
    "0", "EOF",
  ) + "\n";
}

const DXF_KINDS = ["valid-dxf", "truncated", "bad-group-code", "huge-count",
  "unbalanced-section", "non-numeric-coordinate", "self-insert", "cycle-insert",
  "missing-eof", "empty"];

function dxfCase(kind) {
  const base = dxfBase();
  const line = (ents) => D(dxfSec("HEADER", D("9", "$ACADVER", "1", "AC1032")), dxfSec("ENTITIES", ents), "0", "EOF") + "\n";
  const withBlocks = (blocks, ents) => D(
    dxfSec("HEADER", D("9", "$ACADVER", "1", "AC1032")),
    dxfSec("BLOCKS", blocks),
    dxfSec("ENTITIES", ents), "0", "EOF") + "\n";
  switch (kind) {
    case "valid-dxf": return Buffer.from(base, "utf8");
    case "truncated": return Buffer.from(base.slice(0, 60), "utf8");
    case "bad-group-code":
      return Buffer.from(line(D("0", "LINE", "8", "A", "XX", "0", "10", "0", "20", "0", "30", "0", "11", "5", "21", "0", "31", "0")), "utf8");
    case "huge-count":
      return Buffer.from(line(D("0", "LWPOLYLINE", "8", "A", "90", "100000000", "70", "1", "10", "0", "20", "0", "10", "1", "20", "0", "10", "1", "20", "1")), "utf8");
    case "unbalanced-section":
      return Buffer.from(base.replace("0\nENDSEC\n0\nEOF", "0\nEOF"), "utf8");
    case "non-numeric-coordinate":
      return Buffer.from(line(D("0", "LINE", "8", "A", "10", "abc", "20", "0", "30", "0", "11", "5", "21", "0", "31", "0")), "utf8");
    case "self-insert":
      return Buffer.from(withBlocks(
        D("0", "BLOCK", "8", "0", "2", "B", "70", "0", "10", "0", "20", "0", "30", "0",
          "0", "INSERT", "8", "0", "2", "B", "10", "0", "20", "0", "30", "0", "0", "ENDBLK"),
        D("0", "INSERT", "8", "A", "2", "B", "10", "0", "20", "0", "30", "0")), "utf8");
    case "cycle-insert":
      return Buffer.from(withBlocks(
        D("0", "BLOCK", "8", "0", "2", "A", "70", "0", "10", "0", "20", "0", "30", "0",
          "0", "INSERT", "8", "0", "2", "B", "10", "0", "20", "0", "30", "0", "0", "ENDBLK",
          "0", "BLOCK", "8", "0", "2", "B", "70", "0", "10", "0", "20", "0", "30", "0",
          "0", "INSERT", "8", "0", "2", "A", "10", "0", "20", "0", "30", "0", "0", "ENDBLK"),
        D("0", "INSERT", "8", "A", "2", "A", "10", "0", "20", "0", "30", "0")), "utf8");
    case "missing-eof": return Buffer.from(base.replace("0\nEOF\n", ""), "utf8");
    case "empty": return Buffer.alloc(0);
    default: throw new Error(`unknown DXF kind ${kind}`);
  }
}

export function generateMalformedDxf(seed = DEFAULT_SEED, count = 8) {
  const rand = makeRng(seed);
  const start = rand(DXF_KINDS.length);
  const cases = [];
  for (let i = 0; i < count; i++) {
    const kind = DXF_KINDS[(start + i) % DXF_KINDS.length];
    const bytes = Buffer.from(dxfCase(kind));
    if (bytes.length > MAX_CASE_BYTES) throw new Error(`DXF case ${kind} exceeds the byte cap`);
    cases.push({ id: `dxf-${kind}-${i}`, format: "dxf", kind, bytes, sha256: sha256(bytes) });
  }
  return cases;
}

/* ── CLI ──────────────────────────────────────────────────────────────── */
export function generateAll(seed = DEFAULT_SEED, count = 8, formats = ["ifc", "bcf", "dxf"]) {
  const out = [];
  if (formats.includes("ifc")) out.push(...generateMalformedIfc(seed, count));
  if (formats.includes("bcf")) out.push(...generateMalformedBcf(seed, count));
  if (formats.includes("dxf")) out.push(...generateMalformedDxf(seed, count));
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag, def) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
  };
  const formatArg = (get("--format", "all") || "all").toLowerCase();
  const formats = formatArg === "all" ? ["ifc", "bcf", "dxf"] : formatArg.split(",");
  for (const f of formats) {
    if (!["ifc", "bcf", "dxf"].includes(f)) { console.error(`unknown format ${f} (ifc|bcf|dxf|all)`); process.exit(2); }
  }
  const seed = Number(get("--seed", String(DEFAULT_SEED))) || DEFAULT_SEED;
  const count = Math.max(1, Math.min(MAX_CASES, Number(get("--count", "8")) || 8));
  const outDir = get("--out", null);
  const cases = generateAll(seed, count, formats);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    const manifest = { seed, count, formats, maxCaseBytes: MAX_CASE_BYTES, cases: [] };
    for (const c of cases) {
      const ext = c.format === "ifc" ? "ifc" : c.format === "bcf" ? "bcf" : "dxf";
      const file = `${c.id}.${ext}`;
      writeFileSync(path.join(outDir, file), c.bytes);
      manifest.cases.push({ id: c.id, format: c.format, kind: c.kind, file, bytes: c.bytes.length, sha256: c.sha256 });
    }
    writeFileSync(path.join(outDir, "cases.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`wrote ${cases.length} cases to ${outDir}`);
  } else {
    for (const c of cases) console.log(`${c.id}\t${c.format}\t${c.kind}\t${c.bytes.length} bytes\t${c.sha256.slice(0, 12)}`);
  }
}
