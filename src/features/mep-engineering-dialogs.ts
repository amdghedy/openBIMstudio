/**
 * MEP engineering calculator dialogs — UI wiring for two previously orphaned
 * engine modules:
 *
 *   • modules/mep/cable-tray.ts  (NEC 392 tray fill + sizing)  → Tray Fill dialog
 *   • modules/mep/hangers.ts     (SMACNA / MSS SP-69 spans)    → Hanger Spacing dialog
 *
 * Same runner pattern as mep-fabrication.ts: openFormModal → validate →
 * call the pure module → showResultDialog. Nothing here computes numbers
 * itself; every value comes from the engine module.
 */
import { openFormModal } from "./form-modal";
import { showResultDialog, type ResultRow } from "./mep-fabrication";
import {
  calcTrayFill,
  suggestTraySize,
  WIRE_DATA,
  type CableSpec,
  type WireGauge,
} from "../modules/mep/cable-tray";
import {
  placeHangers,
  DEFAULT_HANGER_RULES,
  type HangerRules,
} from "../modules/mep/hangers";
import { notify } from "../core/notify";
import { fmtNumber } from "../core/region";

const WIRE_CHOICES = (Object.keys(WIRE_DATA) as WireGauge[]).map((g) => [g, `${g} — OD ${WIRE_DATA[g].singleCoreODMm} mm`] as [string, string]);

const mustBePositiveInt = (label: string) => (v: string | number | boolean) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? null : `${label}: enter a positive whole number`;
};
const mustBePositiveNum = (label: string) => (v: string | number | boolean) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? null : `${label}: enter a positive number`;
};

/** NEC 392 cable tray fill ratio + suggested standard width. */
export async function openTrayFillDialog(): Promise<void> {
  const vals = await openFormModal({
    title: "Cable Tray Fill Calculator (NEC 392)",
    fields: [
      { kind: "select", key: "gauge", label: "Wire / cable gauge", options: WIRE_CHOICES, default: "12AWG" },
      { kind: "number", key: "conductors", label: "Conductors per cable", default: 3, validate: mustBePositiveInt("Conductors") },
      { kind: "number", key: "outerDiameter", label: "Cable outer diameter (mm)", default: 12, validate: mustBePositiveNum("Outer diameter") },
      { kind: "number", key: "quantity", label: "Cables in tray", default: 10, validate: mustBePositiveInt("Cables") },
      { kind: "number", key: "trayWidth", label: "Tray width (mm)", default: 300, validate: mustBePositiveNum("Tray width") },
      { kind: "number", key: "trayDepth", label: "Tray depth (mm)", default: 100, validate: mustBePositiveNum("Tray depth") },
    ],
    submitLabel: "Check Fill",
  });
  if (!vals) return;

  const spec: CableSpec = {
    id: "cable-1",
    gauge: String(vals.gauge) as WireGauge,
    conductorCount: Number(vals.conductors),
    cableOuterDiameterMm: Number(vals.outerDiameter),
    quantity: Number(vals.quantity),
  };

  const width = Number(vals.trayWidth);
  const depth = Number(vals.trayDepth);
  const r = calcTrayFill(width, depth, [spec]);
  const suggested = suggestTraySize([spec], depth);
  const rows: ResultRow[] = [
    { label: "Tray (W × D)", value: `${r.trayWidthMm} × ${r.trayDepthMm} mm` },
    { label: "Tray cross-section", value: `${fmtNumber(r.trayAreaMm2)} mm²` },
    { label: "Total cable area", value: `${fmtNumber(r.totalCableAreaMm2)} mm²` },
    { label: "Allowable fill", value: `${r.allowableFillPercent}%` },
    { label: "Actual fill", value: `${r.actualFillPercent}%`, strong: true },
    { label: "Status", value: r.status.toUpperCase() },
    { label: "Suggested standard width", value: `${suggested.widthMm} mm (depth ${suggested.depthMm} mm)`, strong: true },
  ];

  showResultDialog("Cable Tray Fill — NEC 392", rows, [
    `${r.recommendation} (limit band: fill > ${r.allowableFillPercent - 8}% warns, > ${r.allowableFillPercent}% fails)`,
  ]);
  notify(r.status === "ok" ? "success" : "warn", `Tray fill: ${r.actualFillPercent}% — ${r.status}`);
}

/** SMACNA / MSS SP-69 hanger spacing for a straight duct/pipe run. */
export async function openHangerSpacingDialog(): Promise<void> {
  const vals = await openFormModal({
    title: "Hanger Spacing — SMACNA / MSS SP-69",
    fields: [
      { kind: "select", key: "element", label: "Run type", options: [["duct", "Duct (SMACNA, max span 2.4 m)"], ["pipe", "Pipe (MSS SP-69, max span 3.0 m)"], ["cable-tray", "Cable tray (MSS SP-69, max span 3.0 m)"], ["conduit", "Conduit (MSS SP-69, max span 3.0 m)"]], default: "duct" },
      { kind: "number", key: "length", label: "Straight run length (m)", default: 12, validate: mustBePositiveNum("Length") },
      { kind: "number", key: "size", label: "Size (mm, for load estimate)", default: 300, validate: mustBePositiveNum("Size") },
      { kind: "number", key: "rod", label: "Rod diameter (mm)", default: DEFAULT_HANGER_RULES.rodDiameterMm, validate: mustBePositiveNum("Rod diameter") },
    ],
    submitLabel: "Place Hangers",
  });
  if (!vals) return;

  const rules: HangerRules = {
    ...DEFAULT_HANGER_RULES,
    rodDiameterMm: Number(vals.rod),
  };

  const len = Number(vals.length);
  const legs = [{
    start: { x: 0, y: 0, z: 0 },
    end: { x: len, y: 0, z: 0 },
    length: len,
    planAngle: 0,
    isVertical: false,
  }];
  const hangers = placeHangers(legs as any, String(vals.element) as any, Number(vals.size), rules);

  const maxSpan = String(vals.element) === "duct" ? rules.maxSpanDuctM : rules.maxSpanPipeM;
  const rows: ResultRow[] = [
    { label: "Run", value: `${len} m × ${Number(vals.size)} mm ${String(vals.element)}` },
    { label: "Max span (standard)", value: `${maxSpan} m`, strong: true },
    { label: "Hangers required", value: String(hangers.length), strong: true },
    { label: "Actual spacing", value: hangers.length >= 2 ? `${(len / (hangers.length + 1)).toFixed(2)} m` : `${(len / 2).toFixed(2)} m` },
    { label: "Hanger type", value: hangers[0]?.type ?? rules.hangerType },
    { label: "Rod", value: `${rules.rodDiameterMm} mm × 600 mm drop` },
    { label: "Design load / hanger", value: `${hangers[0]?.loadKg ?? 0} kg` },
  ];
  const positions = hangers.slice(0, 6).map((h) => `${h.id} @ ${h.position.x.toFixed(2)} m`);

  showResultDialog("Hanger Placement", rows, [
    positions.length ? `Positions along run: ${positions.join(" · ")}${hangers.length > 6 ? ` … (+${hangers.length - 6} more)` : ""}` : "Run is shorter than 0.5 m — no hangers required.",
    "Vertical risers are not included — riser clamps govern per the same standards.",
  ]);
  notify("success", `${hangers.length} hanger(s) required — max span ${maxSpan} m`);
}
