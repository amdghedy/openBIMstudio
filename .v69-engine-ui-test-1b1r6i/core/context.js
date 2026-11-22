"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ctx = void 0;
/** Shared singletons. Filled once by core/setup.ts; features read from here. */
exports.ctx = {
    components: null,
    world: null,
    fragments: null,
    highlighter: null,
    hider: null,
    clipper: null,
    lengthMeasurer: null,
    leftHost: null,
    rightHost: null,
    groundPlane: null,
    modelsList: null,
    props: {
        table: null,
        update: (_map) => { },
    },
    // Filled by features/camera-tools.ts
    scene: {
        center: null,
        box: null,
        computeBounds: () => { },
        establishOffset: (_modelId) => { },
        recenter: () => { },
        resetOffsets: () => { },
        fitAll: () => { },
        fitToMap: async (_map) => { },
    },
    cam: {
        updateClipping: () => { },
        setProjection: (_m) => false,
        zoomBy: (_f) => { },
        gotoDir: (_dir) => { },
        saveHome: () => { },
        goHome: () => { },
        screenshot: () => { },
    },
    /**
     * Feature registry: ctx.features.measure.isEnabled() etc.
     *
     * @deprecated Use the typed registry in `core/services.ts`
     * (`register()` / `tryUse()` / `services.*`) for new code. This bag
     * is load-bearing — `register()` mirrors into it and ~170 files
     * still read it — so it cannot be deleted yet; it is populated only
     * as a migration mirror, never written to directly by new code.
     */
    features: {},
};
