import type * as THREE from "three";
import type * as OBC from "@thatopen/components";
import type * as OBCF from "@thatopen/components-front";

export type Projection = "perspective" | "orthographic";

/** Shared singletons. Filled once by core/setup.ts; features read from here. */
export const ctx = {
  components: null as unknown as OBC.Components,
  world: null as unknown as any,
  fragments: null as unknown as OBC.FragmentsManager,
  highlighter: null as unknown as OBCF.Highlighter,
  hider: null as unknown as OBC.Hider,
  clipper: null as unknown as OBC.Clipper,
  lengthMeasurer: null as unknown as OBCF.LengthMeasurement,
  leftHost: null as unknown as HTMLElement,
  rightHost: null as unknown as HTMLElement,
  groundPlane: null as unknown as THREE.Mesh,
  modelsList: null as any,

  props: {
    table: null as any,
    update: (_map: any) => {},
  },

  // Filled by features/camera-tools.ts
  scene: {
    center: null as unknown as THREE.Vector3,
    box: null as unknown as THREE.Box3,
    computeBounds: () => {},
    establishOffset: (_modelId: string) => {},
    recenter: () => {},
    resetOffsets: () => {},
    fitAll: () => {},
    fitToMap: async (_map: any) => {},
  },
  cam: {
    updateClipping: () => {},
    setProjection: (_m: Projection): boolean => false,
    zoomBy: (_f: number) => {},
    gotoDir: (_dir: THREE.Vector3) => {},
    saveHome: () => {},
    goHome: () => {},
    screenshot: () => {},
  },

  /** Feature registry: ctx.features.measure.isEnabled() etc. */
  features: {} as Record<string, any>,
};