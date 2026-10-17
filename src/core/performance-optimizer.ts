type Any = Record<string, any>;

let installed = false;
let enabled = true;

function getScene(): Any | null {
  const c = (globalThis as Any).__OBS_CTX__ || null;
  const ctxAny = c as Any;

  const world = ctxAny?.world as Any;

  return world?.scene?.three ?? world?.scene ?? null;
}

function applyCulling(next: boolean): void {
  const scene = getScene();

  if (!scene || typeof scene.traverse !== "function") {
    return;
  }

  scene.traverse((obj: Any) => {
    if (obj?.isMesh) {
      obj.frustumCulled = next;
    }
  });
}

export function setPerformanceCullingEnabled(next: boolean): boolean {
  enabled = !!next;
  applyCulling(enabled);
  return enabled;
}

export function isPerformanceCullingEnabled(): boolean {
  return enabled;
}

export function setupPerformanceOptimizer(): void {
  if (installed) {
    return;
  }

  installed = true;

  applyCulling(enabled);

  const w = window as Any;

  w.__obsPerfOptimizer = {
    setEnabled: setPerformanceCullingEnabled,
    isEnabled: isPerformanceCullingEnabled,
  };

  console.log("[performance-optimizer] Revit-safe frustum culling ready");
}