/**
 * Professional BIM Object Studio.
 *
 * A searchable, discipline-aware object browser that activates the same
 * authoring engine used by the ribbon, but exposes a much wider openBIM
 * family vocabulary: architecture, structure, HVAC, plumbing, fire,
 * electrical, ELV, site and generic model components.
 */
import { ctx } from "../core/context";
import { setAuthoringTool, getActiveTool } from "./authoring";
import { togglePropertyPalette } from "./property-palette";

interface BimFamilyDef {
  id: string;
  family: string;
  discipline: string;
  command: string;
  placement: "Point" | "Linear" | "Hosted" | "Polygon";
  description: string;
  tags: string[];
}

const families: BimFamilyDef[] = [
  // Architecture
  { id: "wall", family: "Wall", discipline: "Architecture", command: "wall", placement: "Linear", description: "Basic compound wall authoring with chain, offset and opening hosting.", tags: ["architectural", "host"] },
  { id: "floor", family: "Floor", discipline: "Architecture", command: "floor", placement: "Polygon", description: "Plan-profile slab/floor modeling.", tags: ["slab", "architectural"] },
  { id: "roof", family: "Roof", discipline: "Architecture", command: "roof", placement: "Polygon", description: "Roof profile authoring through the slab profile engine.", tags: ["architectural", "roof"] },
  { id: "ceiling", family: "Ceiling", discipline: "Architecture", command: "ceiling", placement: "Polygon", description: "Ceiling profile for reflected ceiling / coordination workflows.", tags: ["rCP", "architectural"] },
  { id: "door", family: "Door", discipline: "Architecture", command: "door", placement: "Hosted", description: "Wall-hosted parametric door with panel variants.", tags: ["hosted", "opening"] },
  { id: "window", family: "Window", discipline: "Architecture", command: "window", placement: "Hosted", description: "Wall-hosted parametric window with sill, frame and panel variants.", tags: ["hosted", "opening"] },
  { id: "column", family: "Column", discipline: "Architecture", command: "column", placement: "Point", description: "Vertical architectural column placeholder with instance dimensions.", tags: ["vertical"] },
  { id: "stairs", family: "Stair", discipline: "Architecture", command: "stairs", placement: "Point", description: "Stair family preset ready for native parameter expansion.", tags: ["vertical", "circulation"] },
  { id: "railing", family: "Railing", discipline: "Architecture", command: "railing", placement: "Point", description: "Railing family preset for architectural circulation and safety.", tags: ["guard", "circulation"] },
  { id: "ramp", family: "Ramp", discipline: "Architecture", command: "ramp", placement: "Point", description: "Ramp family preset for accessible circulation.", tags: ["circulation"] },
  { id: "curtain-wall", family: "Curtain Wall", discipline: "Architecture", command: "curtain-wall", placement: "Linear", description: "Curtain wall profile using the wall engine and type presets.", tags: ["facade", "wall"] },
  { id: "furniture", family: "Furniture", discipline: "Architecture", command: "furniture", placement: "Point", description: "Generic furniture object with dimensional parameters.", tags: ["interior", "generic"] },
  { id: "opening", family: "Opening", discipline: "Architecture", command: "opening", placement: "Hosted", description: "Hosted opening placeholder for coordinated penetrations.", tags: ["opening", "host"] },
  { id: "shaft", family: "Shaft Opening", discipline: "Architecture", command: "shaft", placement: "Point", description: "Vertical shaft/opening placeholder for multi-level coordination.", tags: ["shaft", "opening"] },

  // Structure
  { id: "beam", family: "Beam", discipline: "Structure", command: "beam", placement: "Linear", description: "Structural framing member.", tags: ["framing"] },
  { id: "brace", family: "Brace", discipline: "Structure", command: "brace", placement: "Linear", description: "Diagonal structural brace.", tags: ["framing", "diagonal"] },
  { id: "truss", family: "Truss", discipline: "Structure", command: "truss", placement: "Linear", description: "Panelized structural truss.", tags: ["framing"] },
  { id: "footing", family: "Isolated Footing", discipline: "Structure", command: "footing", placement: "Point", description: "Pad footing with width/depth/thickness controls.", tags: ["foundation"] },
  { id: "strip", family: "Strip Footing", discipline: "Structure", command: "strip", placement: "Linear", description: "Continuous strip foundation.", tags: ["foundation"] },
  { id: "pile", family: "Pile", discipline: "Structure", command: "pile", placement: "Point", description: "Pile family preset for foundation layouts.", tags: ["foundation", "deep"] },
  { id: "anchor-bolt", family: "Anchor Bolt", discipline: "Structure", command: "anchor-bolt", placement: "Point", description: "Structural fixing / embedded accessory.", tags: ["connection"] },
  { id: "bearing", family: "Bearing", discipline: "Structure", command: "bearing", placement: "Point", description: "Structural bearing family.", tags: ["connection", "bridge"] },
  { id: "rebar-host", family: "Rebar / Reinforcement Host", discipline: "Structure", command: "rebar-host", placement: "Point", description: "Reinforcement placeholder for openBIM detailing/coordination.", tags: ["rebar", "concrete"] },
  { id: "structural-connection", family: "Structural Connection", discipline: "Structure", command: "structural-connection", placement: "Point", description: "Connection/accessory placeholder with connection metadata.", tags: ["connection", "steel"] },

  // HVAC / Mechanical
  { id: "duct", family: "Duct", discipline: "Mechanical", command: "duct", placement: "Linear", description: "Duct run with chain bends and automatic fitting generation.", tags: ["HVAC", "MEP"] },
  { id: "flex-duct", family: "Flex Duct", discipline: "Mechanical", command: "flex-duct", placement: "Linear", description: "Flexible duct family preset.", tags: ["HVAC", "flex"] },
  { id: "air-handler", family: "Air Handling Unit", discipline: "Mechanical", command: "air-handler", placement: "Point", description: "AHU family with dimensional and metadata defaults.", tags: ["AHU", "HVAC"] },
  { id: "fan", family: "Fan", discipline: "Mechanical", command: "fan", placement: "Point", description: "Mechanical fan with rotor representation.", tags: ["HVAC"] },
  { id: "pump", family: "Pump", discipline: "Mechanical", command: "pump", placement: "Point", description: "Pump family with motor and body representation.", tags: ["HVAC", "plumbing"] },
  { id: "chiller", family: "Chiller", discipline: "Mechanical", command: "chiller", placement: "Point", description: "Chiller equipment family.", tags: ["HVAC", "plant"] },
  { id: "boiler", family: "Boiler", discipline: "Mechanical", command: "boiler", placement: "Point", description: "Boiler equipment family.", tags: ["HVAC", "plant"] },
  { id: "cooling-tower", family: "Cooling Tower", discipline: "Mechanical", command: "cooling-tower", placement: "Point", description: "Cooling tower with tapered top representation.", tags: ["HVAC", "plant"] },
  { id: "vav", family: "VAV", discipline: "Mechanical", command: "vav", placement: "Point", description: "Variable-air-volume box family.", tags: ["HVAC"] },
  { id: "diffuser", family: "Air Diffuser", discipline: "Mechanical", command: "diffuser", placement: "Point", description: "Ceiling air diffuser representation.", tags: ["terminal", "HVAC"] },
  { id: "grille", family: "Air Grille", discipline: "Mechanical", command: "grille", placement: "Point", description: "Supply/return grille family.", tags: ["terminal", "HVAC"] },
  { id: "damper", family: "Damper", discipline: "Mechanical", command: "damper", placement: "Point", description: "Duct accessory / damper family.", tags: ["accessory", "HVAC"] },
  { id: "valve", family: "Valve", discipline: "Mechanical", command: "valve", placement: "Point", description: "Inline valve family preset.", tags: ["accessory", "MEP"] },
  { id: "filter", family: "Filter", discipline: "Mechanical", command: "filter", placement: "Point", description: "Filter/accessory family.", tags: ["accessory", "HVAC"] },
  { id: "duct-fitting", family: "Duct Fitting", discipline: "Mechanical", command: "duct-fitting", placement: "Point", description: "Duct fitting family for coordinated junctions and changes of direction.", tags: ["HVAC", "fitting"] },
  { id: "duct-accessory", family: "Duct Accessory", discipline: "Mechanical", command: "duct-accessory", placement: "Point", description: "Damper/filter/silencer accessory class.", tags: ["HVAC", "accessory"] },
  { id: "duct-insulation", family: "Duct Insulation", discipline: "Mechanical", command: "generic-model", placement: "Linear", description: "Insulation coordination preset associated with duct runs.", tags: ["HVAC", "insulation"] },

  // Plumbing / Fire
  { id: "pipe", family: "Pipe", discipline: "Plumbing", command: "pipe", placement: "Linear", description: "Pipe run with automatic bend fittings.", tags: ["plumbing", "MEP"] },
  { id: "plumbing-fixture", family: "Plumbing Fixture", discipline: "Plumbing", command: "plumbing-fixture", placement: "Point", description: "General plumbing fixture family.", tags: ["plumbing"] },
  { id: "toilet", family: "Toilet", discipline: "Plumbing", command: "toilet", placement: "Point", description: "Sanitary fixture representation.", tags: ["sanitary"] },
  { id: "washbasin", family: "Wash Basin", discipline: "Plumbing", command: "washbasin", placement: "Point", description: "Basin fixture representation.", tags: ["sanitary"] },
  { id: "water-heater", family: "Water Heater", discipline: "Plumbing", command: "water-heater", placement: "Point", description: "Water heating equipment family.", tags: ["domestic water"] },
  { id: "pipe-fitting", family: "Pipe Fitting", discipline: "Plumbing", command: "pipe-fitting", placement: "Point", description: "Pipe fitting preset for elbows, tees and connection geometry.", tags: ["plumbing", "fitting"] },
  { id: "pipe-accessory", family: "Pipe Accessory", discipline: "Plumbing", command: "pipe-accessory", placement: "Point", description: "Valve/strainer/control accessory preset for pipe systems.", tags: ["plumbing", "accessory"] },
  { id: "pipe-insulation", family: "Pipe Insulation", discipline: "Plumbing", command: "generic-model", placement: "Linear", description: "Insulation coordination preset associated with pipe runs.", tags: ["plumbing", "insulation"] },
  { id: "sprinkler", family: "Sprinkler", discipline: "Fire", command: "sprinkler", placement: "Point", description: "Fire sprinkler family preset.", tags: ["fire"] },
  { id: "fire-pump", family: "Fire Pump", discipline: "Fire", command: "fire-pump", placement: "Point", description: "Fire pump equipment family.", tags: ["fire", "plant"] },
  { id: "fire-extinguisher", family: "Fire Extinguisher", discipline: "Fire", command: "fire-extinguisher", placement: "Point", description: "Portable firefighting equipment.", tags: ["fire"] },
  { id: "hose-reel", family: "Hose Reel", discipline: "Fire", command: "hose-reel", placement: "Point", description: "Fire hose reel family.", tags: ["fire"] },
  { id: "smoke-detector", family: "Smoke Detector", discipline: "Fire", command: "smoke-detector", placement: "Point", description: "Detection device family.", tags: ["fire", "alarm"] },

  // Electrical / ELV
  { id: "cable-tray", family: "Cable Tray", discipline: "Electrical", command: "cable-tray", placement: "Linear", description: "Cable tray run with automatic bend fittings.", tags: ["containment"] },
  { id: "cable-tray-fitting", family: "Cable Tray Fitting", discipline: "Electrical", command: "cable-tray-fitting", placement: "Point", description: "Elbow/tee/cross fitting preset for containment coordination.", tags: ["containment", "fitting"] },
  { id: "conduit", family: "Conduit", discipline: "Electrical", command: "conduit", placement: "Linear", description: "Conduit run with automatic fittings.", tags: ["containment"] },
  { id: "conduit-fitting", family: "Conduit Fitting", discipline: "Electrical", command: "conduit-fitting", placement: "Point", description: "Conduit bend/junction fitting preset.", tags: ["containment", "fitting"] },
  { id: "panel", family: "Panel", discipline: "Electrical", command: "panel", placement: "Point", description: "Electrical panelboard family.", tags: ["power"] },
  { id: "switchgear", family: "Switchgear", discipline: "Electrical", command: "switchgear", placement: "Point", description: "Switchgear family with front-face representation.", tags: ["power"] },
  { id: "ups", family: "UPS", discipline: "Electrical", command: "ups", placement: "Point", description: "UPS equipment family.", tags: ["power"] },
  { id: "transformer", family: "Transformer", discipline: "Electrical", command: "transformer", placement: "Point", description: "Transformer equipment family.", tags: ["power"] },
  { id: "generator", family: "Generator", discipline: "Electrical", command: "generator", placement: "Point", description: "Generator family.", tags: ["power", "plant"] },
  { id: "lighting-fixture", family: "Lighting Fixture", discipline: "Electrical", command: "lighting-fixture", placement: "Point", description: "Luminaire family.", tags: ["lighting"] },
  { id: "emergency-light", family: "Emergency Light", discipline: "Electrical", command: "emergency-light", placement: "Point", description: "Emergency lighting family.", tags: ["lighting", "life safety"] },
  { id: "rack", family: "IT Rack", discipline: "ELV", command: "rack", placement: "Point", description: "Equipment rack with shelf/detail representation.", tags: ["ICT", "rack"] },
  { id: "camera", family: "CCTV Camera", discipline: "ELV", command: "camera", placement: "Point", description: "Security camera family.", tags: ["CCTV", "security"] },
  { id: "access-control", family: "Access Control", discipline: "ELV", command: "access-control", placement: "Point", description: "Access-control reader family.", tags: ["security"] },
  { id: "speaker", family: "Speaker", discipline: "ELV", command: "speaker", placement: "Point", description: "AV / public-address speaker.", tags: ["AV", "ELV"] },

  // Site / generic
  { id: "bollard", family: "Bollard", discipline: "Site", command: "bollard", placement: "Point", description: "Site safety bollard.", tags: ["site"] },
  { id: "landscape-component", family: "Landscape Component", discipline: "Site", command: "landscape-component", placement: "Point", description: "Landscape/site component family.", tags: ["site", "landscape"] },
  { id: "generic-model", family: "Generic Model", discipline: "General", command: "generic-model", placement: "Point", description: "Generic openBIM object with custom properties.", tags: ["generic", "custom"] },
];

let panel: HTMLDivElement | null = null;
let visible = false;
let activeDiscipline = "All";
let query = "";

function showToast(message: string, kind: "info" | "success" | "warn" = "info") {
  window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message, kind } }));
}

function filtered(): BimFamilyDef[] {
  const q = query.trim().toLowerCase();
  return families.filter((f) => {
    if (activeDiscipline !== "All" && f.discipline !== activeDiscipline) return false;
    if (!q) return true;
    return `${f.family} ${f.discipline} ${f.placement} ${f.description} ${f.tags.join(" ")}`.toLowerCase().includes(q);
  });
}

function ensurePanel(): HTMLDivElement {
  if (panel) return panel;
  panel = document.createElement("div");
  panel.id = "obs-bim-object-studio";
  panel.style.cssText =
    "position:absolute;left:12px;top:72px;bottom:12px;width:360px;z-index:54;display:none;" +
    "flex-direction:column;background:var(--bg-floating,#171923);border:1px solid var(--border-default,#313747);" +
    "border-radius:10px;box-shadow:0 16px 40px rgba(0,0,0,.52);color:var(--text-primary,#eef2f7);font:12px system-ui,sans-serif;overflow:hidden";
  panel.addEventListener("mousedown", (e) => e.stopPropagation());
  ctx.rightHost.appendChild(panel);
  return panel;
}

function renderPanel() {
  const host = ensurePanel();
  host.innerHTML = "";

  const header = document.createElement("div");
  header.style.cssText = "padding:10px 12px;border-bottom:1px solid var(--border-subtle,#252936);background:var(--bg-elevated,#1b1e29)";
  header.innerHTML = `<div style="font-weight:800;letter-spacing:.15px">BIM Object Studio</div><div style="font-size:10px;color:var(--text-tertiary,#8891a3);margin-top:2px">Parametric family presets · openBIM authoring</div>`;
  host.appendChild(header);

  const toolbar = document.createElement("div");
  toolbar.style.cssText = "display:flex;gap:6px;padding:8px;border-bottom:1px solid var(--border-subtle,#252936)";
  const search = document.createElement("input");
  search.placeholder = "Search families, discipline, tags…";
  search.value = query;
  search.style.cssText = "flex:1;padding:7px 8px;background:#0f1118;border:1px solid #303646;border-radius:6px;color:#eef2f7;font-size:11px";
  search.oninput = () => { query = search.value; renderPanel(); };
  toolbar.appendChild(search);
  host.appendChild(toolbar);

  const discs = ["All", ...Array.from(new Set(families.map((f) => f.discipline)))];
  const filters = document.createElement("div");
  filters.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;padding:6px 8px;border-bottom:1px solid var(--border-subtle,#252936)";
  for (const d of discs) {
    const btn = document.createElement("button");
    btn.textContent = d;
    btn.style.cssText = `padding:4px 7px;border-radius:999px;border:1px solid ${d === activeDiscipline ? "#38bdf8" : "#343a49"};background:${d === activeDiscipline ? "rgba(56,189,248,.12)" : "#0f1118"};color:${d === activeDiscipline ? "#bae6fd" : "#aeb7c7"};font-size:10px;cursor:pointer`;
    btn.onclick = () => { activeDiscipline = d; renderPanel(); };
    filters.appendChild(btn);
  }
  host.appendChild(filters);

  const count = document.createElement("div");
  count.textContent = `${filtered().length} family preset(s)`;
  count.style.cssText = "padding:6px 10px 4px;color:#778195;font-size:10px";
  host.appendChild(count);

  const list = document.createElement("div");
  list.style.cssText = "flex:1;overflow:auto;padding:4px 7px";

  for (const f of filtered()) {
    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:1fr auto;gap:8px;padding:8px 8px;border:1px solid #2a2f3b;border-radius:7px;margin:4px 0;background:#11141c";

    const text = document.createElement("div");
    const title = document.createElement("div");
    title.textContent = f.family;
    title.style.cssText = "font-weight:700;font-size:11.5px";
    const meta = document.createElement("div");
    meta.textContent = `${f.discipline} · ${f.placement} · ${f.command}`;
    meta.style.cssText = "font-size:9.5px;color:#8f99ab;margin-top:2px";
    const desc = document.createElement("div");
    desc.textContent = f.description;
    desc.style.cssText = "font-size:10px;color:#c2c8d4;line-height:1.35;margin-top:4px";
    text.append(title, meta, desc);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;flex-direction:column;gap:4px";
    const place = document.createElement("button");
    place.textContent = "Place";
    place.style.cssText = "padding:5px 8px;border:1px solid #38bdf8;background:rgba(56,189,248,.10);color:#bae6fd;border-radius:5px;cursor:pointer;font-size:10px;font-weight:700";
    place.onclick = () => {
      setAuthoringTool(f.command);
      showToast(`${f.family} active · ${f.placement} placement`, "success");
    };
    const props = document.createElement("button");
    props.textContent = "Props";
    props.style.cssText = "padding:5px 8px;border:1px solid #343a49;background:#171a22;color:#cbd5e1;border-radius:5px;cursor:pointer;font-size:10px";
    props.onclick = () => { setAuthoringTool(f.command); togglePropertyPalette(); };
    actions.append(place, props);
    row.append(text, actions);
    list.appendChild(row);
  }
  host.appendChild(list);

  const footer = document.createElement("div");
  footer.style.cssText = "padding:7px 9px;border-top:1px solid #252936;color:#707b8f;font-size:9.5px";
  footer.textContent = `Active: ${getActiveTool() ?? "Select"} · Use Properties to set dimensions/type defaults before placement.`;
  host.appendChild(footer);
}

export function openBimObjectStudio() {
  ensurePanel();
  visible = true;
  panel!.style.display = "flex";
  renderPanel();
}

export function closeBimObjectStudio() {
  if (!panel) return;
  visible = false;
  panel.style.display = "none";
}

export function toggleBimObjectStudio() {
  if (visible) closeBimObjectStudio(); else openBimObjectStudio();
}

export function isBimObjectStudioVisible() { return visible; }

export function setupBimObjectStudio() {
  ctx.features.bimObjectStudio = {
    open: openBimObjectStudio,
    close: closeBimObjectStudio,
    toggle: toggleBimObjectStudio,
    isVisible: isBimObjectStudioVisible,
    families,
  };
}
