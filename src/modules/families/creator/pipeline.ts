// Free family creator, slice 1: the build pipeline and its real status.
//
// Progress here is the number of stages that actually finished and passed
// their own check. There is no timer and no scripted sequence. A stage that
// fails stops the pipeline and says why.
//
// "Ready for Revit" does not exist in this slice on purpose. The platform
// can say the family is ready IN OpenBIMStudio, and that an IFC2X3 file was
// written and passed a structure check. Whether Revit accepts it is a
// separate fact that only a run in Revit can establish, so `revit` stays
// "unverified" until a person records a result.

import type { FamilyDefinition, FamilyType } from "../types";
import { readStep } from "../../ifc-semantics/step-reader";
import { pickOverallSize, type OverallSize } from "./cutsheet";
import { buildFamilyFromSpec, templateFor, validateSpec, type ProductSpec } from "./build";
import { resolveParts } from "./layout";
import { writeIfc2x3 } from "./ifc2x3";

export type StageState = "pending" | "running" | "done" | "failed";
export type StageId = "intake" | "family" | "engine" | "ifc";

export interface PipelineStage {
  id: StageId;
  /** English label, for logs and tests. The panel shows labelKey through i18n. */
  label: string;
  labelKey: string;
  state: StageState;
  detail?: string;
  /** i18n key and values for `detail`, so the UI can translate it. */
  detailKey?: string;
  detailVars?: Record<string, string | number>;
}

export interface CreatorStatus {
  stages: PipelineStage[];
  completed: number;
  total: number;
  /** completed / total, from real stage results only. */
  progress: number;
  /** True only when intake, family and engine stages all passed. */
  platformReady: boolean;
  exports: { ifc2x3: { state: "not-built" | "structure-checked" | "failed"; detail?: string } };
  /** Always "unverified" here. A person records a Revit result elsewhere. */
  revit: { state: "unverified"; note: string };
}

export interface CreatorInput {
  name: string;
  manufacturer?: string;
  model?: string;
  /** Text of the cut sheet or spec, one string per page. Used when `spec` is absent. */
  pages?: string[];
  /** Explicit spec, e.g. confirmed by the user. Wins over `pages`. */
  spec?: ProductSpec;
  /** Shape chosen by the user. Absent means pick from the product name. */
  templateId?: ProductSpec["templateId"];
}

export interface EngineBuildResult {
  object: unknown;
  params: Record<string, any>;
  errors: string[];
  /** [minX, minY, minZ, maxX, maxY, maxZ] in metres. */
  bbox: [number, number, number, number, number, number] | null;
}

export interface CreatorDeps {
  /** Build the family through the real parametric engine and measure it. */
  buildInEngine(family: FamilyDefinition, type: FamilyType): EngineBuildResult;
}

export interface CreatorResult {
  status: CreatorStatus;
  spec?: ProductSpec;
  size?: OverallSize;
  family?: FamilyDefinition;
  ifcText?: string;
}

const REVIT_NOTE = "Not verified in Revit. Open the IFC in Revit 2020 and record the result.";

function freshStatus(): CreatorStatus {
  const labels: Array<[StageId, string]> = [
    ["intake", "Read product size"],
    ["family", "Create editable family"],
    ["engine", "Build geometry in the engine"],
    ["ifc", "Write and check IFC2X3"],
  ];
  return {
    stages: labels.map(([id, label]) => ({ id, label, labelKey: `familyCreator.stage.${id}`, state: "pending" as StageState })),
    completed: 0, total: labels.length, progress: 0, platformReady: false,
    exports: { ifc2x3: { state: "not-built" } },
    revit: { state: "unverified", note: REVIT_NOTE },
  };
}

function refresh(s: CreatorStatus): void {
  s.completed = s.stages.filter((x) => x.state === "done").length;
  s.progress = s.completed / s.total;
  const done = (id: StageId) => s.stages.find((x) => x.id === id)?.state === "done";
  s.platformReady = done("intake") && done("family") && done("engine");
}

/** Structure check on written IFC text. Returns problems, empty when clean. */
export function checkIfcStructure(text: string, expectedParts: number): string[] {
  const problems: string[] = [];
  const file = readStep(text);
  if (file.schema !== "IFC2X3") problems.push(`schema is ${file.schema ?? "missing"}, expected IFC2X3`);
  if (file.warnings.length) problems.push(`reader warnings: ${file.warnings.slice(0, 3).join("; ")}`);
  const count = (name: string) => [...file.entities.values()].filter((e) => e.name === name).length;
  const elements = count("IFCFURNISHINGELEMENT") + count("IFCBUILDINGELEMENTPROXY");
  if (elements !== 1) problems.push(`expected 1 building element, found ${elements}`);
  if (count("IFCEXTRUDEDAREASOLID") !== expectedParts) {
    problems.push(`expected ${expectedParts} solids, found ${count("IFCEXTRUDEDAREASOLID")}`);
  }
  for (const need of ["IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCOWNERHISTORY", "IFCUNITASSIGNMENT"]) {
    if (count(need) !== 1) problems.push(`expected 1 ${need}, found ${count(need)}`);
  }
  // Every #n reference must point at a real entity.
  for (const e of file.entities.values()) {
    for (const m of e.raw.matchAll(/#(\d+)/g)) {
      if (!file.entities.has(Number(m[1]))) problems.push(`#${e.id} ${e.name} points at missing #${m[1]}`);
    }
  }
  return problems.slice(0, 10);
}

const TOL = 1e-6;

export function runCreator(
  input: CreatorInput,
  deps: CreatorDeps,
  onUpdate?: (s: CreatorStatus) => void,
): CreatorResult {
  const status = freshStatus();
  const result: CreatorResult = { status };
  const push = () => { refresh(status); onUpdate?.(JSON.parse(JSON.stringify(status))); };
  const stage = (id: StageId) => status.stages.find((x) => x.id === id) as PipelineStage;
  const fail = (id: StageId, detail: string, key = "familyCreator.detail.failed", vars?: Record<string, string | number>): CreatorResult => {
    stage(id).state = "failed"; stage(id).detail = detail;
    stage(id).detailKey = key; stage(id).detailVars = vars ?? { message: detail };
    if (id === "ifc") status.exports.ifc2x3 = { state: "failed", detail };
    push();
    return result;
  };
  const start = (id: StageId) => { stage(id).state = "running"; push(); };
  const pass = (id: StageId, detail: string, key?: string, vars?: Record<string, string | number>) => {
    stage(id).state = "done"; stage(id).detail = detail; stage(id).detailKey = key; stage(id).detailVars = vars; push();
  };

  // 1. intake
  start("intake");
  let spec: ProductSpec;
  if (input.spec) {
    spec = input.spec;
  } else {
    const size = pickOverallSize(input.pages ?? []);
    if (!size) return fail("intake", "No clear overall size (width x depth x height) found in the text. Enter the size yourself.", "familyCreator.detail.noSize", {});
    result.size = size;
    spec = {
      name: input.name, manufacturer: input.manufacturer, model: input.model,
      widthM: size.widthM, depthM: size.depthM, heightM: size.heightM,
      sources: size.sources, templateId: input.templateId,
    };
  }
  const problems = validateSpec(spec);
  if (problems.length) return fail("intake", problems.map((p) => `${p.field}: ${p.message}`).join("; "));
  result.spec = spec;
  const mmr = (v: number) => Math.round(v * 1000 * 100) / 100;
  pass("intake", `${mmr(spec.widthM)} x ${mmr(spec.depthM)} x ${mmr(spec.heightM)} mm (W x D x H)`, "familyCreator.detail.size",
    { w: mmr(spec.widthM), d: mmr(spec.depthM), h: mmr(spec.heightM) });

  // 2. family
  start("family");
  let family: FamilyDefinition;
  try { family = buildFamilyFromSpec(spec); } catch (e) { return fail("family", (e as Error).message); }
  result.family = family;
  pass("family", `${family.parameters.length} parameters, ${family.types.length} type`, "familyCreator.detail.familyOk",
    { n: family.parameters.length });

  // 3. engine
  start("engine");
  const type = family.types[0];
  let built: EngineBuildResult;
  try { built = deps.buildInEngine(family, type); } catch (e) { return fail("engine", (e as Error).message); }
  if (built.errors.length) return fail("engine", built.errors.join("; "));
  if (!built.bbox) return fail("engine", "Engine produced no geometry");
  const bb = built.bbox;
  const size = [bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]];
  const want = [spec.widthM, spec.heightM, spec.depthM];
  const names = ["width", "height", "depth"];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(size[i] - want[i]) > TOL) return fail("engine", `Built ${names[i]} ${size[i]} m does not match ${want[i]} m`);
  }
  if (Math.abs(bb[1]) > TOL) return fail("engine", `Base is at ${bb[1]} m, expected 0`);
  // The engine is Y-up: size is [X, Y, Z] = [width, height, depth]. Users see width x depth x height everywhere.
  const mmr2 = (v: number) => Math.round(v * 1000 * 100) / 100;
  const [bw, bh, bd] = [mmr2(size[0]), mmr2(size[1]), mmr2(size[2])];
  pass("engine", `${bw} x ${bd} x ${bh} mm (W x D x H)`, "familyCreator.detail.engineOk", { w: bw, d: bd, h: bh });

  // 4. ifc
  start("ifc");
  const tpl = templateFor(spec);
  let parts;
  try { parts = resolveParts(tpl, built.params); } catch (e) { return fail("ifc", (e as Error).message); }
  const lengthParams: Record<string, number> = {};
  for (const p of family.parameters) {
    const v = built.params[p.name];
    if (p.type === "length" && typeof v === "number") lengthParams[p.name] = v;
  }
  const out = writeIfc2x3({
    name: spec.name, manufacturer: spec.manufacturer, model: spec.model,
    entity: family.ifcEntity === "IfcFurnishingElement" ? "IfcFurnishingElement" : "IfcBuildingElementProxy",
    parts, lengthParams,
  });
  const bad = checkIfcStructure(out.text, parts.length);
  if (bad.length) return fail("ifc", bad.join("; "));
  result.ifcText = out.text;
  status.exports.ifc2x3 = { state: "structure-checked", detail: `${out.entityCount} entities, ${parts.length} solids` };
  pass("ifc", `${out.entityCount} entities`, "familyCreator.detail.ifcOk", { n: out.entityCount });
  return result;
}
