import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as OBCF from "@thatopen/components-front";
import * as BUI from "@thatopen/ui";
import * as BUIC from "@thatopen/ui-obc";
import { ctx } from "./context";

BUI.Manager.init();

export async function setupViewer() {
  const appEl = document.getElementById("app") as HTMLElement;
  appEl.style.cssText = "display:flex;width:100%;height:100%;overflow:hidden;margin:0";

  const leftHost = document.createElement("div");
  leftHost.style.cssText = "min-width:320px;height:100%;overflow:auto;background:#1D1E24;border-right:1px solid #2a2a35";
  const rightHost = document.createElement("div");
  rightHost.style.cssText = "flex:1;height:100%;position:relative;overflow:hidden";
  rightHost.id = "viewport";
  appEl.append(leftHost, rightHost);

  const components = new OBC.Components();
  const worlds = components.get(OBC.Worlds);
  const world = worlds.create<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>();
  world.scene = new OBC.SimpleScene(components);
  world.renderer = new OBC.SimpleRenderer(components, rightHost);
  world.camera = new OBC.OrthoPerspectiveCamera(components);

  // 3D navigation (MMB/wheel/dbl-MMB) is owned by features/navigation.ts
  // after input-router attaches. Only disable LMB/RMB/wheel on camera-controls.
  try {
    const controls: any = world.camera.controls;
    const ACTION = controls?.constructor?.ACTION || (window as any).CameraControls?.ACTION;
    const mouseButtons = controls?.mouseButtons;
    if (mouseButtons && ACTION) {
      mouseButtons.left = ACTION.NONE ?? 0;
      mouseButtons.middle = ACTION.NONE ?? 0;
      mouseButtons.right = ACTION.NONE ?? 0;
      mouseButtons.wheel = ACTION.NONE ?? 0;
    }
  } catch (error) {
    console.warn("[navigation] mouse mapping unavailable", error);
  }

  components.init();
  world.scene.setup();
  world.scene.three.background = new THREE.Color(0x0f1117);
  world.scene.three.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 1.35);
  sun.position.set(50, 100, 40);
  world.scene.three.add(sun);
  const grids = components.get(OBC.Grids);
  const grid = grids.create(world);
  (ctx as any).grid = grid;
  (ctx as any).grids = grids;

  const groundPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(1000, 1000),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide })
  );
  groundPlane.rotation.x = -Math.PI / 2;
  groundPlane.name = "groundPlane";
  world.scene.three.add(groundPlane);

  const fragments = components.get(OBC.FragmentsManager);
  try {
    fragments.init(await OBC.FragmentsManager.getWorker());
  } catch (e) {
    console.error("[fragments] worker init failed", e);
    throw new Error(
      "Fragments worker failed to load. Often caused by COEP/CORS or a 404 HTML page. " +
      "Restart Vite after npm install. Original: " + (e instanceof Error ? e.message : String(e))
    );
  }
  world.camera.controls.addEventListener("update", () => fragments.core.update());
  world.onCameraChanged.add((camera) => {
    for (const [, model] of fragments.list) model.useCamera(camera.three);
    fragments.core.update(true);
  });
  fragments.list.onItemSet.add(async ({ value: model }) => {
    model.useCamera(world.camera.three);
    world.scene.three.add(model.object);
    await fragments.core.update(true);
  });
  fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
    if (!("isLodMaterial" in material && (material as any).isLodMaterial)) {
      material.polygonOffset = true;
      material.polygonOffsetUnits = 1;
      material.polygonOffsetFactor = Math.random();
    }
  });

  components.get(OBC.Raycasters).get(world);

  const highlighter = components.get(OBCF.Highlighter);
  highlighter.setup({
    world,
    autoHighlightOnClick: false,
    selectMaterialDefinition: { color: new THREE.Color("#bcf124"), opacity: 1, transparent: false, renderedFaces: 0 },
  });
  highlighter.styles.set("clash", { color: new THREE.Color("#ef4444"), opacity: 0.9, transparent: true, renderedFaces: 0 });
  // Selection A = blue, Selection B = yellow (clash focus)
  highlighter.styles.set("clashA", { color: new THREE.Color("#3b82f6"), opacity: 0.95, transparent: true, renderedFaces: 0 });
  highlighter.styles.set("clashB", { color: new THREE.Color("#eab308"), opacity: 0.95, transparent: true, renderedFaces: 0 });
  // Revit-style preselection: hover feedback sits below selection priority.
  // Explicit selection style so linked-model selection is always visibly blue,
  // independent of the SDK default material definition. Keep it above preselection.
  highlighter.styles.set("select", {
    color: new THREE.Color("#2563eb"),
    opacity: 0.82,
    transparent: true,
    renderedFaces: 0,
    priority: 20,
  } as any);
  highlighter.styles.set("preselect", {
    color: new THREE.Color("#38bdf8"),
    opacity: 0.42,
    transparent: true,
    renderedFaces: 0,
    priority: 10,
  } as any);

  const [propertiesTable, updatePropertiesTable] = BUIC.tables.itemsData({ components, modelIdMap: {} });
  propertiesTable.preserveStructureOnFilter = true;
  const [modelsList] = BUIC.tables.modelsList({ components, metaDataTags: ["schema"], actions: { download: true } });

  Object.assign(ctx, {
    components, world, fragments, highlighter,
    hider: components.get(OBC.Hider),
    clipper: components.get(OBC.Clipper),
    lengthMeasurer: components.get(OBCF.LengthMeasurement),
    leftHost, rightHost, groundPlane, modelsList,
  });
  ctx.clipper.enabled = true;
  ctx.props.table = propertiesTable;
  ctx.props.update = (map: any) => updatePropertiesTable({ modelIdMap: map });

  window.addEventListener("resize", () => {
    world.renderer?.resize();
    world.camera.updateAspect();
    ctx.cam.updateClipping();
  });

  return ctx;
}