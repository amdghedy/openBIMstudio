// Free family creator: read a packaged-booster data sheet table into catalogue variants.
//
// Reads the text lines of a sheet like the Wilo WiBooster submittal (one string per page,
// one visual line per row, as pdf-text.ts gives them). It finds the column header (flow
// type x voltage), the connection row, the lettered dimension rows (A..J) and the panel
// size, weight and amps rows. It returns EVERY column as a variant: it never picks one.
// The caller (a person) chooses the variant, and the choice is recorded with the spec.
//
// Units: the sheet has no unit column. It is read as inches only because the header says
// "Connection (in)" and weights say "lbs"; `unitBasis` carries that so it can be shown.
// If the table is not found in the expected shape, `ok` is false with the reason.

import type { ProductSpec } from "./build";

const IN = 0.0254;

export interface BoosterVariant {
  id: string;
  flow: "full" | "half";
  voltage: string;
  connectionIn: number | null;
  /** Dimension letter -> inches. A letter marked x on the sheet is absent. */
  dimsIn: Record<string, number>;
  panelIn: { h: number; w: number; d: number } | null;
  panelWeightLb: number | null;
  systemWeightLb: number | null;
}

export interface BoosterSheet {
  ok: boolean;
  reason?: string;
  model?: string;
  /** From the model name "WiBooster 3/323/A": the number before the first slash. A reading of the name, not a sheet field. */
  pumps?: number;
  hpPerPump?: number;
  unitBasis: string;
  variants: BoosterVariant[];
  /** Page and line (1-based) of the header row and of each dimension row, for the Sources view. */
  lines: Record<string, { page: number; line: number }>;
}

const num = (s: string): number | null => (/^\d+(\.\d+)?$/.test(s) ? Number(s) : null);

function readOne(pages: string[], pageOffset: number): BoosterSheet {
  const fail = (reason: string): BoosterSheet => ({ ok: false, reason, unitBasis: "", variants: [], lines: {} });
  const lines: Record<string, { page: number; line: number }> = {};
  let model: string | undefined, hp: number | undefined;
  let voltages: string[] | null = null, hdrAt: { page: number; line: number } | null = null;
  const rows: Record<string, Array<string>> = {};
  let panel: string[] | null = null, panelW: string[] | null = null, sysW: string[] | null = null, connection: string[] | null = null;
  for (let p = 0; p < pages.length; p++) {
    const ls = pages[p].split("\n");
    for (let i = 0; i < ls.length; i++) {
      const line = ls[i].trim();
      const where = { page: p + 1 + pageOffset, line: i + 1 };
      const m = line.match(/\bWiBooster\s+(\d+)\/(\d+)\/([A-Z]\d?)\b/);
      if (m && !model) { model = `WiBooster ${m[1]}/${m[2]}/${m[3]}`; lines.model = where; }
      const h = line.match(/^Horsepower\/Pump\s+(\d+(\.\d+)?)/);
      if (h && hp === undefined) hp = Number(h[1]);
      if (/^Dimensions\s/.test(line) && !voltages) {
        const toks = line.replace(/^Dimensions\s+/, "").split(/\s+/);
        if (toks.length >= 8) { voltages = toks.slice(0, 8); hdrAt = where; lines.header = where; }
      }
      const toks = line.split(/\s+/);
      const row = toks[0];
      if (/^(A|A1|B|C|D|E|F|G|H|I|J|J1)$/.test(row) && toks.length >= 9 && !rows[row]) {
        const vals = toks.slice(1, 9);
        if (vals.every((v) => num(v) !== null || v === "x")) { rows[row] = vals; lines[row] = where; }
      }
      if (/^System Connection \(150#\)\s/.test(line)) connection = toks.slice(-8);
      if (/^Panel Dimensions \(HxWxD\)\s/.test(line)) { panel = toks.slice(-8); lines.panel = where; }
      if (/^Panel Weight \(lbs\)\s/.test(line)) panelW = toks.slice(-8);
      if (/^System Weight \(lbs\)\s/.test(line)) sysW = toks.slice(-8);
    }
  }
  if (!voltages || !hdrAt) return fail("The dimensions table header (flow type and voltage columns) was not found.");
  for (const k of ["A", "C", "J"]) if (!rows[k]) return fail(`Dimension row ${k} was not found in the table.`);
  const variants: BoosterVariant[] = [];
  for (let c = 0; c < 8; c++) {
    const flow: "full" | "half" = c < 4 ? "full" : "half";
    const dimsIn: Record<string, number> = {};
    for (const [k, vals] of Object.entries(rows)) { const v = num(vals[c]); if (v !== null) dimsIn[k] = v; }
    const pm = panel?.[c]?.match(/^(\d+)[xX](\d+)[xX](\d+)$/);
    variants.push({
      id: `${flow}-${voltages[c]}`, flow, voltage: voltages[c],
      connectionIn: connection ? num(connection[c]) : null,
      dimsIn,
      panelIn: pm ? { h: Number(pm[1]), w: Number(pm[2]), d: Number(pm[3]) } : null,
      panelWeightLb: panelW ? num(panelW[c]) : null,
      systemWeightLb: sysW ? num(sysW[c]) : null,
    });
  }
  const pumps = model ? Number(model.match(/WiBooster (\d+)\//)![1]) : undefined;
  return {
    ok: true, model, pumps, hpPerPump: hp, variants, lines,
    unitBasis: "inches: assumed from the sheet's \"Connection (in)\" header and weights in lbs; the table has no unit column",
  };
}

export interface BoosterChoice {
  variantId: string;
  /** Which sheet row is the overall depth: J (end view with pipework) or H (side view). No default. */
  depthRow: "J" | "H";
  name?: string;
  /** Frame length (row B) and manifold length. The manifold length is NOT on the sheet. */
  manifoldLengthM?: number;
}

export interface BoosterSpecResult { spec: ProductSpec; provenance: Array<{ param: string; valueM: number; source: string }> }

/** Make a ProductSpec for the booster template from one chosen variant. Throws if the variant or rows are missing. */
export function boosterSpecFromSheet(sheet: BoosterSheet, choice: BoosterChoice): BoosterSpecResult {
  if (!sheet.ok) throw new Error(sheet.reason ?? "Sheet not read");
  const v = sheet.variants.find((x) => x.id === choice.variantId);
  if (!v) throw new Error(`No such variant: ${choice.variantId}`);
  const need = (k: string) => { const x = v.dimsIn[k]; if (x === undefined) throw new Error(`Row ${k} has no value for ${v.id}`); return x; };
  const prov: BoosterSpecResult["provenance"] = [];
  const take = (param: string, inches: number, source: string) => { prov.push({ param, valueM: inches * IN, source }); return inches * IN; };
  const widthM = take("Width", need("A"), `sheet row A, ${v.id}`);
  const heightM = take("Height", need("C"), `sheet row C, ${v.id}`);
  const depthM = take("Depth", need(choice.depthRow), `sheet row ${choice.depthRow}, ${v.id} (chosen by the user)`);
  const params: Record<string, number> = {};
  if (sheet.pumps) { params.Pumps = sheet.pumps; prov.push({ param: "Pumps", valueM: sheet.pumps, source: "number before the first slash in the model name (a reading of the name)" }); }
  for (const [row, param] of [["D", "SuctionAxisH"], ["E", "DischargeRise"], ["G", "PumpSetLength"], ["I", "ManifoldSpacing"], ["F", "GaugeRise"]] as const) {
    if (v.dimsIn[row] !== undefined) params[param] = take(param, v.dimsIn[row], `sheet row ${row}, ${v.id}`);
  }
  if (v.dimsIn.B !== undefined) params.FrameLength = take("FrameLength", v.dimsIn.B, `sheet row B, ${v.id}`);
  if (v.connectionIn !== null) params.InletDia = take("InletDia", v.connectionIn, `sheet System Connection (150#), ${v.id}`);
  if (v.panelIn) {
    params.PanelH = take("PanelH", v.panelIn.h, `sheet Panel Dimensions, ${v.id}`);
    params.PanelW = take("PanelW", v.panelIn.w, `sheet Panel Dimensions, ${v.id}`);
    params.PanelD = take("PanelD", v.panelIn.d, `sheet Panel Dimensions, ${v.id}`);
  }
  if (choice.manifoldLengthM !== undefined) { params.ManifoldLength = choice.manifoldLengthM; prov.push({ param: "ManifoldLength", valueM: choice.manifoldLengthM, source: "entered by the user or taken from another source; not on the sheet" }); }
  const model = sheet.model ?? "WiBooster";
  return {
    spec: { name: choice.name ?? `${model} ${v.flow} flow ${v.voltage}`, manufacturer: "Wilo", model, widthM, depthM, heightM, templateId: "booster", params },
    provenance: prov,
  };
}

/** One sheet per page that holds a table (a submittal has one page per model). The first with a table is the default for a single-model file. */
export function readBoosterSheets(pages: string[]): BoosterSheet[] {
  return pages.map((pg, i) => readOne([pg], i)).filter((x) => x.ok);
}

/** The first page with a readable table, or the failure reason when none has one. */
export function readBoosterSheet(pages: string[]): BoosterSheet {
  const all = readBoosterSheets(pages);
  return all[0] ?? readOne(pages, 0);
}
