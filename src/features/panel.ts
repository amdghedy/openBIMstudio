/** Assembles the BIM side panel from every feature's exported UI elements. */
import * as BUI from "@thatopen/ui";
import { ctx } from "../core/context";
import {
  pickFiles, loadIfcFiles, loadFragFiles,
  settingsBox, queueSummaryEl, queueButtons, queueListEl, loadStatusEl,
  positioningSelect,
} from "./importer";
import {
  setProjection, saveHome, goHome, fitAll, takeScreenshot,
  recenterSceneNow, resetOffsets, showBoundsHelpers, boundsInfoEl,
} from "./camera-tools";
import { setSectionCheckboxRef, setSectionOn } from "./section";
import { setMeasureCheckboxRef, setMeasureEnabled, clearMeasurements } from "./measure";
import { activeToolLabel, setAuthoringTool } from "./authoring";
import {
  runElementClashDetection, clearClash, changeCropMargin, resetCropMargin,
  removeCropBox, setTolerance, getTolerance, setClearance, getClearance,
  clashStatusEl, clashListEl, selABox, selBBox,
  clashSummaryEl, clashProgressEl, clashCancelBtn,
  clashMethodSelect, clashMethodDesc,
  clashScopeSelect,
  testNameInput, cropInfoEl, cropMarginLabel,
  scenarioPanel,
} from "./clash";
import { toggleReview } from "./clash-review";
import { toggleAlign } from "./model-align";

export function buildPanel() {
  const panel = BUI.Component.create(() => {
    return BUI.html`
      <bim-panel label="Open BIM Studio" active style="width:100%">
        <bim-panel-section label="Load Models" icon="mdi:folder-open" collapsed>
          <div style="font-size:11px;margin:6px 10px 2px;opacity:.85;font-weight:600;color:var(--text-secondary)">
            Positioning (linking)
          </div>
          ${positioningSelect}
          <div style="font-size:10.5px;margin:-4px 10px 8px;opacity:.55;line-height:1.5">
            How to place the next file relative to those already loaded.
            <b>Origin to Origin</b> preserves IFC shared coordinates.
            <b>Center to Center</b> always stacks files visually.
            <b>Manual</b> leaves each file where its own origin sits.
          </div>

          <bim-button label="📄  Import IFC file"
            @click=${() => pickFiles(".ifc,application/x-step,application/octet-stream", true, loadIfcFiles)}></bim-button>
          <bim-button label="📦  Load .frag file(s)"
            @click=${() => pickFiles(".frag,application/octet-stream", true, loadFragFiles)}></bim-button>
          <bim-button label="⛓  Model alignment…"
            @click=${() => toggleAlign()}></bim-button>
          <div style="font-size:11px;opacity:.6;margin:8px 10px 4px;line-height:1.5">
            IFC → FRAG conversion runs in the browser.
            You can also <b>drag &amp; drop</b> files onto the 3D view.
          </div>
          ${settingsBox}
          ${queueSummaryEl}
          ${queueButtons}
          ${queueListEl}
          ${loadStatusEl}
        </bim-panel-section>

        <bim-panel-section label="Models" icon="mdi:cube-outline" collapsed>
          ${ctx.modelsList}
        </bim-panel-section>

        <bim-panel-section label="Properties" icon="mdi:information-outline" collapsed>
          <bim-text-input placeholder="Filter properties…"
            @input=${({ target }: any) => { ctx.props.table.queryString = target.value; }}></bim-text-input>
          ${ctx.props.table}
        </bim-panel-section>

        <bim-panel-section label="View" icon="mdi:rotate-3d" collapsed>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 10px">
            <bim-button label="Perspective" @click=${() => setProjection("perspective")}></bim-button>
            <bim-button label="Orthographic" @click=${() => setProjection("orthographic")}></bim-button>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:4px 10px">
            <bim-button label="Set Home" @click=${() => saveHome()}></bim-button>
            <bim-button label="Go Home" @click=${() => goHome()}></bim-button>
          </div>
          <bim-button label="⛶  Fit to View" @click=${() => fitAll()}></bim-button>
        </bim-panel-section>

        <bim-panel-section label="Modeling Tools" icon="mdi:pencil" collapsed>
          <div style="font-size:11.5px;opacity:.7;margin:4px 10px 8px;line-height:1.55">
            Click on the model to place points. Two points = one segment.<br>
            <b style="color:var(--accent)">AccuDraw</b>:
            <b>Shift</b> ortho ·
            <b>X / Z / Y</b> axis lock ·
            <b>A</b> angle snap ·
            type a number to lock distance.
          </div>
          <bim-button label="🧱  Draw Wall"     @click=${() => { setAuthoringTool("wall");     setMeasureEnabled(false); setSectionOn(false); }}></bim-button>
          <bim-button label="▬  Draw Beam"     @click=${() => { setAuthoringTool("beam");     setMeasureEnabled(false); setSectionOn(false); }}></bim-button>
          <bim-button label="▭  Draw Slab"     @click=${() => { setAuthoringTool("slab");     setMeasureEnabled(false); setSectionOn(false); }}></bim-button>
          <bim-button label="▮  Draw Column"   @click=${() => { setAuthoringTool("column");   setMeasureEnabled(false); setSectionOn(false); }}></bim-button>
          <bim-button label="⬚  Draw Duct"     @click=${() => { setAuthoringTool("duct");     setMeasureEnabled(false); setSectionOn(false); }}></bim-button>
          <bim-button label="○  Draw Pipe"     @click=${() => { setAuthoringTool("pipe");     setMeasureEnabled(false); setSectionOn(false); }}></bim-button>
          <bim-button label="🚪  Insert Door"   @click=${() => { setAuthoringTool("door");     setMeasureEnabled(false); setSectionOn(false); }}></bim-button>
          <bim-button label="🪟  Insert Window" @click=${() => { setAuthoringTool("window");   setMeasureEnabled(false); setSectionOn(false); }}></bim-button>
          <bim-button label="✖  Stop drawing"  @click=${() => setAuthoringTool(null)}></bim-button>
          ${activeToolLabel}
        </bim-panel-section>

        <bim-panel-section label="Clash Detection" icon="mdi:alert-outline" collapsed>
          <div style="font-size:11px;opacity:.7;margin:4px 10px 8px">
            Navisworks-style test · 8 detection methods.
          </div>

          <div style="font-size:11px;margin:6px 10px 2px;opacity:.8">Test name</div>
          ${testNameInput}

          <div style="font-size:11px;margin:6px 10px 2px;opacity:.8">Method</div>
          ${clashMethodSelect}
          ${clashMethodDesc}

          <div style="font-size:11px;margin:6px 10px 2px;opacity:.8">Scope</div>
          ${clashScopeSelect}

          ${clashSummaryEl}

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 10px">
            <div>
              <div style="font-size:11px;font-weight:600;margin-bottom:4px;color:#93c5fd">Selection A</div>
              ${selABox}
            </div>
            <div>
              <div style="font-size:11px;font-weight:600;margin-bottom:4px;color:#fca5a5">Selection B</div>
              ${selBBox}
            </div>
          </div>

          <bim-number-input slider label="Tolerance (m)" value=${getTolerance()} min=0 max=0.5 step=0.005
            @change=${({ target }: any) => setTolerance(Number(target.value) || 0)}></bim-number-input>
          <bim-number-input slider label="Clearance band (m)" value=${getClearance()} min=0 max=2 step=0.01
            @change=${({ target }: any) => setClearance(Number(target.value) || 0)}></bim-number-input>

          <bim-button label="▶  Run Clash Test" @click=${() => void runElementClashDetection()}></bim-button>
          <bim-button label="✖  Reset results" @click=${() => void clearClash()}></bim-button>
          <bim-button label="🔍  Open Clash Review window" @click=${() => toggleReview()}></bim-button>

          ${clashProgressEl}
          ${clashCancelBtn}

          <div style="font-size:11px;font-weight:600;margin:12px 10px 4px;opacity:0.85">Results</div>
          ${clashStatusEl}
          ${clashListEl}
          ${scenarioPanel}
        </bim-panel-section>

        <bim-panel-section label="Crop Box" icon="mdi:cube-scan" collapsed>
          ${cropMarginLabel}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:4px 10px">
            <bim-button label="− 10 cm" @click=${() => changeCropMargin(-0.1)}></bim-button>
            <bim-button label="+ 10 cm" @click=${() => changeCropMargin(0.1)}></bim-button>
            <bim-button label="Reset 30 cm" @click=${() => resetCropMargin()}></bim-button>
            <bim-button label="Remove crop" @click=${() => removeCropBox()}></bim-button>
          </div>
          <bim-button label="⛶  Fit all" @click=${() => fitAll()}></bim-button>
          ${cropInfoEl}
        </bim-panel-section>

        <bim-panel-section label="Section Cut" icon="mdi:scissors-cutting" collapsed>
          <bim-checkbox label="Enable section (double-click)"
            data-section
            @change=${({ target }: any) => {
              setSectionCheckboxRef(target);
              setSectionOn(target.checked);
              if (target.checked) setMeasureEnabled(false);
            }}></bim-checkbox>
          <bim-button label="🗑  Delete all planes" @click=${() => { try { ctx.clipper.deleteAll(); } catch { /* */ } }}></bim-button>
        </bim-panel-section>

        <bim-panel-section label="Measure & Snap" icon="mdi:ruler-square" collapsed>
          <bim-checkbox label="Measure (double-click two points)"
            data-measure
            @change=${({ target }: any) => {
              setMeasureCheckboxRef(target);
              setMeasureEnabled(target.checked);
            }}></bim-checkbox>
          <div style="font-size:11px;opacity:.65;margin:6px 10px 8px;line-height:1.5">
            1) Enable Measure<br>
            2) <b>Double-click</b> point A<br>
            3) <b>Double-click</b> point B<br>
            Red = X · Green = Y · Blue = Z · Cyan = total (mm)
          </div>
          <bim-button label="Clear measurements" @click=${() => clearMeasurements()}></bim-button>
        </bim-panel-section>

        <bim-panel-section label="Scene" icon="mdi:tools" collapsed>
          <bim-button label="⛶  Fit model" @click=${() => fitAll()}></bim-button>
          <bim-button label="📷  Screenshot" @click=${() => takeScreenshot()}></bim-button>
          <bim-button label="🎯  Recenter at origin" @click=${() => recenterSceneNow()}></bim-button>
          <bim-button label="↺  Reset offsets" @click=${() => resetOffsets()}></bim-button>
          <bim-checkbox label="Show scene bounds (debug)"
            @change=${({ target }: any) => showBoundsHelpers(target.checked)}></bim-checkbox>
          ${boundsInfoEl}
        </bim-panel-section>

        <bim-panel-section label="Controls" icon="mdi:help-circle-outline" collapsed>
          <div style="font-size:11.5px;line-height:1.75;opacity:0.85;padding:0 10px 10px">
            <b>Navigation</b><br>
            Left drag – Rotate · Right drag – Pan · Scroll – Zoom<br>
            <b>Right-click</b> viewport → full context menu<br>
            <b>ViewCube</b> → click faces / edges / corners; right-click for Roll<br><br>
            <b>Authoring</b><br>
            Pick a tool → click on the model to place points<br>
            <b>AccuDraw:</b> Shift ortho · X / Z / Y axis · A angle · type distance<br>
            <b>Doors &amp; Windows:</b> click any wall to insert<br><br>
            <b>Shortcuts</b><br>
            Ctrl+S save · Ctrl+O open · Ctrl+P palette<br>
            Ctrl+Z undo · Ctrl+Y redo · F5 clash · Ctrl+Shift+C review<br>
            Ctrl+Shift+V saved views
          </div>
        </bim-panel-section>
      </bim-panel>
    `;
  });

  ctx.leftHost.appendChild(panel);

  // Collapsed-section sync — BUI does not mirror the `collapsed` property
  // to a `data-collapsed` attribute, and our CSS uses that to hide slotted
  // plain divs. Mirror it on every toggle.
  const style = document.createElement("style");
  style.textContent = `
    bim-panel-section {
      --bim-ui_bg-contrast-20: var(--bg-elevated);
    }
    bim-panel-section + bim-panel-section { margin-top: 0; }
  `;
  document.head.appendChild(style);

  const syncSections = () => {
    ctx.leftHost.querySelectorAll("bim-panel-section").forEach((sec: any) => {
      if (sec.collapsed) sec.setAttribute("data-collapsed", "");
      else sec.removeAttribute("data-collapsed");
    });
  };
  ctx.leftHost.addEventListener("click", () => setTimeout(syncSections, 0));
  syncSections();
}