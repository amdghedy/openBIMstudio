# Open BIM Studio — User Guide

Open BIM Studio is a BIM workspace that runs in your browser. Your models stay on your computer unless you choose to connect a cloud service. This guide covers the everyday workflow, from opening a model to exporting drawings. Each section says what is checked by automated browser tests and what is not.

> **How much to trust each feature.** The app is under active development. The in-app maturity catalogue rates every tool as *verified*, *limited*, *experimental*, *planned* or *unavailable*. Where this guide says "tested in a real browser", an automated test drives the feature in Chromium on every change. That does not replace trying it on your own models.

---

## 1. Getting started

**Use it online:** open the live app at open-bi-mstudio.vercel.app.

**Run it yourself** (Node.js 18 or newer):

```
git clone https://github.com/amdghedy/openBIMstudio.git
cd openBIMstudio
npm install
npm run dev
```

Open the address shown in the terminal (usually http://localhost:3000).

### Your first five minutes

1. Close the welcome screen by choosing the 3D workspace.
2. Load a model: drag an **.ifc** file onto the 3D view, or press **Ctrl+O**.
3. Orbit with **Shift + left drag** (or Shift + middle drag), pan with the middle button, zoom with the wheel. A plain left drag draws a selection box.
4. Press **F** to fit the model in view and **H** for the Home view.
5. Press **Ctrl+P** and type what you want ("section", "clash", "sheet"). The command palette finds every command.

### Finding things

| Where | What it is |
|---|---|
| **Command palette (Ctrl+P)** | Search every command by name. The fastest way to find a tool. |
| **BIM Command Center (Ctrl+Shift+R, or the blue RC button)** | A launcher for the main workflows. |
| **Ribbon and bottom toolbar** | Grouped tools: create, modify, view, drawings. |
| **File menu** | Open, save, import, export (including *Views → CAD (DWG / DXF)…*). |
| **Properties and model tree panels** | Inspect and filter what is selected or loaded. |

---

## 2. Opening, saving and projects

- **Open any supported file:** Ctrl+O, or drop the file on the 3D view. IFC 2x3 and IFC 4 are the main formats; DXF, PDF underlays and several others are supported with varying maturity (see `docs/COMPATIBILITY.md`).
- **New project:** Ctrl+N. **Save:** Ctrl+S. **Home screen:** Ctrl+H.
- Models are kept in your browser's local storage and in your project files. Nothing is uploaded unless you set up a collaboration or AI provider yourself.

---

## 3. Navigating the 3D view

| Action | How |
|---|---|
| Orbit | **Shift + left drag**, or Shift + middle drag |
| Orbit around the selection | Ctrl + middle drag |
| Pan | Middle drag |
| Zoom (towards the cursor) | Mouse wheel (Shift + wheel zooms three times faster) |
| Select | Left click |
| Window select / crossing select | Left drag left→right / right→left |
| Context menu | Right click |
| Fit all | **F** (or double-click the middle button) |
| Zoom to selection | **Ctrl+Shift+F** |
| Home view | **H** (or the ViewCube's Home menu) |
| Standard views | Click a face, edge or corner of the **ViewCube** (top right). The arrows turn the view in 90° steps. |
| Perspective / Orthographic | ViewCube Home menu, or search "Orthographic" in Ctrl+P |

**If orbiting feels slow on a large model**, turn on **View: Smooth navigation** (search it in Ctrl+P). While you orbit, pan or zoom, the view is drawn at lower resolution and becomes sharp again about a fifth of a second after you stop. It is off by default and the choice is remembered. A browser test confirms that it switches the render resolution and restores it, but I have not measured the speed-up on your model or graphics card.

### Visibility

- **Isolate selection:** Ctrl+I. **Reset isolation:** Ctrl+Shift+I.
- Hide, isolate and category visibility are in the ribbon and the model tree.

---

## 4. Walk mode (walk through the building)

Press **Ctrl+W** to enter Walk mode at the current camera position and heading. You walk at eye height (1.7 m).

| Key | Action |
|---|---|
| **W A S D** | Walk forward, left, back, right |
| **Shift** | Run (about 9 m/s; normal walking is about 3.2 m/s) |
| **Ctrl** | Crouch (slower) |
| **Space / C** | Move up / down (overrides gravity while held) |
| **Page Up / Page Down** | Jump to the next level above or below |
| **Mouse wheel** | Change walking speed |
| **Mouse** | Look around (the browser asks to capture the pointer) |
| **Esc** | Leave Walk mode and return to the orbit camera |

**Collision.** You stop at walls and stand on floors, including walls and floors from loaded IFC models. IFC doors count as solid, because the model shows them closed.

**Tested in a real browser:** holding W for 4.5 s towards a 5 m IFC wall stops at the wall face plus body radius, with no shaking and a steady speed; Esc returns the camera.

**Not tested:** mouse-look (the browser's pointer capture cannot be automated), stairs and multi-storey IFC floors, large models, and how smooth it feels on your hardware.

---

## 5. Section Box and cutting the 3D view

Use the Section Box to look inside a building. It clips the model to a box you can resize.

1. Press **Ctrl+B** (or choose **Section Box / Cut** in the toolbox, or search "Section Box" in Ctrl+P). A box appears around the model with cyan arrows on its faces.
2. Move the pointer over an arrow: it becomes a hand. **Drag an arrow** to move that face of the box. The model is cut away outside the box.
3. Use the commands **Section Box: Grow**, **Shrink** and **Reset** (Ctrl+P) to adjust the whole box.
4. Press **Ctrl+B** again to switch the Section Box off. The whole model is visible again.

**Tested in a real browser:** the box clips a loaded IFC wall; halving the box removes half of it from the picture; dragging an arrow with a real mouse moves that face and leaves the camera free afterwards; editing the box never leaves stray clipping planes behind, and switching it off removes all of them.

**Known limits:**
- Cut faces are capped with a hatched face on IFC and authored elements (toggle: "Section cut caps" in Ctrl+P). Transparent materials are not capped.
- Section planes made with the separate **Section** tool have not been covered by the same browser tests.
- Sectioning on very large models and on multi-level models has not been measured.

---

## 6. Measuring and 3D dimensions

Open the **Measure** tool (ribbon, toolbox, or Ctrl+P → "Measure"). Choose a mode:

| Mode | What you click | Result |
|---|---|---|
| Distance | Two points | The distance between them |
| XYZ | Two points | The X, Y and Z components and the total |
| Angle | Three points (the vertex is the middle point) | The angle |
| Chain | A series of points | Each segment and a running total |

- Finished dimensions **stay on screen**. Draw as many as you need.
- **Esc** cancels the dimension you are drawing, removes its first-point marker and ends the dimension command in one press. Esc never deletes finished dimensions.
- **Delete** or **Backspace** removes the most recent finished dimension; press again for the one before.
- **Clear measurements** (ribbon, or the Measure panel) deletes every dimension.

**Tested in a real browser** with real clicks: distance, XYZ, angle and chain; Esc during each; Clear. **Not tested:** snapping to model corners and edges, cancelling mid-drag.

---

## 7. Creating and editing elements

### Quick tool shortcuts

Type the two letters in sequence (not held together):

| Keys | Tool | Keys | Tool |
|---|---|---|---|
| **WA** | Wall | **DR** | Door |
| **SL** | Slab | **WN** | Window |
| **CM** | Column | **DU** | Duct |
| **BM** | Beam | **PP** | Pipe |
| **BR** | Brace | **GR** | Grid |
| **TR** | Truss | **LV** | Level |
| **FT** | Footing | | |

Press **Esc** to cancel the active tool, and **Delete** to delete the selection.

### Precision

- **Shift+S** toggles snapping.
- **Tab** and **X / Y / Z** use AccuDraw axis locking while you have a base point.
- **G / R / S** switch the transform gizmo to Move, Rotate and Scale. **Q** returns to selection.

### Editing with grips

Select an element to see its **orange grip points**. Move the pointer over a grip: it changes to a hand. Drag it to reshape the element (a wall end, a slab corner, an edge). Snapping applies while you drag.

**Tested in a real browser:** hover cursor and dragging on a slab grip. **Not tested:** every element type, mid-edge grips and openings.

### Parametric families and the family sketch

Open the **Family Sketch** window to draw a profile and turn it into a family:

- Draw a **rectangle**, **circle** or **polygon**.
- Use **Next: draw hole** to cut holes in the profile.
- Tick **Size as parameters** to make a rectangle's width and length (or a circle's radius) editable parameters.
- Apply to create the family. It then appears in the Family Browser.

Details are in `docs/FAMILY-SKETCH.md`. **Not tested:** placing a sketched family in the 3D model and editing its parameters afterwards.

---

## 8. Coordination and quality

- **Federation:** load several models and align them in the Federation workspace.
- **Clash detection:** **F5** runs a clash test; **Ctrl+Shift+C** toggles the Clash Review window. Clash results can be grouped and tracked.
- **Issues and BCF:** create issues from a view and import or export BCF files.
- **IDS and validation:** check models against IDS information requirements and the built-in validation rules; use Model Health for diagnostics.

These workflows are covered by unit tests but have not been exercised by the browser tests described in this guide.

---

## 9. Documentation: views, sheets and PDF

- Create plans, sections, elevations and reflected ceiling plans.
- Add dimensions, tags, keynotes and auto-dimension chains.
- Arrange views on **sheets** with title blocks and revisions, then **export PDF**.
- View templates and view filters apply graphic standards consistently.

---

## 10. Exporting the 3D model and views to CAD

Choose **File → Views → CAD (DWG / DXF)…** (the same idea as Revit's Export → CAD Formats).

- **2D views to CAD:** select one or more views, choose DXF or DWG, and export. Several views are delivered together as a zip.
- **3D model to DXF:** the Export dialog can also write the authored 3D model, and loaded IFC models, as a 3D DXF.
- Axes: the app's up axis is Y; CAD output uses Z up.

**Verified:** DXF files are generated and downloaded in a real browser, an IFC wall exports on the expected layer with about 5 m × 3 m extents, and the DWG writer round-trips in the CAD engine in an automated test.

**Not verified:** opening the exported files in AutoCAD, BricsCAD or Revit; exporting very large IFC models; 3D export to DWG (3D is DXF only).

---

## 11. Quick reference

| Shortcut | Action |
|---|---|
| Ctrl+P | Command palette |
| Ctrl+Shift+R | BIM Command Center |
| Ctrl+O / Ctrl+S / Ctrl+N / Ctrl+H | Open / Save / New / Home screen |
| Ctrl+Z, Ctrl+Y (or Ctrl+Shift+Z) | Undo, Redo |
| Ctrl+A | Select all |
| Delete | Delete selection |
| Esc | Cancel the active tool or clear selection |
| F / H | Fit view / Home view |
| Ctrl+Shift+F | Zoom to selection |
| Ctrl+I / Ctrl+Shift+I | Isolate / Reset isolation |
| Ctrl+B | Section Box on/off |
| Ctrl+W | Walk mode on/off |
| F5 | Run clash test |
| Shift+S | Snapping on/off |
| G / R / S / Q | Move / Rotate / Scale gizmo / Selection |

---

## 12. Troubleshooting

| Problem | What to try |
|---|---|
| Orbiting is slow or choppy | Turn on **View: Smooth navigation**. Hide categories you do not need. Close other heavy browser tabs. |
| Part of the model is missing after using the Section Box | Press **Ctrl+B** to switch it off, or use **Reset** from Ctrl+P. |
| The 3D view will not orbit | Press **Esc**. If a tool or Walk mode is active, Esc leaves it. |
| Walk mode starts looking the wrong way | Leave it with Esc, set the view you want, and press Ctrl+W again. Wait a couple of seconds after loading a model, because the view animates to fit it. |
| A shortcut does nothing | Click the 3D view first so it has keyboard focus. While a drawing tab is active, the drawing editor owns some shortcuts. |
| A file will not open | Check `docs/COMPATIBILITY.md`. Some formats (for example LAZ, E57 and RCP point clouds) cannot be read in a browser; convert them first. |

---

## 13. Where to get more detail

- `docs/` has a document for each area (navigation, families, export, drawings, plugins and more).
- `CHANGELOG.md` lists what changed and what was verified.
- Report problems and ideas at github.com/amdghedy/openBIMstudio/issues.
